/**
 * dsh-capability-composer — 能力组合器（host 端）
 *
 * 解决的问题：DSH 会把「所有已装插件注册的工具 schema」+「所有技能的目录」
 * 全量常驻进每一次请求，实测约 76K tokens 打底。本插件把这两样按「组合」
 * 编组，只让当前组合进上下文。
 *
 * 两条独立的生效路径：
 *   ① 技能——注册一个 skill provider，把**不在当前组合里**的技能以同名 + 最低
 *      优先级 + modelInvocable:false 重新登记，从而被遮蔽出目录（dsh-tool-skill
 *      渲染目录前会 filter(isModelInvocable)）。技能本体不删，/技能名 仍可手动调。
 *   ② 插件——把当前组合翻译成 profile 补丁层的 `disabled: true` 行，写在带标记的
 *      托管区块里，只替换区块内容，不碰文件其余部分（注释与既有条目原样保留）。
 *   ③ 工具（路线二）——只让「核心工具 + 2 个元工具」常驻，其余工具的 schema 靠
 *      `search_tools` / `load_tools` 按需放回。这是省 token 的大头。
 *
 * 本插件是 `link:` 挂载的（实体在工作区，不在 harness 里），所以**绝对不要
 *   import `@deepseek-ai/*`**：解析链从插件目录向上走，永远走不到 DSH 安装目录的
 *   node_modules，必 ERR_MODULE_NOT_FOUND。`@deepseek-ai/dsh-tools` 的 `defineTool`
 *   只在 generation 装的插件里能用。所以两个元工具用手写 raw definition 注册
 *   （形状 = defineTool 编译出来的结果，已由 tests/composer_tool_diet_test.mjs
 *   与真 defineTool 逐字节对拍）。
 *
 * @module dsh-capability-composer
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'dsh-capability-composer'

/**
 * 必需服务：技能注册表。
 * 工具走**可选路径**（`ctx.get('tools')`），故意不写进 inject —— 否则 tools 服务
 * 缺失时整棵插件都加载不了，技能与插件两个组合跟着一起陪葬。
 */
export const inject = ['skills']

const STATE_VERSION = 3
/** 托管区块标记：只替换这两行之间的内容。 */
const MARK_BEGIN = '# >>> dsh-capability-composer:managed（本区块由插件维护，手工改动会被覆盖） >>>'
const MARK_END = '# <<< dsh-capability-composer:managed <<<'

/**
 * 解析 DSH 主目录 —— **自适应，不硬编码盘符 / 用户名 / 平台**。
 *
 * 解析分三层：
 *   ① `DSH_HOME`（DSH 自己会导出，最权威）
 *   ② 各平台的**约定位置**（换机器、换用户名、换盘符都不用改这里）
 *   ③ 都没有 ⇒ 抛错。**绝不猜一个写死的路径然后静默写进去。**
 *
 * 为什么要平台分支：原来只有 `homedir()/AppData/Roaming/...` 一条，
 * 在 macOS / Linux 上会算出一个**不存在**的目录，然后插件会往那里建状态文件 ——
 * 表现成"组合配置神秘丢失"。换电脑时这条也会直接错。
 * @returns {string} DSH 主目录的绝对路径。
 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = homedir()
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return join(roaming, 'dsh-desktop', 'harness')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness')
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, '.config')
  return join(config, 'dsh-desktop', 'harness')
}


function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/**
 * 写 JSON。**覆盖前先把上一版留一份 `.bak`**。
 *
 * 为什么：一次误 POST 把组合全清成空，而磁盘上一点旧版本都没留下
 * （只能靠脚本里的定义重建）。组合状态是纯用户数据，没有版本库，一份 .bak 就是
 * 唯一的后悔药。写坏了也无所谓 —— 备份失败绝不阻断正常写入。
 */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  try {
    if (existsSync(path)) copyFileSync(path, path + '.bak')
  } catch { /* 备份失败不影响写入 */ }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 预置组合。**只在状态文件不存在时**写入一次，之后可自由增删改。
 *
 * 技能组合用「白名单」：列出的才进目录；列表为空表示「不过滤」（全量）。
 * 插件组合用「白名单」：列出的才进目录；列表为空表示「不过滤」（全部）。
 *
 * **只保留一个「全量」档位**（用户口径：全新安装里除了全量，别的组合一个都不许有）。
 * 曾经这里预置过「量化 / 办公 / 最小」三档，并且往「量化」里塞了 10 个 `vnpy-*` /
 * `futures-knowledge` ——出过两个实打实的问题：
 *   ① 那些技能这台机器**还没有**，于是每次重开面板都弹「名单里有 10 项已不存在」；
 *      用户清一次、下次又冒出来（清的是状态文件，预置是另一份，状态文件一重建就照抄回来）；
 *   ② 本质是「替别人猜」：预置哪些技能属于哪个场景，只在作者本机成立。
 * 所以现在一档都不猜：全新安装只有「全量 = 不过滤」，其余的由用户在 UI 里自己建。
 */
const PRESET_SKILL_COMPOSITIONS = {
  全量: [], // 空 = 不过滤，全部技能都进目录
}

/** 这些插件不纳入管理（MCP 面板、组合器自身、以及被显式排除的）。 */
const PLUGIN_EXCLUDE = new Set([
  'dsh-capability-composer',
  'dsh-mcp-panel',
  'dsh-mcp-connector',
  'dsh-mcp-manager-ui',
  'dshmarket',
  'dsh-client-ui-settings-plugins',
])

/**
 * 插件那一轴的预置组合 —— **以插件为单位**。
 *
 * 语义：底层永远是路线二 —— 任何插件的工具 schema 都**不常驻**，
 * 目录里每个插件只占「名字 + 描述 + 什么时候该启用它的关键词」一行，跟技能目录同构。
 * 「组合」管的是**这个作用域里哪些插件连名字都进不了目录**。
 *
 * `plugins` 是**插件条目 id** 列表（不是包名、也不是工具 glob）：
 *   · 空数组 = 不过滤（本作用域内全部插件都进目录）
 *   · 非空   = 只有列出的插件进目录；其余插件照常运行、界面照常显示，
 *              只是模型连它的名字都看不到
 *
 * 预置**只有「全量」一档、且给空数组**：不猜哪些插件属于谁—— vnpy 是 MCP，而按既定
 * 约定 MCP 不归本插件管，所以压根没有"量化插件"可预置。要分档在 UI 里自己建。
 */
const PRESET_PLUGIN_COMPOSITIONS = {
  全量: [],
}

function defaultState() {
  const skill = {}
  for (const [key, list] of Object.entries(PRESET_SKILL_COMPOSITIONS)) skill[key] = { skills: [...list] }
  const plugin = {}
  for (const [key, list] of Object.entries(PRESET_PLUGIN_COMPOSITIONS)) plugin[key] = { plugins: [...list] }
  return {
    version: STATE_VERSION,
    // 固定方式：key 为**工作区路径**（agent.session.header.cwd），'*' 表示全局默认。
    // 两个轴都固定到「全量」= 不过滤（路线二仍然把全部工具压出常驻，只是不做白名单裁剪）。
    // 因为全新安装里就只有这一个档位，指着它才不会悬空。
    pinned: { skill: { '*': '全量' }, plugin: { '*': '全量' } },
    // 会话级覆盖（优先级最高）：sessionId -> 组合名。
    session: { skill: {}, plugin: {} },
    compositions: { skill, plugin },
  }
}

/**
 * 旧版迁移：最早那版的 `plugin[name].disabled` 是「要关掉的包名」，后来改成
 * 「可搜的 tool glob」。语义不同，不能直接搬；置空数组 = 不过滤，与 v1 默认
 * （全量，不关任何插件）行为一致，最安全。
 */
function migrateState(raw) {
  if (raw === null || typeof raw !== 'object') return null
  if (raw.version === STATE_VERSION) return raw
  const skill = {}
  for (const [key, entry] of Object.entries(raw.compositions?.skill ?? {})) {
    skill[key] = { skills: Array.isArray(entry?.skills) ? [...entry.skills] : [] }
  }
  // 更早的 plugin 轴是**工具 glob** 列表，现在是**插件 id** 列表。语义不同不能搬，
  // 一律置空（= 不过滤）—— 与「全量」的既有效果一致，最安全，之后自己勾。
  const plugin = {}
  for (const key of Object.keys(raw.compositions?.plugin ?? {})) plugin[key] = { plugins: [] }
  return {
    version: STATE_VERSION,
    pinned: {
      skill: { ...(raw.pinned?.skill ?? {}) },
      plugin: { ...(raw.pinned?.plugin ?? {}) },
    },
    session: {
      skill: { ...(raw.session?.skill ?? {}) },
      plugin: { ...(raw.session?.plugin ?? {}) },
    },
    compositions: { skill, plugin },
  }
}

//
// 作用域解析：会话级 > 工作区级 > 全局默认
//

/** 取一个 agent 的两个作用域键。 */
function scopeKeysOf(agent) {
  const sessionId = agent?.session?.id
  const cwd = agent?.session?.header?.cwd
  return {
    sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null,
    cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null,
  }
}

/**
 * 把某一级的 pin 值规范化成**组合名列表**（支持多选）。
 *
 * 兼容三种写法：
 *   · 旧版单个字符串 `"开发·日常"` → `['开发·日常']`；
 *   · 新版数组 `["开发·日常","语言·Python"]`；
 *   · 其它（null / 空串 / 空数组）→ `null`（= 这一级没指定，继续往上继承）。
 */
function pinToList(value) {
  if (typeof value === 'string' && value !== '') return [value]
  if (Array.isArray(value)) {
    const list = value.filter((n) => typeof n === 'string' && n !== '')
    return list.length > 0 ? list : null
  }
  return null
}

/**
 * 三级解析出当前生效的组合名**列表**（同级可多选，取并集）。
 *
 * @param state - 组合器状态。
 * @param facet - `'skill'` 或 `'plugin'`。
 * @param agent - 当前 agent；为 null 时只看全局默认。
 * @returns 组合名数组，或 null（= 该轴不过滤 = 全部）。
 */
function resolveCompositionNames(state, facet, agent) {
  const pinned = state?.pinned?.[facet] ?? {}
  const sessionMap = state?.session?.[facet] ?? {}
  const keys = scopeKeysOf(agent)
  if (keys.sessionId !== null) {
    const v = pinToList(sessionMap[keys.sessionId])
    if (v !== null) return v
  }
  if (keys.cwd !== null) {
    const v = pinToList(pinned[keys.cwd])
    if (v !== null) return v
  }
  return pinToList(pinned['*'])
}

/**
 * 三级解析出当前生效的组合名（多选时用 ` + ` 拼；日志用）。
 *
 * @param state - 组合器状态。
 * @param facet - `'skill'` 或 `'plugin'`（两轴可以各自选不同组合）。
 * @param agent - 当前 agent；为 null 时只看全局默认。
 * @returns 组合名，或 null（= 该轴不过滤）。
 */
function resolveCompositionName(state, facet, agent) {
  const names = resolveCompositionNames(state, facet, agent)
  return names === null ? null : names.join(' + ')
}

/**
 * 技能轴的「有效签名」——只覆盖**当前真正可能被解析到**的那些组合，而不是整份 state。
 *
 * 旧写法是 `JSON.stringify([pinned.skill, session.skill, compositions.skill])`，
 *   把 `compositions.skill` 的**全部**条目都算进来 ⇒ "在 UI 里改/删一个谁都没在用的组合"
 *   也会敲黑板让技能目录缓存失效 ⇒ 上游重发一份全量目录（≈6.6k 字符，排在系统提示
 *   之后的第 2 位）⇒ 整段对话的缓存从那里起全部作废。
 *   实测（全天日志）：`缓存已失效（组合改动）` **279 次**、`组合已重载` 1,315 次。
 *
 * 新签名只取「pinned 里出现的每个作用域」+「session 里出现的每个会话」**解析出来**的
 * 组合名与成员名单。任何能影响在跑 agent 的改动都会让签名变化：
 *   · 改成员 → 命中那份名单变 → 变；
 *   · 改 pin / 新增会话级 pin / 新增作用域 pin → 被遍历到 → 变；
 *   · 删掉在用的组合 → 解析结果变 → 变。
 * 反过来，"改/删没人用的组合"不再敲黑板 —— 这正是它该有的语义。
 */
function skillCompositionSignature(state) {
  try {
    const expand = (names) => {
      if (names === null || names === undefined) return null
      return names.map((name) => {
        const entry = state?.compositions?.skill?.[name]
        return [name, Array.isArray(entry?.skills) ? [...entry.skills] : []]
      })
    }
    const out = []
    for (const cwd of Object.keys(state?.pinned?.skill ?? {})) {
      out.push(['cwd', cwd, expand(resolveCompositionNames(state, 'skill', { session: { header: { cwd } } }))])
    }
    for (const id of Object.keys(state?.session?.skill ?? {})) {
      out.push(['session', id, expand(resolveCompositionNames(state, 'skill', { session: { id } }))])
    }
    return JSON.stringify(out)
  } catch {
    return ''
  }
}

/**
 * 工具 glob 匹配：唯一通配符是 `*`（只允许出现一次），
 * 没有它即精确相等。`mcp__vnpy__*`、`sql_*`、`read` 都支持。
 */
function toolGlobMatch(glob, name) {
  if (typeof glob !== 'string' || glob.length === 0) return false
  const star = glob.indexOf('*')
  if (star < 0) return glob === name
  const prefix = glob.slice(0, star)
  const suffix = glob.slice(star + 1)
  return name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)
}

/** 工具名是否落在某个组合的 glob 白名单里。 */
function toolInScope(globs, name) {
  if (globs === null) return true // null = 不过滤
  for (const glob of globs) if (toolGlobMatch(glob, name)) return true
  return false
}

//
// ③ 工具按需加载（路线二）的常量
//

/**
 * 常驻核心工具白名单。不在这个集合里的工具，其完整 schema 默认不进上下文，
 * 需要时由模型自己 `search_tools` → `load_tools` 放回。
 *
 * 选取口径：没有它就没法正常干活的那几类（读写文件、跑命令、问人、待办、交付、
 * 技能、委派、后台任务、目标、联网与看图、质量检查）+ 两个元工具。
 * 想加减：改这个数组即可（改完需重挂插件，本插件不写运行期配置）。
 */
/**
 * 本表从"写死的名单"改为**可自长的集合**。
 *
 * 下面是**静态兜底**（DSH 官方工具名，跨机器一致）。运行时还有一路**自动发现**：
 * 见 `discoverCoreTools()` —— 被 ≥2 个插件包同时提到的工具名会被并入本 Set。
 *
 * 为什么要自长：DSH 升级可能新增/改名官方工具，写死的名单不会跟着变 ⇒
 *   漏掉的工具就不在"常驻白名单"里 ⇒ 被 deny ⇒ **模型再也看不见它**。
 * 为什么保留静态兜底：自动发现依赖"多个插件都提到它"这个信号；万一名单页变了、
 *   或某个工具只有 1 个插件提到，兜底名单能保证它仍然常驻。
 * 为什么把发现结果**写回这个 Set**：下游有 15 处直接读 `TOOL_CORE`，让它自长
 *   就一行都不用改（改动面最小、回归风险最低）。
 */
const TOOL_CORE = new Set([
  // 文件与检索
  'read', 'write', 'edit', 'glob', 'grep',
  // 执行
  'pwsh',
  // 交互与交付
  'ask_user_question', 'present', 'todo_write', 'skill', 'exit_plan_mode',
  // 委派
  'subagent', 'subagent_fork', 'send_message', 'list_agents', 'interrupt_agent',
  // 后台任务
  'job_output', 'job_list', 'job_kill',
  // 目标
  'create_goal', 'get_goal', 'update_goal',
  // 联网与图片
  'web_search', 'web_fetch', 'read_image',
  // 质量检查
  'lint_diagnostics', 'lint_workspace_errors', 'lint_fix',
])

/** 元工具：本插件自己注册，永远常驻。 */
/**
 * 两个元工具 —— **以插件为单位**。
 *
 * 旧的 `search_tools` / `load_tools`（工具名粒度）已删除：单位太细，417/211 个工具名
 * 压没了以后模型根本不知道该搜什么。现在粒度是**插件**，跟技能目录同构。
 */
const TOOL_META = new Set(['search_plugins', 'load_plugin', 'invoke_tool'])

/**
 * 「全不选」的哨兵成员（客户端 `lib/client.js` 里的 `NONE` 常量，必须一致）。
 *
 * 状态文件里 `plugins: []` 的语义是**不过滤（全部）**，所以"一个都不要"没法用空数组表达。
 * 约定：名单里**只有**这一项 ⇒ 明确的空集合。
 *   · 技能轴：`skillAllowSetFor` 得到 `{__none__}`，没有技能叫这个名字 ⇒ 全部被遮蔽（现成逻辑）。
 *   · 插件轴：`pluginsOf` 过滤后为空 ⇒ 目录为空 + `load_plugin` 一律判 blocked。
 */
const NONE_MEMBER = '__none__'

/** 永不匹配任何工具名的 glob —— 表达"一个插件都不要"。 */
const NEVER_GLOB = '\u0000composer-none'

/** 保留名：PTC 模式的呈现通道，restrict 点名它会直接抛错。 */
const TOOL_RESERVED = new Set(['run_code'])

/* 「缓存安全模式」开关（默认关，DSH_COMPOSER_CACHE_SAFE=1 打开）
 *
 * 要解决的问题：本插件把 `state.loaded` 放进 allow 集合 ⇒ 模型每 `load_plugin`
 * 一次，发给 provider 的 `tools` 数组就变一次 ⇒ tools 段位于缓存前缀最前面
 * ⇒ 从 tools 起（含后面全部 messages）前缀缓存失效。
 * 实测（探针统计 118 个会话）：load_plugin 之后第一步未命中平均 326,939 tok，
 * 是全体平均（7,701）的 42.46 倍；另实测到单次 140,054 / 87,000。
 *
 * 打开后的行为变化（**只改"工具怎么给模型"，不改"工具能不能用"**）：
 *   ① `allow` 不再包含 `state.loaded` ⇒ 发给模型的 tools 数组**恒定在核心+元工具**，
 *      整个会话一个字节不变 ⇒ 前缀永不因工具集而失效。
 *   ② `load_plugin` 的返回值（tool_result，属于 messages 尾部的一次性内容）
 *      附上被加载工具的**名字 + 说明 + 参数 schema** ⇒ 模型照样知道怎么调用。
 *   ③ 工具仍然注册在宿主注册表里 ⇒ 模型输出 tool_call 时**照常执行**。
 *
 * 这就是 Anthropic Tool Search 的思路（把发现的工具作为内容追加进对话历史，
 * 而不是改 tools 数组），只是不依赖服务端支持 —— 因为那就是一条普通消息。
 *
 * 必须验证：模型看到 tool_result 里的 schema，是否真的会正确调用。
 *    若不会，删掉这个环境变量即可完全回到旧行为。
 *
 * **默认改为开**（原来 `=== '1'` 是"不设就关"）。
 * 理由：它解决的是"`load_plugin` 后工具面变化 ⇒ 前缀缓存全废"（实测单步未命中 32.7 万 tok）。
 * 那是**破前缀**问题 ⇒ 按"破前缀的功能默认必须关，**治**破前缀的功能默认必须开"的原则，
 * 这一项应当默认生效。**新装机器不设任何变量也能受益。**
 * 想回到旧行为：`DSH_COMPOSER_CACHE_SAFE=0`。
 */
const CACHE_SAFE = process.env.DSH_COMPOSER_CACHE_SAFE !== '0'

/**
 * 打开 CACHE_SAFE 时，`allow` 里允许放行哪些"已加载"工具 —— 返回空数组即"不放行任何已加载工具"。
 * 单独抽成函数，是为了两处（组装期 maskAssemblyTools 与 restrict 期 applyToolRestriction）
 * 用同一个判据，避免一处改了一处忘了（那类 silent bug 的教训）。
 */
function loadableResidentNames(state) {
  if (CACHE_SAFE) return []
  return [...state.loaded]
}

/* 「完整中转」模式（**默认关**，DSH_COMPOSER_MIDDLEWARE_FULL=1 打开）
 *
 * 要解决的问题
 * 上一版（CACHE_SAFE）里，`invoke_tool` 为了绕过 agent 级 `restrict()`，
 * **故意不传 `agent`** 去执行工具 —— 走 global view，所以工具能跑。
 * 但代价是：**工具执行时拿不到 agent 上下文**。
 *
 * 而有一类工具**就靠 agent 上下文干活**：
 *   · `todo_write` / `create_goal` / `update_goal`（要写 session 状态）
 *   · `ask_user_question`（要往当前会话里插问题）
 *   · `subagent` / `workflow`（要建子 agent / 编排）
 *   · `skill`（要按 agent 作用域解析技能）
 *   · 任何"按 agent 作用域注册"的插件工具
 * ⇒ 这些走中转确实会出问题（这正是"看起来必须常驻"的那批）。
 *
 * 解法：把「可执行性」和「可见性」彻底拆开
 * `dsh-tools` 里这两件事本来是**同一个开关**（`restrict()` 既管 view 又管执行），
 * 但本插件其实有**两层**可用的机制：
 *   · `applyToolRestriction()` → `ctx.tools.restrict({ allow })`  ⇒ 管「**能不能执行**」
 *   · `maskAssemblyTools()`（组装期钩子）                        ⇒ 管「**发给模型的 tools 列表**」
 * ⇒ 于是可以：**restrict 全量放行（执行不拦）+ mask 照旧裁到 31（前缀稳）**，
 *   同时让 `invoke_tool` **带上 agent**（上下文完整）。
 *
 * 为什么"零风险"
 * · 默认关 ⇒ 不打开时行为与现在**完全一致**（invoke_tool 仍不传 agent、restrict 仍只放行 31）。
 * · 打开后若异常 ⇒ 删掉环境变量即完全回到旧行为。
 * · 成对验证：日志里 `工具按需加载已施加` 必须仍显示只保留 31 个（工具面没变大），
 *   同时 `invoke_tool` 能调到 MCP / 依赖 agent 的工具（执行能力完整）。
 *
 * **默认改为开**（原来 `=== '1'` 是"不设就关"）。
 * 它让"工具面保持小（省上下文 + 保前缀）"和"执行能力完整"同时成立 ——
 * 是**治**破前缀的一环 ⇒ 新装机器应当默认受益。想回到旧行为：`=0`。
 */
const MIDDLEWARE_FULL = process.env.DSH_COMPOSER_MIDDLEWARE_FULL !== '0'

/* 抄自 dsh-progressive-tools 的 `autoloadMaxTools`
 *
 * 逻辑：**如果"会被裁掉的工具"本来就不多 ⇒ 干脆全部常驻**，省掉整个转发层
 * （模型直接原生调用，零转发开销、无中间层）。
 *
 * 上游原话（`src/index.ts` L400-405）：
 *   if (config.autoloadMaxTools > 0) {
 *     const deferred = schemas.filter(s => s.name !== 'run_code' && !names.has(s.name))
 *     if (deferred.length > 0 && deferred.length <= config.autoloadMaxTools) {
 *       for (const s of deferred) names.add(s.name)
 *     }
 *   }
 *
 * **默认 0 = 关闭**（与上游默认一致）。
 * 建议值：**60~120** —— 低于这个量级时，常驻那点 token 远小于"每次中转"的开销。 */
const AUTOLOAD_MAX = Math.max(0, Math.floor(Number(process.env.DSH_COMPOSER_AUTOLOAD_MAX ?? 0) || 0))

/* 抄自 dsh-progressive-tools 的 catalog.ts
 * 两段式工具发现：`search_tools`（词法搜索，只回 名字+一行描述）
 *              + `describe_tools`（只对选中的名字回完整 schema）。
 *
 * 为什么需要：本插件现在把「全部工具名」塞在 system prompt 的目录段里（约 16k tok 常驻）。
 * 上游用**按需搜索**取代**静态目录** ⇒ 那一大段可以省掉。
 *
 * 照抄的要点：
 *   · 名字归一化：camelCase / 下划线 / 连字符 → 空格分隔词
 *   · **中文用字符二元组（bigram）** —— 中文没有空格分词，整串 token 永远匹配不上
 *   · 搜索文本 = 名字 + 描述 + 参数键 + schema 全文
 *   · BM25（k1=1.2, b=0.75）+ 精确名重奖（+160）、名字包含（+48）、全文包含（+20）
 *   · 形如 `family_member` / `plugin.tool` 的查询视为**精确名查找**，没命中就返回空
 *     （否则会倒出一堆不相关 schema、把后续轮次撑大）
 *   · 低于 top×0.15 且没有任何 name-token 命中的候选丢掉
 *
 * 开关：**默认开**（原来默认关）。它给模型"搜工具"的能力 ——
 *       配合 CACHE_SAFE / MIDDLEWARE_FULL（工具面小 + 执行能力全）构成完整闭环。
 *       想回到旧行为：`DSH_COMPOSER_TOOL_SEARCH=0`。 */
const TOOL_SEARCH_ENABLED = process.env.DSH_COMPOSER_TOOL_SEARCH !== '0'
const TOOL_SEARCH_DEFAULT_LIMIT = 10
const TOOL_SEARCH_MAX_LIMIT = 50

const WORD_PATTERN = /[\p{L}\p{N}]+/gu
const CJK_RUN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const IDENTIFIER_QUERY = /^[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)+$/

/** camelCase / 下划线 / 连字符 → 空格分隔词，小写。 */
function normName(value) {
  try {
    return String(value ?? '')
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replaceAll('_', ' ')
      .replaceAll('-', ' ')
      .toLocaleLowerCase('en-US')
      .match(WORD_PATTERN)
      ?.join(' ') ?? ''
  } catch {
    return ''
  }
}

/** 分词；CJK 段额外产字符二元组（中文没有空格分词，整串永远匹配不上）。 */
function nameTokens(value) {
  const normalized = normName(value)
  if (normalized === '') return []
  const out = []
  for (const token of normalized.split(' ')) {
    out.push(token)
    for (const run of token.match(CJK_RUN_PATTERN) ?? []) {
      for (let index = 0; index + 1 < run.length; index += 1) {
        const bigram = run.slice(index, index + 2)
        if (bigram !== token) out.push(bigram)
      }
    }
  }
  return out
}

/** 递归收集参数键与字符串值（参数名/枚举值都参与检索）。 */
function paramKeysOf(value, out = []) {
  if (value === null || value === undefined) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) paramKeysOf(item, out)
    return out
  }
  for (const [key, child] of Object.entries(value)) {
    out.push(key)
    paramKeysOf(child, out)
  }
  return out
}

/** 一份 schema 的可检索文本 = 名字 + 描述 + 参数键 + schema 全文。 */
function searchTextOf(schema) {
  let params = ''
  try {
    params = JSON.stringify(schema?.parameters ?? {})
  } catch {
    params = ''
  }
  const name = String(schema?.name ?? '')
  const description = String(schema?.description ?? '')
  const keys = paramKeysOf(schema?.parameters ?? {}).join(' ')
  return normName(`${name} ${description} ${keys} ${params}`)
}

/** 按查询给工具打分排序，返回 [{ name, description, score }]。 */
function rankToolsByQuery(schemas, query, limit) {
  const normalizedQuery = normName(query)
  const queryTokens = [...new Set(nameTokens(query))]
  if (normalizedQuery === '' || queryTokens.length === 0) return []

  /* 精确名查询（family_member / plugin.tool）没命中 ⇒ 直接返回空，
     不要把一堆不相关 schema 倒出来（上游原注释："otherwise fill maxResults
     and inflate later turns"）。 */
  if (IDENTIFIER_QUERY.test(String(query ?? '').trim())) {
    const hit = schemas.some((s) => {
      const n = normName(s?.name)
      return n === normalizedQuery || n.includes(normalizedQuery)
    })
    if (!hit) return []
  }

  const docs = schemas.map((schema) => {
    const text = searchTextOf(schema)
    return { schema, text, tokens: nameTokens(text) }
  })
  const averageLength = docs.length === 0
    ? 1
    : docs.reduce((total, doc) => total + doc.tokens.length, 0) / docs.length
  const K1 = 1.2
  const B = 0.75
  const docFrequency = new Map()
  for (const term of queryTokens) {
    docFrequency.set(term, docs.filter((doc) => doc.tokens.includes(term)).length)
  }

  const ranked = docs.map((doc) => {
    let score = 0
    const normalizedName = normName(doc.schema?.name)
    if (normalizedName === normalizedQuery) score += 160
    else if (normalizedName.includes(normalizedQuery)) score += 48
    if (doc.text.includes(normalizedQuery)) score += 20
    for (const term of queryTokens) {
      const tf = doc.tokens.reduce((count, token) => count + (token === term ? 1 : 0), 0)
      if (tf === 0) continue
      const df = docFrequency.get(term) ?? 0
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
      const denominator = tf + K1 * (1 - B + B * doc.tokens.length / averageLength)
      score += idf * (tf * (K1 + 1)) / denominator * 10
      if (nameTokens(doc.schema?.name).includes(term)) score += 18
    }
    return { schema: doc.schema, score }
  }).filter((candidate) => candidate.score > 0)

  ranked.sort((a, b) => b.score - a.score || String(a.schema?.name).localeCompare(String(b.schema?.name)))
  const top = ranked[0]
  const floor = top === undefined ? 0 : top.score * 0.15
  const kept = ranked.filter((candidate, index) => index === 0
    || candidate.score >= floor
    || nameTokens(candidate.schema?.name).some((token) => queryTokens.includes(token)))
  return kept.slice(0, limit)
}

/** 一行描述（给 search 用；不返回完整 schema，那是 describe 的事）。 */
function briefDescriptionOf(schema) {
  const raw = String(schema?.description ?? '')
  const firstLine = raw.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine
}

const TOOL_HINT_MAX = 110
const TOOL_SEARCH_DEFAULT = 20
const TOOL_SEARCH_MAX = 100

/** 每 agent 一份工具加载状态（key 是 agent 对象本身）。 */
const toolStates = new WeakMap()
/* 诊断：给每个 agent 对象编个稳定序号（WeakMap ⇒ 不泄漏）。
   只用于日志，不参与任何逻辑。见 maskAssemblyTools 里的 DSH_COMPOSER_DIAG 分支。
   为什么需要它：`state.assemblyNote !== 'clean'` 那条日志每个 agent 只打一次 ⇒
   光看工具数序列无法区分「同一 agent 状态被清零」与「多个 agent 交替」。 */
const agentIds = new WeakMap()
let agentIdSeq = 0
function agentIdOf(agent) {
  if (agent === null || typeof agent !== 'object') return 'null'
  let id = agentIds.get(agent)
  if (id === undefined) { agentIdSeq += 1; id = agentIdSeq; agentIds.set(agent, id) }
  return id
}
/** exec 没有 agent 时的兜底状态容器。 */
const TOOL_FALLBACK = {}

/** 常驻工具数（不含按需加载进来的）。 */
function toolResidentBase() {
  return TOOL_CORE.size + TOOL_META.size
}

/**
 * 常驻预算（工具定义的 token 上限）。
 *
 * 为什么要有它（设计目标：「以后工具一定不断增加，要保证很久很久才涨 1k」）：
 * 组合能管住"开场带什么"，但管不住**模型一路 `load_plugin` 把工具越堆越多** ——
 * 每加载一组就永久多占一段上下文。这一层就是那个闸：超过预算就按**最近最少使用**
 * 把早先加载的**整组**卸掉（并明确告诉模型卸了谁），让常驻量有上限、不会无限涨。
 *
 * 默认 50000（由 10000 → 20000 → 50000 两次上调）。
 *
 * 为什么最终定 50000（真机数字）：
 *   整组加载 mcp:vnpy（213 个 MCP 工具）按估算占 **43,246 tok** ——
 *   20,000 的闸门会让它"单组即超预算 ⇒ 无更早的组可卸 ⇒ 整组被卸"，
 *   最终请求头只剩 30 个核心工具 ⇒ 模型调用报 unknown tool。
 *   50000 能容纳"核心 + 元 + 一整个 MCP 服务器"，同时仍然挡住
 *   "多个 MCP 服务器同时常驻"这种真正的失控场景。
 *
 * 为什么上调（真机铁证）：
 *   模型 load_plugin 加载 5 个 MCP 工具后，日志先出现
 *     "组装期检查通过 —— 本轮请求头工具 35 个（含 5 个 MCP）"   进请求头了
 *   28 秒后又出现
 *     "常驻预算 10000 tokens 已满 ⇒ 卸下 5 组：mcp:vnpy__get_tick、..."  被收回
 *   ⇒ 白名单里没有 ⇒ 模型调用报 unknown tool。
 *   而实测核心 30 个工具在请求头里只占 4,459 tok（真机 reclaim/groups 数据），
 *   5 个 MCP 工具约 570 tok ⇒ 合计约 5,000，**远没到 10,000**。
 *   ⇒ 说明 toolTokensOf() 的估算偏高（它用 toolCatalog.bytes / 3.9，
 *     bytes 若记的是完整 schema JSON 就会高估）⇒ 10,000 这个闸门会误伤。
 *
 * 预算的初衷（"别让工具无限涨"）仍然保留：20000 对"核心+元+一批按需工具"足够，
 * 而 213 个 MCP 全量（约 24,000）依然会被挡住 —— 那正是本插件想要的效果。
 * 可用环境变量 `DSH_COMPOSER_RESIDENT_BUDGET` 覆盖。
 */
const RESIDENT_BUDGET_TOKENS = (() => {
  const raw = Number(process.env.DSH_COMPOSER_RESIDENT_BUDGET)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50000
})()
/** 字节 → 大概 token（实测 163 KB ≈ 41.7k token ⇒ 约 3.9 字节/token）。 */
const BYTES_PER_TOKEN = 3.9
/**
 * 硬闸门修剪正文时，**要不要同时裁 `source.entries`**。
 *
 * 默认 **false（不裁）** —— 真机定位到：裁 entries 会让上游
 * `dsh-tool-skill` 的 `visibleDigest(裁后的 N 条)` 永远不等于 `快照 digest(全量 M 条)`
 * ⇒ **每步重发一份完整目录** ⇒ 每步 2 次表面改写 ⇒ 第 2 条往后的前缀缓存每步全废。
 * 现场：同一会话里连续出现同一条「The available skill catalog changed」（8 条）6 次以上，
 * 而 surfaceOp 每步 +2、`series` 请求头每步 +1。
 *
 * 设 `DSH_COMPOSER_SHRINK_ENTRIES=1` 可恢复旧行为（万一某版上游改成用 entries 渲染正文）。
 */
const SHRINK_ENTRIES = process.env.DSH_COMPOSER_SHRINK_ENTRIES === '1'
/**
 * 「插件提示段按组合收窄」总开关（默认**开**）。
 *
 * 关掉它（`DSH_COMPOSER_PRUNE_PLUGIN_SECTIONS=0`）就等于回到旧行为：
 * 组合里没列的插件，其系统提示段照旧每请求注入（实测 ≈2,129 tok/请求）。
 * 只在"疑似误删了正在用的段"时才需要关。
 */
const PRUNE_PLUGIN_SECTIONS = process.env.DSH_COMPOSER_PRUNE_PLUGIN_SECTIONS !== '0'
/** 一个工具在当前常驻集里大概占多少 token（没有字节记录就用 240 字节 ≈ 62 token 估）。 */
function toolTokensOf(name) {
  const bytes = toolCatalog.bytes.get(name)
  return Math.round((Number.isFinite(bytes) ? bytes : 240) / BYTES_PER_TOKEN)
}
/** 当前常驻集（核心 + 元工具 + 已加载）大概多少 token。 */
function residentTokens(state) {
  let total = 0
  for (const name of TOOL_CORE) total += toolTokensOf(name)
  for (const name of TOOL_META) total += toolTokensOf(name)
  for (const name of state.loaded) total += toolTokensOf(name)
  return total
}

/** 取（或建）某个 agent 的工具加载状态。 */
function toolStateFor(agent) {
  const key = agent !== null && typeof agent === 'object' ? agent : TOOL_FALLBACK
  let state = toolStates.get(key)
  if (state === undefined) {
    state = {
      /** 见过的全部工具名。只增不减：被 deny 之后就看不见了，必须靠它记住全集。 */
      known: new Set(),
      /** 工具名 → 一行描述（第一次看见时缓存）。 */
      hints: new Map(),
      /** 模型显式要求加载的工具名。 */
      loaded: new Set(),
      /** 按加载顺序记的"整组"（`{ id, tools, tokens, at }`），卸的时候整组卸。 */
      loadedGroups: [],
      /** 当前生效的限制的撤销函数。 */
      disposer: null,
      /** 上一次施加的 deny 列表（仅黑名单回退模式用；用于判断要不要重算）。 */
      deny: null,
      /** 上一次施加的**白名单**签名（allow 模式用；用于判断要不要重算）。 */
      allowSignature: null,
    }
    toolStates.set(key, state)
  }
  return state
}

/**
 * 超预算就把**最早的整组**卸掉（LRU），返回卸掉的组，供报告/证据使用。
 * 只卸"模型加载进来的"，核心/元工具永不卸。
 *
 * 已知边界（读代码时发现的洞）：
 *   `loadedGroups.length > 1` 这个条件意味着 —— **只加载了一组、而这一组自己就超预算**时
 *   （最典型：`load_plugin(["mcp:vnpy"])` = 213 个工具），这里**一个都不卸**，
 *   常驻量可以一路涨到几万 token，而预算声明是 10000。
 *   为什么**不**直接把它也卸掉（那才是"真的漏洞修复"？）：`load_plugin` 是模型刚刚
 *   明确要求的动作，卸掉它等于这个功能对大插件彻底没用（模型会反复加载、反复被卸，死循环）。
 *   ⇒ 这里采取**保守派**做法：行为不变，但把"超预算且无组可卸"这件事**说出来**
 *     （`residentOverBudget()`，由 load_plugin 的报告与证据行呈现），
 *     不再让"预算 10000、实际 30k"这种情况静默存在。
 */
function enforceResidentBudget(state) {
  const evicted = []
  if (!Array.isArray(state.loadedGroups)) state.loadedGroups = []
  let guard = 0
  while (residentTokens(state) > RESIDENT_BUDGET_TOKENS && state.loadedGroups.length > 1 && guard < 64) {
    guard += 1
    const group = state.loadedGroups.shift()
    for (const name of group.tools) {
      /* 只有当没有别的组还引用这个工具时才真正卸掉（同组工具不会重复加载，但保险）。 */
      const stillUsed = state.loadedGroups.some((g) => g.tools.includes(name))
      if (!stillUsed) state.loaded.delete(name)
    }
    evicted.push(group)
  }
  return evicted
}

/**
 * 卸完还超预算多少 token（0 = 在预算内）。
 * 非 0 只可能是"单组自己就超预算"这个已知边界 —— 见 enforceResidentBudget 的注释。
 */
function residentOverBudget(state) {
  return Math.max(0, residentTokens(state) - RESIDENT_BUDGET_TOKENS)
}

/**
 * 组合切换时回收**旧组合遗留的已加载工具**，返回被卸掉的名字数组。
 *
 * 约定：「如果我启用了新的组合，那旧的组合还存在的话，那这个是需要修复的
 * bug，要进入组合器这个插件里面的，**不仅是技能插件里组合也是一样**。」
 *
 * 技能轴由 `compactSkillCatalogSurface` 收（旧目录 → 指路牌）；**插件轴在这里收**：
 * `state.loaded` 是模型用 `load_plugin` 显式加载进来的工具名，设计上"只增不减"
 * （只有超预算的 LRU 会卸）⇒ 一旦切到**不含那些插件**的新组合，它们的工具仍然常驻在
 * 每一次请求的请求头里 —— 表现就是"旧组合还在生效"，白占 token，且与"组合决定可见范围"
 * 的语义直接矛盾。
 *
 * 幂等、无副作用：`scopeGlobs === null`（组合未设 = 不过滤）⇒ `toolInScope` 恒真 ⇒ 一个不卸。
 */
function reclaimOutOfScopeLoadedTools(state, scopeGlobs) {
  const dropped = []
  if (state === null || state === undefined || !(state.loaded instanceof Set)) return dropped
  for (const name of [...state.loaded]) {
    if (toolInScope(scopeGlobs, name)) continue
    state.loaded.delete(name)
    dropped.push(name)
  }
  if (dropped.length > 0 && Array.isArray(state.loadedGroups)) {
    state.loadedGroups = state.loadedGroups
      .map((group) => Object.assign({}, group, { tools: group.tools.filter((n) => state.loaded.has(n)) }))
      .filter((group) => group.tools.length > 0)
  }
  return dropped
}

/**
 * 把一句工具描述压成「能在目录里一眼看懂」的短句。
 *
 * 已知问题（"自适应会出现描述不好的问题"）：
 *   原来直接 hint.slice(0, 40) ⇒ 实测切出「用信号驱动组合回测（vnpy.」这种
 *   断在括号里的半句，反而误导。改成按优先级找切点：
 *   ① 第一个句末标点（。！？；; 或 ". "）；
 *   ② 括号外的最后一个逗号/顿号/冒号；
 *   ③ 括号配平处；
 *   ④ 才硬切并补省略号。
 * 纯字符串运算、无状态 ⇒ 新工具进来自动套用同一规则（这就是"自适应"该有的样子）。
 * @param text - 原始描述。
 * @param max - 目标上限字符数。
 * @returns 短描述（可能短于 max，但不会断在短语中间）。
 */
function smartShortHint (text, max) {
  const t = String(text ?? '').split('\n')[0].trim().replace(/\s+/g, ' ')
  if (t.length === 0) return ''
  if (t.length <= max) return t
  const m1 = /[。！？；;]|\.\s/.exec(t)
  if (m1 !== null && m1.index > 0 && m1.index <= max) return t.slice(0, m1.index + 1)
  const head = t.slice(0, max)
  let depth = 0
  let cut = -1
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i]
    if ('（(【['.includes(ch)) depth += 1
    else if ('）)】]'.includes(ch)) depth = Math.max(0, depth - 1)
    else if (depth === 0 && ',,、：'.includes(ch)) cut = i
  }
  if (cut > 8) return t.slice(0, cut)
  const depthAt = (str) => { let d = 0; for (const c of str) { if ('（(【['.includes(c)) d += 1; else if ('）)】]'.includes(c)) d -= 1 } return d }
  for (let end = head.length; end > 8; end -= 1) {
    if (depthAt(head.slice(0, end)) === 0) return head.slice(0, end)
  }
  return head.slice(0, Math.max(8, max - 1)) + '…'
}

/** 取一行描述（首行、去空白、截断）。 */
function toolHint(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  const line = raw.split('\n', 1)[0].trim()
  return line.length > TOOL_HINT_MAX ? `${line.slice(0, TOOL_HINT_MAX - 1)}…` : line
}

/**
 * 把当前作用域可见的工具累积进 known/hints。
 *
 * 只有在**限制之前**才看得到全集；限制生效后 schemas() 只剩可见的那几十个，
 * 所以这里是只增不减的累积，靠它记住"世界上还有哪些工具"。
 */
/**
 * 安全取服务 —— **只走 `ctx.get(name)`**。
 *
 * Cordis 里对**未声明 inject 的服务做属性访问**（`ctx.tools` / `ctx.webServer` / `ctx.slots`）
 *   会直接抛 `cannot get property "X" without inject`，而且这个异常会冒到插件应用层
 *   （真机表现：`failed to apply loader entry ... (dsh-capability-composer)` ⇒ Failed to load plugins）。
 *   本插件只 inject 了 `skills`，其它服务一律必须用 `ctx.get()` 取，并且吞掉异常。
 *   （真机踩了三次：路线二没挂上、组合 UI 接口没注册、客户端 entry 直接失败。）
 */
function serviceOf(ctx, name) {
  try {
    const get = ctx?.get
    if (typeof get !== 'function') return undefined
    return get.call(ctx, name)
  } catch {
    return undefined
  }
}

/**
 * 这个工具是不是 MCP 的。
 *
 * 更正：**MCP 是要联动的**。
 *
 * 早先那条结论的原文是「**不做 MCP 的 UI 面板**」—— 因为 MCP 那边
 * 自带的 UI 面板（mcp-panel / mcp-connector）已经能开关服务器，组合器不必再做一个。
 * 但当时被理解成「MCP 不参与联动」⇒ 落成 `mcp__*` 一律不观测、不登记、不限制。
 * 后果（实测）：`load_plugin(["mcp:vnpy"])` 把 213 个工具的完整 schema
 * 全部塞进请求头 ⇒ 每帧工具定义从 4,740 tok 涨到 24,209 tok，而实际只用到 26 个。
 *
 * ⇒ 正确语义是：**本插件要技能组合 + 插件组合两个面板，不做 MCP 面板；
 *   但 MCP 的工具要和插件工具一样，走路线二（schema 不常驻、按需加载）。**
 */
function isMcpTool(name) {
  return typeof name === 'string' && name.startsWith('mcp__')
}

/** `mcp__<server>__<tool>` → `<server>`；拆不出来就归到 `(未知)`。 */
function mcpServerOf(name) {
  const parts = String(name).split('__')
  return parts.length >= 3 && parts[1] !== '' ? parts[1] : '(未知)'
}

function observeTools(tools, agent, state) {
  if (tools === undefined || tools === null || typeof tools.schemas !== 'function') {
    noteOnce('tool-observe-no-service', '工具按需加载：拿不到 tools.schemas ⇒ 本步无法观察工具（目录靠插件扫描垫底）')
    return
  }
  /**
   * 真机教训（同一问题上第二次翻车）：**必须同时看"全局"那一份**。
   *
   * `tools.schemas(agent)` 返回的是**这个 agent 当前可见的**工具 —— 一旦施加了限制，
   * 它就再也看不见被 deny 的那些。如果第一次观察发生在插件还没注册完的时刻
   * （当晚 observed = 203），剩下的工具**永远进不了 known** ⇒ deny 永远漏掉它们
   * ⇒ 新会话照样吃到 414 个工具定义 / 65.6k token（真机实测就是这个数）。
   * 无参的 `tools.schemas()` 是**全局**视图，不受 agent 限制影响 —— 用它兜底。
   */
  const pools = []
  try {
    const global = tools.schemas()
    if (Array.isArray(global)) pools.push(global)
  } catch { /* 不支持无参调用就算了，别影响 agent 视图 */ }
  try {
    const scoped = tools.schemas(agent)
    if (Array.isArray(scoped)) pools.push(scoped)
  } catch (error) {
    noteOnce(`tool-observe-throw:${error?.message ?? error}`, `工具按需加载：tools.schemas(agent) 抛错 ⇒ 本步观察不到工具 —— ${error?.message ?? error}`)
  }
  if (pools.length === 0) {
    noteOnce('tool-observe-not-array', '工具按需加载：tools.schemas() 没返回数组 ⇒ 本步观察不到工具')
    return
  }
  const schemas = pools.flat()
  const before = toolCatalog.names.size
  for (const schema of schemas) {
    const toolName = schema?.name
    if (typeof toolName !== 'string' || toolName.length === 0) continue
    if (isMcpTool(toolName)) {
      /**
       * 第二个根因（真机实测逼出来的）：MCP **也要纳管**。
       *
       * 原来按早先的口径「MCP 与组合器无关」直接 `continue` —— 后果是几百个
       * `mcp__*` 工具**永远不进 deny**，每次都全量进上下文：实测新会话 414 个工具定义
       * / 65.6k token，其中 30 个是核心工具、剩下 ~384 个全是 MCP。在 MCP 面板里
       * 关掉不用的服务器能省，但那是"靠人自己记着"——组合器的职责就是别让上下文爆。
       * 现在：MCP 工具**照样默认不常驻**，按服务器分组进目录，需要时
       * `load_plugin(ids:["mcp:<server>"])` 整组加载回来。
       */
      const server = mcpServerOf(toolName)
      if (!toolCatalog.mcp.has(server)) toolCatalog.mcp.set(server, new Set())
      toolCatalog.mcp.get(server).add(toolName)
      state.known.add(toolName)
      if (!state.hints.has(toolName)) state.hints.set(toolName, toolHint(schema.description))
      /**
       * 这里以前直接 `continue`，**顺手漏掉了字节记账** ——
       *   后果是目录里 `mcp:<服务器>` 那行显示「能省 0 字节」（实测 `mcp:vnpy` bytes=0），
       *   看着像"这 213 个工具不占地方"，其实它们每个都有完整 schema。
       *   现在只补记账：**不动 names/hints/归属**（MCP 工具只由 `mcp:` 行认领这条规矩不变）。
       */
      if (!toolCatalog.bytes.has(toolName)) {
        try {
          toolCatalog.bytes.set(toolName, Buffer.byteLength(JSON.stringify(schema), 'utf8'))
        } catch {
          // 无法序列化就跳过，不影响主流程
        }
      }
      continue
    }
    state.known.add(toolName)
    if (!state.hints.has(toolName)) state.hints.set(toolName, toolHint(schema.description))
    // 同时喂给模块级目录：UI 要靠它列出"世界上有哪些工具"（跨 agent 累积）。
    toolCatalog.names.add(toolName)
    if (!toolCatalog.hints.has(toolName)) toolCatalog.hints.set(toolName, state.hints.get(toolName))
    if (!toolCatalog.bytes.has(toolName)) {
      // 这条 schema 的真实字节数 —— UI 用它算"隐藏这些工具能省多少"，不编数字。
      try {
        toolCatalog.bytes.set(toolName, Buffer.byteLength(JSON.stringify(schema), 'utf8'))
      } catch {
        // 无法序列化就跳过，不影响主流程
      }
    }
  }
  const mcpTools = [...toolCatalog.mcp.values()].reduce((sum, set) => sum + set.size, 0)
  if (toolCatalog.names.size !== before || mcpTools > 0) {
    noteOnce(
      `tool-catalog-size:${toolCatalog.names.size}:${mcpTools}`,
      `工具按需加载：插件工具目录 = ${toolCatalog.names.size} 个名字 · MCP 服务器 ${toolCatalog.mcp.size} 个 / 工具 ${mcpTools} 个`
      + `（两者默认都不常驻；需要时 load_plugin 传插件 id 或 mcp:<server> 加载）`,
    )
  }
}

/**
 * 目标 deny 列表：**世界上所有工具**减去（核心 / 元工具 / 保留名 / 这次显式加载过的）。
 *
 * 真机结论：不能只用这个 agent 的 `state.known`。
 *
 * `observeTools()` 读的是 `tools.schemas(agent)`，而**新建会话的第一步**在 pre-step
 * 时刻新 agent 的工具集**还没 materialize**（返回空数组）⇒ `known` 是空集 ⇒
 * deny=[] ⇒ 第一个请求把所有工具的 schema 全带出去（实测 ~34k token）。
 * 症状就是「新建一个会话，一切又回到原始」。
 *
 * 所以这里以**全局工具名目录** `toolCatalog.names` 为准（它跨 agent 累积 + 插件扫描
 * 时就会填充），`state.known` 只作为补充。
 */
function desiredToolDeny(state) {
  const deny = []
  const pool = new Set(toolCatalog.names)
  for (const name of state.known) pool.add(name)
  for (const toolName of pool) {
    if (TOOL_RESERVED.has(toolName)) continue
    if (TOOL_META.has(toolName)) continue
    if (TOOL_CORE.has(toolName)) continue
    if (state.loaded.has(toolName)) continue
    deny.push(toolName)
  }
  deny.sort()
  return deny
}

/**
 * 从 `restrict()` 的报错里挑出「未知的全局工具名」并剔除。
 *
 * 报错形如：`... names unknown global tool(s) "a", "b"; known global tools: "x", ...`
 * 分号之后是候选清单，不能当成坏名字，所以先切掉那一半。
 * allow / deny 两种模式共用。
 */
function dropUnknownToolNames(list, error) {
  const message = String(error?.message ?? '')
  const head = message.split('; known global tools:')[0]
  const bad = new Set()
  for (const match of head.matchAll(/"([^"]+)"/g)) bad.add(match[1])
  if (bad.size === 0) return list
  return list.filter((toolName) => !bad.has(toolName))
}

/**
 * 施加/刷新某个 agent 的工具限制。
 *
 * 关键语义（@deepseek-ai/dsh-tools）：多次 `restrict()` **取交集**，所以"放回一个
 * 工具"必须**先撤销旧限制再施加新限制**，不能叠加。
 *
 * **范式修正（"底层原理做错了"）**：
 * 以前用 `deny`（= 我观察到的一切 − 允许的），这要求"先有一次全量经验才知道世界上有什么"
 * —— 一旦第一次观察不完整（新会话第一步 / 插件还没注册完 / MCP 从来没进过观察），
 * 漏掉的那些工具就永远不受限制（实测：414 个工具定义 / 65.6k token）。
 *
 * 现在改用 **`allow`（只保留）**——`dsh-tools` 原生支持 `restrict({ allow })`：
 * 白名单 = 常驻核心 + 元工具 + 这一步显式加载过的。**其余一律不可见**，
 * 不管它是什么时候注册的、我叫不叫得出名字。
 * 这才是"没选上就直接屏蔽"，不需要任何冷/热学习，也不会漏。
 *
 * @returns `{ changed, deny, allow, reason }`；调用方还会再包一层 try/catch。
 */
function applyToolRestriction(ctx, agent, state) {
  const scoped = agent?.ctx?.get?.('tools') ?? agent?.ctx?.tools
  if (scoped === undefined || scoped === null || typeof scoped.restrict !== 'function') {
    /* 这是「看着在跑、其实一点没限制」的静默路径之一，必须留证据。 */
    noteOnce('tool-restrict-no-scope', '工具按需加载：agent 的 tools 作用域没有 restrict() ⇒ 这一步**没有施加任何限制**（工具会全量进上下文）')
    return { changed: false, deny: state.deny ?? [], reason: 'no-scope' }
  }
  observeTools(serviceOf(ctx, 'tools'), agent, state)

  /* 白名单 = 核心 + 元工具 + 已加载（run_code 是保留名，restrict 不许点它，天然可见）。 */
  /* MIDDLEWARE_FULL：放行「全部已知工具」——
     让中转（`invoke_tool`）能执行任何工具、并且能安全地带上 agent
     （见 MIDDLEWARE_FULL 的长注释）。
     这一层只管「**能不能执行**」；「**发给模型的列表**」由 maskAssemblyTools
        在组装期裁到核心 28 + 元工具（前缀稳定不受影响）。 */
  const allow = (MIDDLEWARE_FULL
    ? [...state.known]
    : [...TOOL_CORE, ...TOOL_META, ...loadableResidentNames(state)]
  ).filter((n) => !TOOL_RESERVED.has(n)).sort()
  const signature = allow.join('|')
  /* 保险：早退**必须同时确认限制还真的在生效**。
     原来只看 `allowSignature` 相同就 return —— 万一 `restrictionActive` 已经是 false
     （限制被作用域销毁、或某条失败路径把它撤了却没清签名），这个早退会让"这一步没有任何限制"
     **静默延续下去**，表现就是"工具全量进上下文"，正是最需要防的那类事故。
     现在两个条件都要满足才敢早退；不满足就照常重新施加一次（代价只是一次 restrict 调用）。 */
  if (state.restrictionActive === true && state.allowSignature !== null && state.allowSignature === signature) {
    return { changed: false, allow, reason: 'unchanged' }
  }

  // 先撤销旧限制：restrict 是交集语义，不退旧的等于限制只增不减。
  const previous = state.disposer
  state.disposer = null
  state.restrictionActive = false
  if (previous !== null) {
    try {
      previous()
    } catch {
      // 旧限制已随作用域销毁，忽略。
    }
  }

  let applied = allow
  let mode = 'allow'
  try {
    state.disposer = scoped.restrict({ allow })
  } catch (error) {
    /* 白名单里可能有这台机器上并不存在的名字（例如某个核心工具被裁剪过）——
       dsh-tools 会报 `names unknown global tool(s) "x"`，照着剔掉再试一次。 */
    const trimmed = dropUnknownToolNames(allow, error)
    if (trimmed.length > 0 && trimmed.length !== allow.length) {
      state.disposer = scoped.restrict({ allow: trimmed })
      applied = trimmed
      /**
       * 这条路径以前**什么都不写** —— 于是日志里出现
       *   「白名单：只保留 29 个 · 预期 ≈ 核心 28 + 元 2（=30）」，两个数对不上，
       *   排查时被当成"账不平"（真机实测就是 29 vs 30）。实际原因很干净：
       *   第一次 pre-step 时宿主的全局注册表**还没注册完**（某个插件晚一步），
       *   `restrict({allow})` 报 `names unknown global tool(s) "x"`，这里剔掉一个再试，
       *   但**没说剔了谁**。现在写清楚：剔了哪个、从几个到几个。
       */
      const dropped = allow.filter((n) => !trimmed.includes(n))
      noteOnce(
        `tool-restrict-trimmed:${dropped.join(',')}`,
        `工具按需加载：白名单里有**宿主当时还不认识**的名字 ⇒ 已剔除后重试`
        + `（${dropped.join(', ')}；白名单 ${allow.length} → ${trimmed.length} 个）`
        + '—— 这是"宿主注册表还没注册完"的时序，不是配置错误',
      )
    } else if (typeof scoped.restrict === 'function') {
      /* 该版本不支持 allow（老 dsh-tools）⇒ 退回 deny 模式（需要观察全集）。 */
      mode = 'deny'
      const deny = desiredToolDeny(state)
      if (deny.length === 0) {
        state.allowSignature = signature
        /* 这一条**没有**施加限制（工具本来就是空的）⇒ 别把它标成"限制在生效"。 */
        state.restrictionActive = false
        noteOnce('tool-restrict-empty', '工具按需加载：没有可限制的工具 ⇒ 这一步不限制（工具本来就是空的）')
        return { changed: true, deny, allow, reason: 'empty' }
      }
      try {
        state.disposer = scoped.restrict({ deny })
        applied = deny
      } catch (error2) {
        const trimmed2 = dropUnknownToolNames(deny, error2)
        if (trimmed2.length === 0 || trimmed2.length === deny.length) {
          state.allowSignature = null // 下一步重算，别把半成品当成已生效
          state.deny = null
          throw error2
        }
        state.disposer = scoped.restrict({ deny: trimmed2 })
        applied = trimmed2
      }
    } else {
      state.allowSignature = null
      throw error
    }
  }
  state.allowSignature = signature
  /* 只有走到这里才代表"这一步确实施加了限制"（'empty' 那条提前 return 了，不算）。
     早退判据要靠它，见上面的长注释。 */
  state.restrictionActive = true
  state.deny = mode === 'deny' ? applied : null
  /* 三个数里的第二个：**作用域视图实测**（`tools.schemas(agent).length`）。
     教训：以前只报"打算保留几个"，从不实测宿主**真给了几个**，
     于是"日志绿了、上下文还是 38k"这种自欺能藏一整天。现在必须实测。 */
  const scopedSeen = measureScopedTools(ctx, agent)
  /* 一行证据：这是"这一约束**真的**施加了"的唯一可查痕迹（插件 INFO 日志不进 harness.log）。
     没有它就只能靠猜 —— 排查「新会话不生效」时正是缺这句话。 */
  toolDietNote(
    `工具按需加载已施加（${mode === 'allow' ? '白名单：只保留' : '黑名单：只移除'} ${applied.length} 个`
    + `${mode === 'allow' && applied.length !== allow.length ? `（声明 ${allow.length} 个，宿主当时不认识 ${allow.length - applied.length} 个 ⇒ 见上一条剔除行）` : ''}）`
    + ` · 作用域实测 = ${scopedSeen === null ? '读不到 schemas' : `${scopedSeen} 个`}`
    + ` · 预期 ≈ 核心 ${TOOL_CORE.size} + 元 ${TOOL_META.size} + 已加载 ${state.loaded.size}`
    + `（其余一律不可见，包括 MCP；需要时 load_plugin 传插件 id 或 mcp:<服务器>）`,
  )
  return { changed: true, deny: state.deny ?? [], allow: applied, reason: 'applied' }
}

/** 读宿主这一作用域**实际**能看到几个工具（读不到就返回 null，不是 0）。 */
function measureScopedTools(ctx, agent) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === null || tools === undefined || typeof tools.schemas !== 'function') return null
    const list = tools.schemas(agent)
    return Array.isArray(list) ? list.length : null
  } catch {
    return null
  }
}

/** 一行证据。插件 INFO 日志不进 harness.log，stderr 进。 */
/* **全局内容去重**（血泪教训）。
   以前它无去重，凡是在"每帧路径"上的调用点都会刷屏 —— 实测同一秒连打
   几十条**一字不差**的行，把日志桥打爆：
     [warn] dsh-desktop-log-bridge: dropped 287 message(s) over the rate limit
   ⇒ 真正的错误被冲掉：曾有一次 `注册元工具失败`（schema type 数组）
     就是这么被埋掉的，排查绕了很久。
   现在：**同一条内容只写一次**；内容变了（数字/原因不同）照常写。
   `noteOnce` 仍然可用（它额外提供"调用点级"的去重 key）。 */
const dietNoteSeen = new Set()
const DIET_NOTE_SEEN_MAX = 4000
function toolDietNote(message) {
  try {
    const key = String(message)
    if (dietNoteSeen.has(key)) return
    if (dietNoteSeen.size >= DIET_NOTE_SEEN_MAX) dietNoteSeen.clear()
    dietNoteSeen.add(key)
    process.stderr.write(`[composer] ${message}\n`)
  } catch {
    // 写不进去也不能影响对话。
  }
}

/** 同一 key 只写一次（避免每步刷屏）。 */
const notedKeys = new Set()
function noteOnce(key, message) {
  if (notedKeys.has(key)) return
  notedKeys.add(key)
  toolDietNote(message)
}

/**
 * 名字候选：给 unknown 回显最接近的几个，省一轮试错。
 *
 * 三级匹配：完全相同 → 前缀 → 子串；都没有时退回「最长公共前缀 ≥ 4 字符」，
 * 这样 `docker_pp` 也能找到 `docker_ps`（纯子串匹配对拼写错误是瞎的）。
 */
function nearestToolNames(name, known, limit = 5) {
  const needle = name.toLowerCase()
  const scored = []
  for (const candidate of known) {
    const lower = candidate.toLowerCase()
    let score = -1
    if (lower === needle) score = 0
    else if (lower.startsWith(needle)) score = 1
    else if (lower.includes(needle)) score = 2
    else if (needle.length > 0 && needle.includes(lower)) score = 3
    else if (commonPrefixLength(lower, needle) >= 4) score = 4
    if (score >= 0) scored.push({ candidate, score })
  }
  scored.sort((a, b) => a.score - b.score || (a.candidate < b.candidate ? -1 : 1))
  return scored.slice(0, limit).map((entry) => entry.candidate)
}

/** 两个字符串的公共前缀长度。 */
function commonPrefixLength(left, right) {
  const max = Math.min(left.length, right.length)
  let i = 0
  while (i < max && left[i] === right[i]) i += 1
  return i
}

/**
 * 元工具 `search_tools`：在全局注册表里按名字/描述检索。
 *
 * 只返回**插件**，一行一个：`id · 名字 · 关键词 · 几个工具`。
 * **绝不回工具名、更不回参数** —— 回了就等于把省下来的上下文又塞回去。
 *
 * 形状说明：手写 raw definition，字段与 defineTool 编译结果对齐（parameters 是
 * 已编译的 raw JSON Schema；output.schema 根节点必须显式 additionalProperties）。
 */
/**
 * 宿主的**权威**工具全集：无参 `tools.schemas()` = 全局视图，不受任何 agent 限制影响。
 * 拿不到就返回 null（调用方必须把它当成"这次没结论"，绝不能当成"没有工具"）。
 */
function hostToolUniverse(ctx) {
  const tools = serviceOf(ctx, 'tools')
  if (tools === null || tools === undefined || typeof tools.schemas !== 'function') return null
  try {
    const list = tools.schemas()
    if (!Array.isArray(list)) return null
    /* 返回 `Map<name, schema>` 而不是 `Set<name>`。
       原来只取 name、丢掉 description ⇒ 从这条路进来的工具（尤其是 MCP 的 213 个）
       在目录里只有名字、没有描述，模型挑不动。
       （实测：toolCatalog.names 有 213 个 mcp__*，而 toolCatalog.hints 是 0 条 ——
       因为 observeTools 那一刻 MCP 还没注册，之后垫目录又只补了名字。）
       返回 `Set` 的形状仍然兼容：下面用 `.keys()`/迭代都当 name 集合用。 */
    const byName = new Map()
    for (const item of list) {
      const name = item === null || item === undefined ? undefined : item.name
      if (typeof name === 'string' && name !== '') byName.set(name, item)
    }
    return byName
  } catch {
    return null
  }
}

/**
 * 「目录到底漏没漏工具」的可查报告（体检脚本 + 证据行都用它）。
 *
 * `missing` 是**硬指标**：宿主注册表里有、而本插件目录里没有的名字。
 * 它永远应该是空的 —— 不为空就说明模型**永远发现不了**那个工具（即"缺失"）。
 */
function coverageReport(ctx) {
  const universe = hostToolUniverse(ctx)
  if (universe === null) return { ok: null, host: null, catalog: toolCatalog.names.size, missing: [], note: '读不到宿主全局 schemas' }
  const missing = []
  for (const name of universe.keys()) if (!toolCatalog.names.has(name)) missing.push(name)
  return {
    ok: missing.length === 0,
    host: universe.size,
    catalog: toolCatalog.names.size,
    missing: missing.sort(),
  }
}

/**
 * 元工具 `invoke_tool`：**按名字调用任意已注册工具**（含不在 tools 列表里的）。
 *
 * 为什么需要它
 * 本插件把 MCP / 插件工具挡在 tools 数组外（省上下文、保前缀缓存），
 * 而 `tools.restrict({ allow })` **既限制「可见性」、也限制「可执行性」**。
 * 实测：模型即使从目录里知道工具名、直接发起调用，也会被判 `unknown tool`
 * ⇒ 光"把定义给它看"不够，必须给一条**能真正执行的通道**。
 *
 * 怎么绕过去（读 dsh-tools 源码确认，非猜测）
 *   L3034  const visible = this.get(name, agent)     // get(name, scope) = view(scope).visible.get(name)
 *   L2868  if (layers.every((layer) => layer.admits(name))) visible.set(name, definition)
 * 而 `restrict()` 只能挂在 **agent 作用域**上（L2792 明确写道：context-global restriction 会把所有 agent 都遮住）。
 * ⇒ **执行时只要不传 `agent`，就走 global view ⇒ 不经过任何 agent 级 restriction** ⇒ 任何已注册工具都能执行。
 *
 * 设计（与 CacheRouter 论文同思路：固定前缀 + 独立路由通道）
 * tools 数组**恒定**（核心 28 + 元工具 3），模型要调长尾工具时走这个**固定入口** ——
 * 动态工具于是永远不进入请求前缀，缓存锚点（tools + system）保持不动。
 *
 * 无损
 * 只"多一条调用通道"，不改任何既有行为；删掉这个注册即完全恢复原状。
 * 且它**不把任何工具加进 `state.loaded`** ⇒ 不触发 tools 数组变化。
 */
function makeInvokeToolDefinition(ctx) {
  let seq = 0
  const stringifySafe = (v) => {
    try {
      if (typeof v === 'string') return v
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return {
    name: 'invoke_tool',
    description:
      'Call ANY registered tool by its exact name - including tools whose schema is NOT in your tools list. '
      + 'Use it for MCP / plugin tools you know exist (from search_plugins or the plugin catalog) but cannot see. '
      + 'Pass `tool` (exact name, e.g. "mcp__vnpy__get_risk_setting") and `args` (that tool\'s arguments object; use {} if none). '
      + 'This keeps the tools list stable, which preserves prompt caching.',
    parameters: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Exact registered tool name, e.g. "mcp__vnpy__get_risk_setting".',
        },
        args: {
          type: 'object',
          additionalProperties: true,
          description: 'Arguments for that tool. Use {} when it takes none.',
        },
      },
      required: ['tool'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          tool: { type: 'string' },
          result: { type: 'string' },
          /* 透传被调用工具的结构化元数据（`presentationMeta`）。
             它落在 tool/result 事件的 `meta` 上，**模型看不到**，只有客户端卡片读得到
             —— 这正是 `@dsh-trading/tool-market` 给图表卡片的做法
             （见其 `lib/index.js` L126-140 的原注释："the card reads it live and on
             session replay; the model never sees it"）。 */
          /* 血泪教训：这里**必须**是单一 type 字符串。
             我一开始写成 `type: ['object', 'null']`，DSH 的 schema 校验直接抛
             `unsupported JSON schema: ... must be a single type string (type arrays are not supported)`
             ⇒ **整个 ensureRegistered 失败** ⇒ invoke_tool / search_plugins / load_plugin 全部没注册
             ⇒ 模型报 `unknown tool "invoke_tool"`（静默降级，查了很久）。
             现在固定 `type: 'object'`；代码侧只在 meta 真的是 object 时才带上这个字段。 */
          meta: { type: 'object' },
        },
        required: ['ok', 'tool', 'result'],
      },
      /* **透传 meta 是本文件最关键的一处修复**。
         中转如果只回文本，被调用工具的 `meta`（例如图表的 `kind/chart/timeframes`）
         就丢了 ⇒ `@dsh-trading/client-chart` 的 `ChartCard` 读 `block.meta` 得到 null
         ⇒ **卡片不渲染、也不报错**（静默失败，最难查）。
         这里把 meta 原样交出去，卡片即可正常绘制。 */
      presentationMeta: (_args, value) => {
        const meta = value?.meta
        return (meta !== null && meta !== undefined && typeof meta === 'object') ? meta : null
      },
      render: (args, value) => [{
        type: 'text',
        text: (() => {
          /* 思路抄自 dsh-progressive-tools 的 `nestedDispatch`）：
             把「实际被调用的工具名」显式写进 tool_result。
             否则会话回放/审计/统计里只看得到 `invoke_tool`，看不出真实调的是哪个
             MCP 或插件工具 —— 这正是开源实现用 nestedDispatch 解决的问题。 */
          const called = String(value?.tool ?? args?.tool ?? '').trim()
          const head = called.length > 0 ? `[invoke_tool → ${called}]` : '[invoke_tool]'
          const body = String(value?.result ?? '')
          return value?.ok ? `${head}\n${body}` : `${head} 执行失败：${body}`
        })(),
      }],
    },
    async execute(args, exec) {
      const name = String(args?.tool ?? '').trim()
      const rawArgs = args?.args
      const toolArgs = (rawArgs !== null && rawArgs !== undefined && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs : {}
      /* 第三个参数 = 被调用工具的结构化 `meta`，由 presentationMeta 透传给卡片。 */
      const mk = (ok, result, meta) => (meta === null || meta === undefined || typeof meta !== 'object')
        ? { ok, tool: name, result: String(result) }
        : { ok, tool: name, result: String(result), meta }

      if (name.length === 0) return mk(false, '缺少 `tool` 参数。')

      const tools = serviceOf(ctx, 'tools')
      if (tools === undefined || tools === null || typeof tools.execute !== 'function') {
        return mk(false, '拿不到 tools 服务（宿主未提供 execute）。')
      }

      try {
        seq += 1
        const callId = `${exec?.callId !== undefined ? String(exec.callId) : 'invoke_tool'}:invoke:${seq}`
        const input = {
          callId,
          name,
          arguments: toolArgs,
          ...exec?.rootCallId !== undefined ? { rootCallId: String(exec.rootCallId) } : {},
          ...exec?.signal !== undefined && exec.signal !== null ? { signal: exec.signal } : {},
          /* MIDDLEWARE_FULL：带上 agent —— 让依赖 agent 上下文的工具
             （`todo_write` / `create_goal` / `ask_user_question` / `subagent` / `skill` /
              任何按作用域注册的插件工具）在中转里也能正常工作。
             前提：`applyToolRestriction` 必须已「全量放行」，否则带 agent 反而会被
                restrict 拦成 `unknown tool`。默认关时保持旧行为（不传 agent）。 */
          ...(MIDDLEWARE_FULL && exec?.agent !== undefined ? { agent: exec.agent } : {}),
        }
        const outcome = await tools.execute(input)
        const oc = (outcome !== null && outcome !== undefined && typeof outcome === 'object') ? outcome : {}
        const failed = oc.isError === true || oc.error !== undefined
        let text
        if (typeof outcome === 'string') text = outcome
        else if (oc.content !== undefined) text = stringifySafe(oc.content)
        else if (oc.value !== undefined) text = stringifySafe(oc.value)
        else text = stringifySafe(outcome)
        if (failed && oc.error !== undefined) {
          const head = String(oc.error?.message ?? oc.error)
          text = text.length > 0 ? `${head}\n${text}` : head
        }
        const clipped = text.length > 20000 ? `${text.slice(0, 20000)}\n…(已截断)` : text
        /* 把被调用工具的结构化 meta 取出来，随返回值透传给卡片。
           `dsh-tools` 在 result 上挂 `meta`（见其 L3427-3442：仅当 `exec.parent === undefined`
           且工具有 `output.presentationMeta` 时才生成）；不同版本可能放在 `oc.meta`
           或 `oc.result.meta`，两处都探一下。 */
        const childMeta = oc.meta !== undefined && oc.meta !== null
          ? oc.meta
          : ((oc.result !== null && oc.result !== undefined && typeof oc.result === 'object') ? oc.result.meta : undefined)
        return mk(!failed, clipped, childMeta)
      } catch (error) {
        return mk(false, `执行抛错：${error?.message ?? error}`)
      }
    },
  }
}

/**
 * 元工具 `search_tools` —— 两段式发现的第一段（抄自 dsh-progressive-tools）。
 *
 * 按查询**词法搜索全部已注册工具**（含 MCP / 插件里那些不常驻的），
 * 只返回 `name` + 一行描述 ⇒ 轻量。要完整参数再用 `describe_tools`。
 * 中文查询同样可用（字符二元组匹配）。
 */
function makeSearchToolsDefinition(ctx) {
  return {
    name: 'search_tools',
    description:
      'Search ALL registered tools — including MCP and plugin tools that are NOT in your tools list — '
      + 'with a lexical query. Returns `name` + one-line description only (cheap). '
      + 'Then call describe_tools({ names }) for the exact schema, then invoke_tool to run it. '
      + 'Matches against tool name, description, parameter names and enums; Chinese queries work too. '
      + 'Pass an empty query or "*" to list every registered tool.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords, e.g. "风控" or "risk setting" or "mcp__vnpy". Empty / "*" = list all.' },
        limit: { type: 'number', description: `Max results (default ${TOOL_SEARCH_DEFAULT_LIMIT}, max ${TOOL_SEARCH_MAX_LIMIT}).` },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { count: { type: 'number' }, text: { type: 'string' } },
        required: ['count', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const tools = serviceOf(ctx, 'tools')
      let schemas = []
      try {
        const raw = tools?.schemas?.()
        if (Array.isArray(raw)) schemas = raw
      } catch { /* fail-open */ }
      if (schemas.length === 0) return { count: 0, text: '拿不到工具目录（tools.schemas 不可用）。' }

      const rawQuery = String(args?.query ?? '').trim()
      const parsed = Number(args?.limit)
      const limit = Math.min(
        TOOL_SEARCH_MAX_LIMIT,
        Math.max(1, Number.isFinite(parsed) ? Math.floor(parsed) : TOOL_SEARCH_DEFAULT_LIMIT),
      )
      const listAll = rawQuery === '' || rawQuery === '*'
      const picked = listAll
        ? schemas.slice()
          .sort((a, b) => String(a?.name).localeCompare(String(b?.name)))
          .slice(0, limit)
          .map((schema) => ({ schema }))
        : rankToolsByQuery(schemas, rawQuery, limit)

      if (picked.length === 0) {
        return {
          count: 0,
          text: `没有命中「${rawQuery}」的工具。可用 search_tools({ query: "*" }) 列出全部 ${schemas.length} 个。`,
        }
      }
      const lines = picked.map((candidate, index) =>
        `${index + 1}. ${String(candidate.schema?.name)}\n   ${briefDescriptionOf(candidate.schema)}`)
      return {
        count: picked.length,
        text: `${picked.length} 个结果（共 ${schemas.length} 个已注册工具）：\n${lines.join('\n')}\n\n`
          + '下一步：用 describe_tools({ names: [...] }) 拿完整参数，再用 invoke_tool 执行。',
      }
    },
  }
}

/**
 * 元工具 `describe_tools` —— 两段式发现的第二段。
 * 只对**指定的名字**返回完整 schema（含参数），所以多查几个的代价也很小。
 */
function makeDescribeToolsDefinition(ctx) {
  return {
    name: 'describe_tools',
    description:
      'Return the FULL schema (parameters included) for the exact tool names you pass. '
      + 'Use it after search_tools, for the names you actually intend to call, '
      + 'then execute with invoke_tool({ tool: "<name>", args: {...} }).',
    parameters: {
      type: 'object',
      properties: {
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact tool names, e.g. ["mcp__vnpy__get_risk_setting"].',
        },
      },
      required: ['names'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args) {
      const tools = serviceOf(ctx, 'tools')
      const wanted = Array.isArray(args?.names)
        ? args.names.map((n) => String(n ?? '').trim()).filter((n) => n.length > 0)
        : []
      if (wanted.length === 0) return { text: '请给 names 数组（要查询的精确工具名）。' }

      const found = []
      const missing = []
      for (const name of wanted) {
        let schema
        try {
          schema = tools?.get?.(name)
        } catch { /* fail-open */ }
        if (schema === undefined || schema === null) missing.push(name)
        else found.push(schema)
      }
      const blocks = found.map((schema) => {
        let params = '{}'
        try {
          params = JSON.stringify(schema?.parameters ?? {}, null, 2)
        } catch { params = '(无法序列化)' }
        const full = String(schema?.description ?? '').slice(0, 1200)
        return `### ${String(schema?.name)}\n${full}\n\nparameters:\n\`\`\`json\n${params}\n\`\`\``
      })
      const tail = missing.length > 0
        ? `\n\n⚠️ 未找到（名字可能不对，或该工具当前未注册）：${missing.join('、')}`
        : ''
      const head = `拿到 ${found.length} 个工具的完整定义。用 invoke_tool({ tool: "<上面的名字>", args: {...} }) 执行。\n\n`
      return { text: head + blocks.join('\n\n') + tail }
    },
  }
}

function makeSearchPluginsDefinition(ctx, pluginsOf, getAllPlugins) {
  return {
    name: 'search_plugins',
    description:
      'Search the plugin catalog by id, name, description, activation keyword, or the name of a tool a plugin owns. ' +
      'The unit here is a PLUGIN, not a tool: this returns plugins only (id + name + keywords + how many tools it owns), ' +
      'never tool names and never parameters — a tool-name query still answers with the plugin that owns it. ' +
      'Use it when you need a capability you cannot see, then call what you found via ' +
      'invoke_tool({ tool: "<exact tool name>", args: {...} }) — no loading step needed.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keyword matched against plugin id, name, description, and activation keywords. An empty query lists every visible plugin.',
        },
        limit: {
          type: 'number',
          description: `Maximum results (default ${TOOL_SEARCH_DEFAULT}, max ${TOOL_SEARCH_MAX}).`,
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { report: { type: 'string' } },
        required: ['report'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const state = toolStateFor(agent)
      observeTools(serviceOf(ctx, 'tools'), agent, state)

      const query = String(args?.query ?? '').trim().toLowerCase()
      const limitRaw = Number(args?.limit)
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), TOOL_SEARCH_MAX)
        : TOOL_SEARCH_DEFAULT

      const visible = pluginsOf(agent)
      // 总数必须用**不过滤**的全集（真机测出的 bug）：
      //    `pluginsOf(null)` 只是"用全局默认组合"，仍然套了组合过滤 ⇒ 会把
      //    "世界上有多少插件"算成当前可见的那几个，`hiddenByComposition` 永远是 0。
      const total = getAllPlugins().length
      const hiddenPlugins = Math.max(0, total - visible.length)

      const hits = []
      for (const row of visible) {
        const id = String(row.id).toLowerCase()
        const name = String(row.name ?? '').toLowerCase()
        const hay = [id, name, String(row.description ?? ''), ...(row.keywords ?? [])].join(' ').toLowerCase()
        /* **按工具名也能搜到**（需求大头：工具不许"缺失"）。
           契约仍然是"只回插件、不回工具名"（第 4 节测试锁着），所以这里只用工具名做**命中判断**，
           报告里依旧只给插件行 —— 于是"我知道有个 docker_logs 但不知道属于哪个插件"也能找到。 */
        const toolHit = query.length > 0 && Array.isArray(row.tools)
          && row.tools.some((t) => String(t).toLowerCase().includes(query))
        if (query.length > 0 && !hay.includes(query) && !toolHit) continue
        // 排序：id 命中 > 名字命中 > 工具名命中 > 其它命中
        const score = query.length === 0 ? 0 : (id.includes(query) ? 0 : (name.includes(query) ? 1 : (toolHit ? 2 : 3)))
        hits.push({ row, score })
      }
      hits.sort((a, b) => a.score - b.score || (a.row.id < b.row.id ? -1 : 1))
      const shown = hits.slice(0, limit)

      const loadedTools = new Set()
      for (const row of visible) for (const toolName of row.tools) if (state.loaded.has(toolName)) loadedTools.add(toolName)
      const enabledCount = visible.filter((row) => row.tools.length > 0 && row.tools.every((t) => state.loaded.has(t))).length

      const lines = [
        `plugins=${total} visible=${visible.length} hiddenByComposition=${hiddenPlugins} ` +
        `residentTools=${toolResidentBase() + state.loaded.size} enabledPlugins=${enabledCount} ` +
        `loadedTools=${loadedTools.size} matched=${hits.length} showing=${shown.length}`,
        'Individual tool schemas are NOT resident. To CALL one: invoke_tool({ tool: "<exact name>", args: {...} }) — no loading needed.',
        '',
      ]
      if (shown.length === 0 && hiddenPlugins > 0) {
        lines.push(`(no match in the active composition — ${hiddenPlugins} plugins are hidden by it; that is by design, not a failure)`)
      } else if (shown.length === 0) {
        lines.push('(no match — try a broader keyword, or an empty query to list every plugin)')
      }
      for (const hit of shown) {
        const row = hit.row
        const on = row.tools.length > 0 && row.tools.every((t) => state.loaded.has(t))
        const some = !on && row.tools.some((t) => state.loaded.has(t))
        const mark = on ? '[enabled] ' : (some ? '[partial] ' : '')
        lines.push(`${mark}${row.id} · ${row.name ?? row.id} · ${row.tools.length} tools · ${(row.keywords ?? []).join(' ')}`)
      }
      if (hits.length > shown.length) {
        lines.push('', `…${hits.length - shown.length} more; narrow the keyword or raise limit.`)
      }
      return { report: lines.join('\n') }
    },
  }
}

/** 元工具 `load_plugin`：把一个**插件**底下的全部工具一次放回，下一步它们的完整 schema 进上下文。 */
function makeLoadPluginsDefinition(ctx, pluginsOf, getAllPlugins) {  return {
    name: 'load_plugin',
    description:
      'Make tools resident from your next step. Two granularities: ' +
      '(a) WHOLE plugin / MCP server — ids like ["docker", "mcp:vnpy"]; ' +
      '(b) ONE tool — ids like ["mcp:vnpy__run_backtest"] (server__tool, as listed in the catalog). ' +
      'PREFER (b): loading a whole MCP server pulls in every one of its tools and costs a lot of context. ' +
      'Get ids from search_plugins, or from the plugin catalog in your system prompt.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids to enable. Whole plugin / MCP server: ["docker", "mcp:vnpy"]. Single tool: ["mcp:vnpy__run_backtest"]. Exactly as reported by search_plugins or the catalog.',
        },
      },
      required: ['ids'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { report: { type: 'string' } },
        required: ['report'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.report ?? '') }],
    },
    async execute(args, exec) {
      const agent = exec?.agent
      const state = toolStateFor(agent)
      observeTools(serviceOf(ctx, 'tools'), agent, state)

      const visible = pluginsOf(agent)
      // 存在性判断必须用**不过滤**的全集（真机测出的 bug）：
      //    用 `pluginsOf(null)` 的话，组合外的**已存在**插件会被误报成 `unknown`
      //    —— 模型会以为它压根不存在，而不是"被当前组合排除了"。
      const all = getAllPlugins()
      const rawIds = Array.isArray(args?.ids) ? args.ids : (args?.id !== undefined ? [args.id] : [])
      const enabled = []
      const unknown = []
      const blocked = []
      /* CACHE_SAFE：本次**真正被加载**的工具名。
         打开开关时 tools 数组不会因加载而变化 ⇒ 必须把它们的定义随
         本次返回值（tool_result，属于 messages 的一次性内容）交给模型。 */
      const loadedThisCall = []
      for (const raw of rawIds) {
        const id = String(raw ?? '').trim()
        if (id.length === 0) continue
        /* 支持「工具级」id —— mcp:<server>__<tool>（只加载那一个）。
           背景：实测 load_plugin(["mcp:vnpy"]) 会把 213 个工具的完整 schema 全塞进
           请求头（每帧工具定义 4,740 → 24,209 tok），而整个会话实际只用 26 个。
           目录段里已经列了每个 MCP 工具的名字 + 一行描述 ⇒ 模型照抄一个名字即可，
           不需要"猜"（这正是当初否掉工具级粒度的原因，现在不成立了）。
           兼容：不带 "__" 的 id 仍按整服务器/整插件加载。 */
        let row = all.find((r) => r.id === id)
        let pickOne = null
        if (row === undefined && id.startsWith('mcp:') && id.includes('__')) {
          const rest = id.slice(4)
          const idx = rest.indexOf('__')
          const server = rest.slice(0, idx)
          const toolShort = rest.slice(idx + 2)
          const serverRow = all.find((r) => r.id === 'mcp:' + server)
          if (serverRow !== undefined && toolShort.length > 0) {
            const full = 'mcp__' + server + '__' + toolShort
            const hit = (serverRow.tools ?? []).filter((t) => t === full)
            if (hit.length > 0) { row = serverRow; pickOne = hit }
          }
        }
        if (row === undefined) { unknown.push(id); continue }
        // 组合外的插件一律拒绝加载：这就是"这个作用域只能用这个组合"的执法点。
        // **MCP 例外**：它不由组合管辖（启停归 MCP 面板），所以随时可以按服务器加载。
        if (!id.startsWith('mcp:') && !visible.some((r) => r.id === id)) { blocked.push(id); continue }
        let count = 0
        const groupTools = []
        for (const toolName of (pickOne ?? row.tools)) {
          if (!state.known.has(toolName)) continue
          state.loaded.add(toolName)
          groupTools.push(toolName)
          count += 1
        }
        /* 工具级加载：整服务器那组里只保留这一个工具（避免 LRU 错卸整组）。 */
        if (pickOne !== null && Array.isArray(state.loadedGroups)) {
          for (const g of state.loadedGroups) {
            if (g.id === row.id && Array.isArray(g.tools)) {
              g.tools = g.tools.filter((n) => !pickOne.includes(n))
              g.tokens = g.tools.reduce((sum, name) => sum + toolTokensOf(name), 0)
            }
          }
          state.loadedGroups = state.loadedGroups.filter((g) => g.tools.length > 0)
        }
        /* 记"整组"：超预算时按 LRU 整组卸（见 enforceResidentBudget）。同一 id 再加载就覆盖旧记录。 */
        if (Array.isArray(state.loadedGroups)) {
          state.loadedGroups = state.loadedGroups.filter((g) => g.id !== id)
        } else {
          state.loadedGroups = []
        }
        state.loadedGroups.push({
          id,
          tools: groupTools,
          tokens: groupTools.reduce((sum, name) => sum + toolTokensOf(name), 0),
          at: Date.now(),
        })
        enabled.push(`${id} → ${count} 个工具`)
        loadedThisCall.push(...groupTools)
      }

      /* 自适应闸门：常驻量超预算就卸最早的整组（否则模型每加载一组就永久多占一段上下文）。 */
      let evicted = []
      try { evicted = enforceResidentBudget(state) } catch { evicted = [] }

      let note
      try {
        const result = applyToolRestriction(ctx, agent, state)
        note = result.reason === 'no-scope'
          ? '⚠️ 当前作用域拿不到 tools 服务，本次未生效'
          : `常驻工具数（含已加载）= ${toolResidentBase() + state.loaded.size}`
      } catch (error) {
        note = `⚠️ 重算限制失败，下一步会重试：${error?.message ?? error}`
      }

      const lines = [
        `enabled(${enabled.length}): ${enabled.join(', ') || '(none)'}`,
        `next step resident = ${toolResidentBase() + state.loaded.size} tools   ${note}`,
        `resident budget = ${residentTokens(state)} / ${RESIDENT_BUDGET_TOKENS} tokens`,
      ]
      /* CACHE_SAFE：把本次加载的工具定义**随返回值**交给模型。
       *
       * 为什么必须在这里给：打开开关后 tools 数组恒定不变（这是"不破前缀"的前提），
       * 所以工具定义不能靠"进 tools 数组"到达模型 ⇒ 只能作为本次 tool_result 的内容。
       * 这段文本**只出现在这一次返回值里**，不会进常驻前缀 ⇒ 不影响缓存。
       *
       * 模型据此即可按名字发起 tool_call（工具仍注册在宿主注册表里，照常可执行）。 */
      if (CACHE_SAFE && loadedThisCall.length > 0) {
        try {
          const allSchemas = serviceOf(ctx, 'tools')?.schemas?.() ?? []
          const wanted = new Set(loadedThisCall)
          const picked = Array.isArray(allSchemas) ? allSchemas.filter((s) => wanted.has(s?.name)) : []
          lines.push(
            '',
            `[tool definitions] 以下 ${picked.length} 个工具已可用。`,
            '它们**不在** tools 列表里（为保持提示词前缀稳定、不打断缓存），但你随时可以直接调用：',
            '按下面的名字和参数发起 tool_call 即可，执行不受影响。',
          )
          for (const s of picked) {
            let params = '{}'
            try { params = JSON.stringify(s?.parameters ?? {}) } catch { params = '(unserializable)' }
            const desc = String(s?.description ?? '').replace(/\s+/g, ' ').slice(0, 400)
            lines.push(`\n- ${s.name}\n  ${desc}\n  parameters: ${params}`)
          }
        } catch (error) {
          lines.push('', `⚠️ 工具定义渲染失败（本次仍可按上面列出的名字直接调用）：${error?.message ?? error}`)
        }
      }
      /* **代价提示**。
       *
       * 为什么加（实测结论，见 `裁定-压缩缓存与 load_plugin 代价` 文档）：
       *   本插件的 `maskAssemblyTools` 把 `state.loaded` 放进 allow 集合
       *   ⇒ 每次加载新插件，发给 provider 的 `tools` 数组就**变了**
       *   ⇒ DeepSeek 的前缀缓存**从 tools 段起失效**（tools 之后的全部 messages 也一起失效）。
       *
       *   实测（探针统计 118 个会话）：
       *     · 「load_plugin 之后第一步」的未命中平均 **326,939 tok**，是全体平均（7,701）的 **42.46 倍**
       *     · 17 次里 **14 次**之后第一步未命中 ≥ 50,000（82.4%）
       *     · 有 load 的步（101）平均 52,922 vs 无 load 的步（34,487）平均 7,567 ⇒ **7.0 倍**
       *
       *   这是**纯损失**（没有任何质量收益）⇒ 值得显式告知，并给出唯一的无损缓解手段：**一次加载多个**。
       *   （那条"一次加载两个只要 965 tok"的样本数只有 1，不当作规律，只当作方向性支持。）
       *
       *   文案只在**真的加载了东西**时出现，且是**返回值**（一次性），不进常驻前缀。
       */
      if (enabled.length > 0) {
        lines.push(
          '',
          '⚡ 代价提示（本机实测）：每加载一个新插件，发给模型服务商的 tools 列表就变了，'
          + '前缀缓存会从 tools 那一段起失效（后面所有消息一起失效）。实测"加载后第一步"的未命中平均 '
          + '326,939 tokens（全体平均 7,701 的 42 倍）。⇒ **尽量一次把要用的都加载了**'
          + '（一次只失效一次），别隔几步加载一个。',
        )
      }
      if (evicted.length > 0) {
        lines.push(
          '',
          `evicted(${evicted.length}) —— 常驻超预算(${RESIDENT_BUDGET_TOKENS} tokens)，按最近最少使用卸下：`,
          `  ${evicted.map((g) => `${g.id}（${g.tools.length} 个工具 ≈${g.tokens} tokens）`).join('、')}`,
          ' 它们仍可随时用 load_plugin 重新加载。',
        )
        toolDietNote(
          `工具按需加载：常驻预算 ${RESIDENT_BUDGET_TOKENS} tokens 已满 ⇒ 卸下 ${evicted.length} 组：`
          + evicted.map((g) => g.id).join('、'),
        )
      }
      /* 补充说明：卸完**仍然超预算** = "单组自己就超预算"这个已知边界。
         以前这里什么都不说，于是"预算 10000、实际 3 万"能静默存在很久 ——
         模型与人都看不出"常驻量已经不受预算管了"。现在明确告知，并给可执行的两条出路。 */
      const over = residentOverBudget(state)
      if (over > 0) {
        lines.push(
          '',
          `⚠️ 常驻**仍超预算 ${over} tokens**（现在 ${residentTokens(state)} / 上限 ${RESIDENT_BUDGET_TOKENS}）：`
          + '这一组自己就超过了上限，按"最近最少使用"没有更早的组可卸 ⇒ 它会一直常驻到你再加载下一组、或本会话结束。'
          + '如果这组用完了：加载任意另一组即可把它挤掉，或告诉用户把预算调小（DSH_COMPOSER_RESIDENT_BUDGET）。',
        )
        noteOnce(
          `tool-resident-over-budget:${over > 20000 ? 'gt20k' : 'gt0'}`,
          `工具按需加载：单组即超预算（${residentTokens(state)} > ${RESIDENT_BUDGET_TOKENS} tokens，超 ${over}）`
          + ' —— 无更早的组可卸，已明确告知模型（不让"预算失效"静默存在）',
        )
      }
      if (blocked.length > 0) {
        lines.push(
          '',
          `blocked(${blocked.length}) —— 不在当前组合的可见范围内，拒绝加载（插件本身仍在运行）：`,
          `  ${blocked.join(', ')}`,
        )
      }
      if (unknown.length > 0) {
        lines.push('', `unknown(${unknown.length}): ${unknown.join(', ')}`)
        const knownIds = new Set(all.map((r) => r.id))
        for (const id of unknown) {
          const near = nearestToolNames(id, knownIds)
          if (near.length > 0) lines.push(`  "${id}" 的相近插件: ${near.join(', ')}`)
        }
      }
      return { report: lines.join('\n') }
    },
  }
}

/**
 * 插件目录段落在系统提示里的排序位置。
 *
 * 取值落在「工具类段落（≤2900）之后、TOOLS_SDK(5000) 之前」，跟其它能力目录同区。
 * 排序是 `order` 升序、同值按名字，所以撞号也不会出错。
 */
const PLUGIN_CATALOG_ORDER = 3450

/** 每个 agent 当前挂着的目录段落：`agent -> { text, disposer }`。 */
const catalogSections = new WeakMap()

/**
 * 全局目录段落的文本提供者（根治「目录闪没」）。
 * 由 applyCatalogPrompt 每次调用时刷新成当前实现（一直是 pluginCatalogPromptText）。
 */
let catalogTextProvider = null

/** 全局目录段落是否已挂上（只挂一次，之后永不撤销重挂 ⇒ 位置恒定）。 */
let catalogGlobalMounted = false

/**
 * P0-13：目录挂载的健康态。
 *
 * 为什么要有它：目录挂不上时，以前**只有本地 noteOnce**，模型那边一无所知 ——
 * 它会以为插件不存在（危险：被问"能不能用 docker"时，模型可能答"没有这个能力"）。
 * 现在把"最后一次挂载的结果"记下来，由全局段落的文本函数在降级时**告诉模型**。
 *
 * 说明：这是**全局健康态**（不是 per-agent）—— 只用于"要不要告诉模型目录不可用"，
 * 不做任何写入决策，所以最后写入者胜出是可接受的。
 */
let catalogMount = { ok: false, reason: 'not-attempted', at: 0 }

/** 兜底文案是否启用（安全阀：DSH_COMPOSER_CATALOG_FALLBACK=0 恢复旧行为）。 */
const CATALOG_FALLBACK_ENABLED = process.env.DSH_COMPOSER_CATALOG_FALLBACK !== '0'

/**
 * P0-13：目录不可用时给模型的**有界**兜底段落。
 * 刻意写短（约 200 字符），并且只讲"怎么补救"，不讲内部实现。
 * @param reason - 失败原因（短标识，来自各降级路径）。
 * @returns 兜底段落文本；关闭兜底时返回空串（= 旧行为）。
 */
function catalogFallbackText(reason) {
  if (!CATALOG_FALLBACK_ENABLED) return ''
  const why = typeof reason === 'string' && reason.length > 0 ? reason : 'unknown'
  return [
    '# 插件目录不可用（组合器降级中）',
    '',
    '本次会话的**插件目录没有挂上**（原因：' + why + '）。你**看不到**插件名单，但这不代表插件不存在。',
    '要拿某个能力：先用 search_plugins({ query }) 按关键词搜插件，再用 load_plugin({ ids: [...] }) 把它的工具调进来。',
    '在搜过之前，**不要**告诉用户某个能力不存在。',
  ].join('\n')
}

/* 「配置文件入口」—— 根治"环境变量读不到"（读 README「坑 3」）。
 *
 * 病灶（实测）：常驻清单被同步进了 User 级环境变量 `DSH_COMPOSER_EXTRA_TOOLS`，
 *   但 **DSH 由 explorer 拉起，继承的是 explorer 启动时的环境快照** ⇒
 *   **新设的 User 变量读不到**（必须"注销重登 Windows"才生效）。
 *   表现：`market_snapshot` 明明"已常驻"，实际却被 `progressive-gate` 拦下 ——
 *   因为进程里那个变量是空的。
 *
 * 解法：除了环境变量，再支持**两个文件来源**（按优先级合并、去重）：
 *   ① `<DSH_HOME>\.composer-resident-tools`   ← 推荐，不依赖环境、不依赖 cwd
 *   ② `$DSH_COMPOSER_RESIDENT_FILE` 指向的任意文件（想放哪放哪）
 * 两者都按 `resident-tools.txt` 的语法解析：一行一个工具名，`#` 开头是注释。
 *
 * ⇒ 以后改常驻清单**只要改文件 + 重启 DSH**，不用注销、不用碰环境变量。
 */
function readResidentToolsFromFile(filePath) {
  try {
    if (typeof filePath !== 'string' || filePath.length === 0) return []
    if (!existsSync(filePath)) return []
    const out = []
    for (const line of String(readFileSync(filePath, 'utf8')).split(/\r?\n/)) {
      const token = line.trim()
      if (token === '' || token.startsWith('#')) continue
      if (!out.includes(token)) out.push(token)
    }
    return out
  } catch {
    return []
  }
}

/** 汇总所有**文件来源**的常驻工具名（去重、保持出现顺序）。 */
function residentToolsFromFiles() {
  const candidates = []
  try {
    candidates.push(join(resolveDshHome(), '.composer-resident-tools'))
  } catch { /* 解析不出 DSH_HOME 就跳过，不影响环境变量那条路 */ }
  const explicit = process.env.DSH_COMPOSER_RESIDENT_FILE
  if (typeof explicit === 'string' && explicit.length > 0) candidates.push(explicit)
  const out = []
  for (const candidate of candidates) {
    for (const name of readResidentToolsFromFile(candidate)) {
      if (!out.includes(name)) out.push(name)
    }
  }
  return out
}

const FILE_RESIDENT_TOOLS = residentToolsFromFiles()

/**
 * P0-9：**额外常驻**的工具名（防弱模型降质 / 少走 meta 工具）。
 *
 * 实测澄清：TOOL_CORE 已经包含全部必要工具（read/write/edit/glob/grep/
 * pwsh/ask_user_question/present/todo_write/skill/subagent/jobs/goal/web/image/lint），
 * 所以"弱模型不会用 meta 工具"这一条**本来就已经被设计缓解**——核心工作不依赖 load_plugin。
 * 这个口子只是给"想再常驻几个插件工具"的场景：
 *   DSH_COMPOSER_EXTRA_TOOLS=codegraph_explore,docker_ps
 * 默认空 ⇒ 与今天逐字节相同。
 *
 * **改成环境变量 + 文件两来源合并**（见上面 readResidentToolsFromFile 的注释）。
 */
const EXTRA_RESIDENT_TOOLS = new Set([
  ...String(process.env.DSH_COMPOSER_EXTRA_TOOLS ?? '')
    .split(',').map((s) => s.trim()).filter((s) => s.length > 0),
  ...FILE_RESIDENT_TOOLS,
])

/* 只在"真的从文件读到了东西"时才打一行 —— 便于排查"常驻没生效"。
   （用 stderr 直写，不依赖闭包里的 toolDietNote。） */
if (FILE_RESIDENT_TOOLS.length > 0) {
  try {
    process.stderr.write(`[composer] 常驻工具：从配置文件读到 ${FILE_RESIDENT_TOOLS.length} 个（${FILE_RESIDENT_TOOLS.slice(0, 8).join(', ')}${FILE_RESIDENT_TOOLS.length > 8 ? ' …' : ''}）\n`)
  } catch { /* ignore */ }
}

/* 第②步：**自适应常驻**（方案 B = 全自动 + 排除名单）
 *
 * 要解决的问题
 * 卡片插件按**工具名**注册 slot（`{name:'tool.call.toolview', key:<工具名>}`）；
 * 而模型走中转（`invoke_tool`）时，会话流里的调用名是 `invoke_tool` ⇒ 匹配不上
 * ⇒ **卡片静默不渲染**。把这些工具**常驻**，模型就会原生直调 ⇒ 卡片正常。
 *
 * 为什么必须"客户端上报"而不是"扫源码"
 * `@dsh-trading/client-chart` 写的是 `CHART_TOOLS.map(key => slots.register(…))`
 * —— 工具名来自变量，**宿主侧静态扫不出来**。只有**客户端运行时注册表**是真相。
 * 实测：`slots.entries('tool.call.toolview')` 一次报回 21 个 key。
 *
 * 写在哪
 * `<DSH_HOME>\.composer-resident-tools` 的**自动区**（`AUTO_BEGIN` 之后）。
 * **手写区一个字都不碰** —— 手写的注释、排版、顺序原样保留。
 *
 * 过滤规则（三挡）
 *   ① 手写区已有的 ⇒ 不重复写
 *   ② 排除名单（默认 `cordis_*` 那 4 个开发工具 + 可用
 *      `DSH_COMPOSER_RESIDENT_EXCLUDE` 追加）⇒ 不写
 *   ③ 本来就在 `TOOL_CORE` / `TOOL_META` / `TOOL_RESERVED` 里的 ⇒ 不写（它们已常驻）
 *
 * 安全性
 * 只写文件、**不改任何运行时行为**；且**下次重启才生效** ⇒ 不会中途改工具面、不破前缀。
 * 全程 try/catch；出错只打一行 note，不影响 `/state`。 */
const AUTO_BEGIN = '# ═══ 以下由 composer 自动维护（自动区，勿手改）═══'
/**
 * 从"写死 4 个 cordis 工具名"改成**前缀模式**。
 *
 * `cordis_*` 是 dsh-cordis 插件族（`cordis_define` / `cordis_run` / `cordis_stop` /
 * `cordis_undefine`，将来可能还有别的）。写死名单的毛病：插件新增工具时漏掉
 * ⇒ 它们被"自动常驻" ⇒ 白占上下文。
 * 现在：默认排除**任何以这些前缀开头**的工具名（是"模式"，不是"名单"）。
 * 精确名单仍然支持 —— 来自 `DSH_COMPOSER_RESIDENT_EXCLUDE` 环境变量。
 */
const AUTO_EXCLUDE_PATTERNS = ['cordis_']
/** 精确排除名单（环境变量给的）。 */
function autoExcludeExact() {
  return String(process.env.DSH_COMPOSER_RESIDENT_EXCLUDE ?? '')
    .split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}
/** 是否属于"自动排除"（前缀模式 ∪ 精确名单）。 */
function isAutoExcludedTool(name) {
  const n = String(name ?? '')
  if (n === '') return false
  for (const p of AUTO_EXCLUDE_PATTERNS) if (n.startsWith(p)) return true
  return autoExcludeExact().includes(n)
}

function syncAutoResidentTools(reportedKeys, knownNames) {
  try {
    const file = join(resolveDshHome(), '.composer-resident-tools')
    let raw = ''
    try {
      if (existsSync(file)) raw = readFileSync(file, 'utf8')
    } catch { raw = '' }

    /* 剥掉旧的自动区，留下手写的部分（含全部注释与空行）。 */
    const cut = raw.indexOf(AUTO_BEGIN)
    const manual = (cut >= 0 ? raw.slice(0, cut) : raw).replace(/\s+$/, '')

    const manualNames = new Set()
    for (const line of manual.split(/\r?\n/)) {
      const token = line.trim()
      if (token === '' || token.startsWith('#')) continue
      manualNames.add(token)
    }

    const auto = []
    for (const candidate of reportedKeys) {
      const toolName = String(candidate ?? '').trim()
      if (toolName === '') continue
      if (manualNames.has(toolName)) continue
      /* 改为"前缀模式 ∪ 精确名单"（见 AUTO_EXCLUDE_PATTERNS 的注释）。 */
      if (isAutoExcludedTool(toolName)) continue
      if (TOOL_CORE.has(toolName) || TOOL_META.has(toolName) || TOOL_RESERVED.has(toolName)) continue
      /* 选项 3：**写前校验真名** ——
         只写"宿主注册表里真实存在"的工具。否则会写进 `bash` 这类
         "跨平台占位 key"（当前机器的核心工具叫 `pwsh`，根本没有 `bash`），
         虽然无害（匹配不到会被忽略），但属噪音，而且会误导以后读文件的人。
         `knownNames` 为 undefined 时（理论不会）跳过校验，保证 fail-open。 */
      if (knownNames instanceof Set && !knownNames.has(toolName)) {
        noteOnce(
          `auto-resident-skip:${toolName}`,
          `常驻工具：自动区跳过「${toolName}」—— 它有卡片注册，但**宿主注册表里没有这个工具**（多半是跨平台占位名）`,
        )
        continue
      }
      if (!auto.includes(toolName)) auto.push(toolName)
    }
    auto.sort()

    const next = `${manual}\n\n${AUTO_BEGIN}\n`
      + '# 来源：客户端上报的 tool.call.toolview 注册 key（自动过滤：手写区已有 / 排除名单 / 核心与元工具）\n'
      + `# 更新：${new Date().toISOString()}\n`
      + (auto.length > 0 ? `${auto.join('\n')}\n` : '# （本次没有需要自动常驻的工具）\n')

    if (next === raw) return
    writeFileSync(file, next, 'utf8')
    noteOnce(
      `auto-resident:${auto.join(',')}`,
      `常驻工具：自动区已更新 —— ${auto.length} 个（${auto.join(', ') || '无'}）· 改动只写文件，**下次重启生效**`,
    )
  } catch (error) {
    noteOnce(
      `auto-resident-fail:${String(error?.message ?? error)}`,
      `常驻工具：自动区更新失败（不影响其它功能）—— ${String(error?.message ?? error)}`,
    )
  }
}

/**
 * 把插件目录挂成**全局**系统提示段落，文本按 context.agent **现算**。
 *
 * 为什么这是根治：实测每回合第一次 assemble 拿不到目录、第二次才有 ⇒ 系统提示从第
 * 15072 字符起整段变化 ⇒ 提供端前缀缓存从那里断开（实测 cacheRead 恰为 3584 token
 * ≈ 15072 字符）。根因是「按 agent 作用域注册」的 effect 在回合边界失效。全局注册 +
 * 函数式文本同时满足两件事：位置/存在性恒定（缓存友好）＋ 内容按 agent（组合语义不变）。
 *
 * @param ctx - 插件作用域 ctx（全局注册必须走它，不能走 agent.ctx）。
 * @param getPromptText - (agent) => string | null。
 * @returns 是否已由全局段落接管（true ⇒ 调用方不要再走按 agent 的老路径）。
 */
function mountCatalogSectionGlobally(ctx, getPromptText) {
  catalogTextProvider = getPromptText
  if (catalogGlobalMounted) return true
  const systemPrompt = (() => {
    const candidates = []
    try { if (typeof ctx?.get === 'function') candidates.push(ctx.get('systemPrompt')) } catch { /* 下一条 */ }
    try { if (ctx?.systemPrompt !== undefined) candidates.push(ctx.systemPrompt) } catch { /* 下一条 */ }
    for (const candidate of candidates) {
      if (candidate !== null && candidate !== undefined && typeof candidate.section === 'function') return candidate
    }
    return null
  })()
  if (systemPrompt === null) return false
  try {
    systemPrompt.section({
      name: 'capability-composer:plugin-catalog',
      order: PLUGIN_CATALOG_ORDER,
      text: (context) => {
        try {
          const t = catalogTextProvider?.(context?.agent)
          if (typeof t === 'string' && t.length > 0) {
            /* P0-13：目录算出来了 ⇒ 记健康态（下次失败时才有东西可比）。 */
            catalogMount = { ok: true, reason: null, at: Date.now() }
            return t
          }
          /* P0-13：算出来是空 ⇒ 告诉模型目录不可用，而不是让它以为插件不存在。 */
          return catalogFallbackText(catalogMount.ok ? 'empty-catalog' : (catalogMount.reason ?? 'empty-catalog'))
        } catch {
          /* P0-13：抛错也照样让模型知道（官方 renderPrompt 会丢掉空段落，所以给兜底串）。 */
          return catalogFallbackText('provider-threw')
        }
      },
    })
    catalogGlobalMounted = true
    toolDietNote('插件目录：已改成**全局一处**的系统提示段落（函数式取文本）—— 每回合第一步就有，不再闪没')
    return true
  } catch (error) {
    noteOnce('catalog-global-mount-fail:' + String(error?.message ?? error), '插件目录：全局挂载失败 ⇒ 退回按 agent 挂载 —— ' + String(error?.message ?? error))
    return false
  }
}

/**
 * 把插件目录注册进**这个 agent 自己作用域**的系统提示。
 *
 * 为什么必须走 `agent.ctx` 而不是模块级 ctx：目录内容取决于**该 agent 的工作区/会话
 * 命中哪个组合**，全局注册会让所有会话看到同一份 —— 那就等于没有组合。
 * （`dsh-system-prompt` 的 NamedEntries 在每个作用域里按名字去重，重复注册会抛，
 *   所以这里按 agent 存住 disposer，文本变了先撤旧的再挂新的。）
 *
 * @param agent - 当前 agent。
 * @param getPromptText - `(agent) => string | null`，由 applyInner 提供。
 */
function applyCatalogPrompt(agent, getPromptText, fallbackCtx) {
  if (agent === undefined || agent === null) {
    catalogMount = { ok: false, reason: 'no-agent', at: Date.now() }
    noteOnce('catalog-no-agent', '插件目录：没有 agent 作用域 ⇒ 这一步没挂目录')
    return
  }
  let text
  try {
    text = getPromptText(agent)
  } catch (error) {
    catalogMount = { ok: false, reason: 'text-throw', at: Date.now() }
    noteOnce(`catalog-text-throw:${error?.message ?? error}`, `插件目录：算目录文本时抛错 ⇒ 这一步没挂目录 —— ${error?.message ?? error}`)
    return
  }
  if (typeof text !== 'string' || text.length === 0) {
    /* 目录是**空**的 = 路线二只剩"工具被隐藏"，模型连插件目录都看不到 ⇒ 必须留证据。 */
    catalogMount = { ok: false, reason: 'empty-catalog', at: Date.now() }
    noteOnce('catalog-empty', '插件目录：文本为空 ⇒ 这一步**没挂目录**（模型只能靠 search_plugins 摸黑找）')
    return
  }
  const previous = catalogSections.get(agent)
  if (previous !== undefined && previous.text === text) return // 没变，不动它
  /* 全局一处 + 函数式文本。成功即接管，老路径原样留着做兜底。 */
  if (mountCatalogSectionGlobally(fallbackCtx, getPromptText)) return
  const agentCtx = agent.ctx
  if (agentCtx === undefined || agentCtx === null) {
    catalogMount = { ok: false, reason: 'no-agent-ctx', at: Date.now() }
    noteOnce('catalog-no-ctx', '插件目录：agent 没有 ctx ⇒ 这一步没挂目录')
    return
  }
  /**
   * 实测怀疑：目录**可能根本没挂进系统提示** ——
   *   换组合（25 行 vs 56 行）之后，两个新会话的 systemTokens **一模一样（4224）**；
   *   而 56 行目录本身就有 ~5.8k tokens，真挂上不可能一样。
   *   原因很可能是这里拿服务的路径太窄（只试 `agentCtx.get('systemPrompt')`），
   *   而且拿不到时**静默 return**（自己定的"不许静默"规矩又犯了一次）。
   * ⇒ 现在三条路都试，并且**挂上/没挂上都写字**。
   */
  const systemPrompt = (() => {
    const candidates = []
    try { if (typeof agentCtx.get === 'function') candidates.push(agentCtx.get('systemPrompt')) } catch { /* 下一条 */ }
    try { if (agentCtx.systemPrompt !== undefined) candidates.push(agentCtx.systemPrompt) } catch { /* 下一条 */ }
    try { if (fallbackCtx?.systemPrompt !== undefined) candidates.push(fallbackCtx.systemPrompt) } catch { /* 下一条 */ }
    for (const candidate of candidates) {
      if (candidate !== null && candidate !== undefined && typeof candidate.section === 'function') return candidate
    }
    return null
  })()
  if (systemPrompt === null) {
    catalogMount = { ok: false, reason: 'no-systemprompt', at: Date.now() }
    noteOnce(
      'catalog-no-systemprompt',
      '插件目录：拿不到 systemPrompt 服务 ⇒ 这一步**没挂目录**（模型看不到插件名单，只能靠 search_plugins 摸黑找）',
    )
    return
  }
  try {
    if (previous !== undefined) previous.disposer?.()
  } catch {
    // 撤旧的失败就继续挂新的；真重名会在下面抛，被 catch 掉
  }
  try {
    const disposer = systemPrompt.section({
      name: 'capability-composer:plugin-catalog',
      order: PLUGIN_CATALOG_ORDER,
      text,
    })
    catalogSections.set(agent, { text, disposer })
    /* 证据行：目录**确实挂上了**，写清楚多长（免得"没挂"和"挂了但很小"分不清）。 */
    toolDietNote(`插件目录：已挂进系统提示（${text.split('\n').filter((l) => l.startsWith('- ')).length} 行 / ${text.length} 字符）`)
  } catch (error) {
    catalogMount = { ok: false, reason: 'section-fail', at: Date.now() }
    noteOnce(`catalog-section-fail:${error?.message ?? error}`, `插件目录：挂系统提示段落失败 ⇒ 这一步没挂目录 —— ${error?.message ?? error}`)
  }
}

/**
 * 挂上路线二的三件事：注册两个元工具、每次 pre-step 前刷新限制。
 *
 * 实测教训：本插件 `inject` 只声明了 `skills`，所以在 apply 那一刻
 * `ctx.get('tools')` **可能还没注册**（tools 由 base bundle 提供，加载顺序不定）。
 * 原来这种情况直接 return ⇒ 路线二**永远不会挂上**；而那条降级只写了
 * `ctx.logger.warn`，**INFO/WARN 都不进 harness.log** ⇒ 表现成"插件在跑但一点没省"，
 * 完全查不出来（日志里只有技能那一半的 `[composer]` 行，我还瞎猜了一整天）。
 * ⇒ 改成**延迟注册**：apply 时拿不到就在首次 pre-step 再试（那时 tools 必然在），
 *   并且降级路径也写 stderr。
 *
 * 单独包一层：工具这一半失败**不能**连累技能/插件那两半。
 */
function applyToolDiet(ctx, getScopeGlobs, refresh, onScope, pluginsOf, getAllPlugins, getPromptText) {
  let registered = false
  let deferredNoted = false
  let guardMounted = false

  /** 尽力注册两个元工具；返回是否已注册。 */
  function ensureRegistered() {
    if (registered) return true
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      if (!deferredNoted) {
        deferredNoted = true
        toolDietNote('工具按需加载：apply 时拿不到 tools 服务 ⇒ 改为延迟注册（首次 pre-step 再试）')
      }
      return false
    }
    try {
      tools.register(makeSearchPluginsDefinition(ctx, pluginsOf, getAllPlugins))
      tools.register(makeLoadPluginsDefinition(ctx, pluginsOf, getAllPlugins))
      /* 注册 `invoke_tool` —— 让模型能调用"不在 tools 列表里"的
         长尾工具（MCP / 插件），从而 tools 数组可以恒定不变、前缀缓存不被打破。
         见 makeInvokeToolDefinition 的长注释：执行时不传 agent ⇒ 绕过 agent 级 restrict。 */
      tools.register(makeInvokeToolDefinition(ctx))
      /* 两段式发现（抄自 dsh-progressive-tools）。
         只有开关打开时才注册 ⇒ 关着时工具面与之前完全一致。 */
      if (TOOL_SEARCH_ENABLED) {
        tools.register(makeSearchToolsDefinition(ctx))
        tools.register(makeDescribeToolsDefinition(ctx))
      }
      /* monotonic guard（抄自 router-progressive）——
         必须在这里挂：`apply` 执行时 tools 服务还没就绪（本函数就是为此才"延迟注册"的）。 */
      if (process.env.DSH_COMPOSER_GUARD !== '0' && typeof tools.guard === 'function' && !guardMounted) {
        guardMounted = true
        tools.guard((execution) => {
          const guardedName = execution?.name
          if (typeof guardedName !== 'string' || guardedName.length === 0) return undefined
          /* 中转自己发出的嵌套调用 ⇒ 放行（否则会把 invoke_tool 拦死）。 */
          if (typeof execution?.callId === 'string' && execution.callId.includes(':invoke:')) return undefined
          /* 没有 agent 的调用（系统内部 / 后台任务）⇒ 放行。 */
          if (execution?.agent === undefined || execution.agent === null) return undefined
          /* 常驻白名单里的 ⇒ 放行。 */
          if (TOOL_CORE.has(guardedName) || TOOL_META.has(guardedName) || TOOL_RESERVED.has(guardedName)) return undefined
          if (isProtectedTool(guardedName)) return undefined
          /* 其余 = 模型直调长尾工具 ⇒ 把原因说清楚，并指向正确通道。 */
          return 'progressive-gate：「' + guardedName + '」不在常驻工具列表里'
            + '（长尾工具默认不常驻，以保持提示词前缀缓存稳定）。'
            + '请改用 invoke_tool({ tool: "' + guardedName + '", args: {...} }) 调用它 —— 执行完全不受影响。'
        })
        toolDietNote('工具按需加载：已挂 monotonic guard —— 直调长尾工具会得到明确原因（指向 invoke_tool）')
      }
    } catch (error) {
      noteOnce(
        `tool-register-fail:${error?.message ?? error}`,
        `工具按需加载：注册元工具失败 ⇒ 本半不生效 —— ${error?.message ?? error}`,
      )
      return false
    }
    registered = true
    toolDietNote(
      `工具按需加载已挂载：常驻白名单 ${TOOL_CORE.size} 个 + 元工具 ${TOOL_META.size} 个（其余全部按需；组合只决定可见范围）`,
    )
    return true
  }

  /* 开关打开时，把两个新元工具纳入「常驻白名单」——
     它们必须常驻（否则模型看不到、也就不会去用）。
     关着时一个都不加 ⇒ 工具面与之前完全一致（核心 28 + 元 3 = 31）。 */
  if (TOOL_SEARCH_ENABLED) {
    TOOL_META.add('search_tools')
    TOOL_META.add('describe_tools')
  }

  ensureRegistered()

  /* monotonic guard（抄自 router-progressive + dsh-progressive-tools）
   * 已移到上面的 `ensureRegistered()` 里挂载 —— 因为 `apply` 执行时 tools 服务还没就绪。
   * 逻辑与行为见那里的注释。 */

  /**
   * 组装期兜底（这是"首轮也一定生效"的那道闸门）
   *
   * 为什么必须在**这里**再压一次：`agent/pre-step` 里施加的 `tools.restrict()`
   * 走的是作用域层（`dsh-tools` 的 `view(scope)`）。实测（读会话存档的真账）：
   *   · 老会话（我这轮）：真实请求头 = 30 个工具 / 6,757 tokens ⇒ 生效 ✓
   *   · **全 新 会 话 的第一轮**：真实请求头 = 201 个工具 / 38,156 tokens ⇒ 逃逸 ✗
   * 也就是说限制"晚了半拍"，第一轮组装时还没落在这一轮用的作用域上。
   *
   * 而 `system-prompt/assemble` 是宿主的**瀑布**（`dsh-system-prompt/lib/index.js:351`：
   * `const transformed = await this.ctx.waterfall(…, assembly, context, …)`，
   * 真正的请求头就是拿这个返回值里的 `tools` 去 `buildRequest` 的）。
   * ⇒ 在这里按白名单**直接过滤 `assembly.tools`**，就不再依赖作用域语义和时机：
   *    每一次组装（包括第一轮）都会过这一刀。
   *
   * 保留 pre-step 的 restrict 是**双保险**（它同时管住"看不见"和"不能调"）。
   */
  /**
   * 工具名 → 认领它的**插件包名**（来自插件扫描）。
   *
   * 用途只有一个：**别把系统自己的东西一起屏蔽掉**（即：
   * 「会不会把系统必须要加载的工具也弄没了？是不是限制得太猛了？」）。
   *   ① 包名以 `@deepseek-ai/` 开头 ⇒ 宿主自带 ⇒ **永不屏蔽**；
   *   ② 谁也认领不了（扫描里没有）⇒ 来历不明 ⇒ 也**不屏蔽**（宁可多留一个，也不误伤）。
   * 只有"能确定是某个第三方插件注册的、而且这个插件不在当前组合里"才真正删掉。
   * 这样以后 DSH 自己新增任何内置工具，都不会被本插件的白名单挡在外面。
   */
  let ownerMapCache = null
  let ownerMapKey = ''
  function toolOwnerMap() {
    let rows = []
    try {
      /* **这里原来写 `pluginCatalogAll()`，而它不在本作用域**
       *   （`pluginCatalogAll` 是 `apply()` 里的函数，`applyToolDiet` 内**不可见**）
       *   ⇒ 每次抛 `ReferenceError` ⇒ 被 `catch { rows = [] }` **静默吞掉**
       *   ⇒ `rows` 恒为 `[]` ⇒ `ownerMap` 恒为空 Map ⇒ `isProtectedTool(name)` **恒返回 false**
       *   ⇒ 注释承诺的「`@deepseek-ai/*` 宿主自带工具永不被屏蔽」**从未生效**。
       *
       *   为什么一直没被发现：`agent/pre-step` 那条日志恰好写着
       *   「其中系统自带/来历不明 **0** 个是放行的」—— 0 被当成"本来就没有"，而不是"这条路坏了"。
       *
       *   修法：改用**参数** `getAllPlugins()`（`applyToolDiet` 的第 6 个形参，指向同一份目录）。
       *   与 `maskAssemblySections` 那个 bug 是**同一类**（引用不在作用域的标识符 + catch 吞掉），
       *   由新门禁 `G-15`（TS2304 no-undef 静态检查）抓出。
       */
      rows = getAllPlugins()
    } catch (error) {
      noteOnce(
        'tool-owner:noall',
        `工具归属：拿不到插件目录（getAllPlugins 抛错）⇒ 本次按"谁也认领不了"处理（受保护工具不会特殊放行）—— ${error?.message ?? error}`,
      )
      rows = []
    }
    const key = rows.length + ':' + toolCatalog.names.size
    if (ownerMapCache !== null && ownerMapKey === key) return ownerMapCache
    const map = new Map()
    for (const row of rows) {
      const pkg = String(row.pkg ?? '')
      for (const name of row.tools ?? []) if (!map.has(name)) map.set(name, pkg)
    }
    ownerMapCache = map
    ownerMapKey = key
    return map
  }
  /** 这个工具是不是"不能屏蔽"的（宿主自带包注册的）。
   *
   * 只保护 `@deepseek-ai/*` 这一条，**不做**"来历不明就放行"的兜底：
   * 实测证明来历不明的名字在真机上很多（观察到的并集里大量第三方工具还没被扫描认领），
   * 一放行就等于把要省的东西又放回去了。
   * 而"系统自己必须要用的工具"全部来自 `@deepseek-ai/*` 包 —— 保护这一条就够，
   * 以后 DSH 新增任何内置工具（`@deepseek-ai/...`）都会自动留在白名单里。 */
  function isProtectedTool(name) {
    const owner = toolOwnerMap().get(name)
    if (owner === undefined || owner === '') return false
    return /^@deepseek-ai\//.test(owner)
  }

  /* 插件提示段按组合收窄（研-02 产物）
   *
   * **实测发现**：`插件组合` 只控制「工具白名单 + 插件目录」，**控制不了插件自己注册的
   * 系统提示段**。于是"当前组合里没列的插件"，它的提示段仍在每请求注入。
   *
   * 实测（会话 `session-df0a83c1`，系统提示 19,098 字符 ≈ 5,329 tok，逐块量）：
   *   · `agent-teams:usage`  ≈1,296 tok ← `dsh-agent-teams`，**不在** `开发·上下文治理` 组合
   *   · `plugin:dsh-docker`  ≈  579 tok ← `docker`，**不在**
   *   · `plugin:api-client`  ≈  254 tok ← `api-client`，**不在**
   *   ⇒ 合计 **≈2,129 tok/请求**。
   *
   * **第一版是个 silent bug（功能从未生效）。**
   *   原版在这里写 `resolveCompositionNames(state, 'plugin', agent)`，但 **`state` 在本作用域
   *   根本不存在** —— 它只在 `maskAssemblyTools` 内部有一份**局部**同名变量（`:1576`），
   *   模块顶层也没有 `state` 声明。⇒ 每次调用抛 `ReferenceError` ⇒ 被下面那个
   *   `catch { return assembly }` **静默吞掉** ⇒ 日志里既没有"生效"也没有"失败"，
   *   重启后系统提示长度只差 128 字符（预期 −8,500）。
   *
   *   教训（已写进报告 A-2）：**fail-open 的 catch 必须有证据行**，否则"没生效"和"没触发"
   *   长得一模一样；**闭包引用外层变量必须先静态确认它在同一作用域**。
   *
   * 修法：改用**已经正确的抽象** `pluginsOf(agent)` —— 它就是"当前组合里可见的插件"的
   *   权威口径（插件目录段用的是同一份），返回 `row[]`，`row.id` 即插件 id。
   *   语义天然正确：**组合未设 ⇒ pluginsOf 返回全部 ⇒ 一个都不丢（fail-open）**。
   *   这样既修掉 bug，又不再依赖任何闭包 `state`。
   */
  function maskAssemblySections(agent, assembly) {
    if (assembly === null || assembly === undefined || typeof assembly !== 'object') return assembly
    if (PRUNE_PLUGIN_SECTIONS !== true) return assembly
    const sections = Array.isArray(assembly.sections) ? assembly.sections : null
    if (sections === null || sections.length === 0) return assembly
    let rows = null
    try {
      rows = pluginsOf(agent)
    } catch (error) {
      /* fail-open 但**必须留痕**（这是上一版没生效却查不出来的直接原因）。 */
      noteOnce(
        'section-prune:nofunc',
        `插件提示段按组合收窄：拿不到可见插件（pluginsOf 抛错）⇒ 本次**不裁** —— ${error?.message ?? error}`,
      )
      return assembly
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      noteOnce(
        'section-prune:empty',
        '插件提示段按组合收窄：可见插件为空 ⇒ 本次**不裁**（没有"不在组合里"的依据，宁可留着）',
      )
      return assembly
    }
    const ids = new Set()
    for (const row of rows) {
      const id = row === null || row === undefined ? undefined : row.id
      if (typeof id === 'string' && id.length > 0) ids.add(id)
    }
    /* 归属改为**运行时推导**（`inferSectionOwner`），不再查硬编码表。
       这里只报告"连推导都认不出"的段 —— 那才是真的值得人工看一眼的。
       （旧版是"不在表里就报"，装了新插件必然刷屏；现在只有 name 与插件 id
        毫无关系的段才会报。） */
    const knownIdArr = [...ids]
    for (const section of sections) {
      const name = typeof section?.name === 'string' ? section.name : ''
      if (name === '' || !name.includes(':')) continue
      if (name.startsWith(SECTION_PROTECTED_PREFIX_CONST)) continue
      if (inferSectionOwner(name, knownIdArr) !== undefined) continue
      noteOnce(
        'section-unmapped:' + name,
        '插件提示段按组合收窄：段 "' + name + '" **推导不出归属** ⇒ 保留（不裁）。'
        + '归属规则是"段名冒号前那段 与 插件 id 自动匹配（含去 dsh- 前缀、互为子串、取最长）"；'
        + '认不出通常说明该段的 name 前缀与任何插件 id 都无关。',
      )
    }
    const out = prunePluginSections(ids, assembly, knownIdArr)
    if (out.dropped.length === 0) return assembly
    const sig = out.dropped.map((d) => d.name).join(',')
    if (sectionPruneNote !== sig) {
      sectionPruneNote = sig
      toolDietNote(
        `插件提示段按组合收窄：丢掉 ${out.dropped.length} 段（≈${Math.round(out.savedBytes / 4)} tok/请求）—— `
        + out.dropped.map((d) => `${d.name}（归属 ${d.owner}，不在当前插件组合里）`).join('；')
        + '。认不出归属的段一律保留。开关：prunePluginSections（DSH_COMPOSER_PRUNE_PLUGIN_SECTIONS）。',
      )
    }
    return out.assembly
  }
  /** 上一次丢弃的段名组合（用来避免每步刷屏）。 */
  let sectionPruneNote = null

  function maskAssemblyTools(agent, assembly) {
    if (assembly === null || assembly === undefined || typeof assembly !== 'object') return assembly
    const tools = Array.isArray(assembly.tools) ? assembly.tools : null
    if (tools === null || tools.length === 0) return assembly
    let state = null
    try {
      state = toolStateFor(agent)
    } catch (error) {
      /* fail-open **必须留痕** —— 这是 silent bug 的直接教训：
         没日志时"没生效"和"没触发"长得一模一样，查了半天。 */
      noteOnce(
        'tool-diet:nostate',
        `工具按需加载：拿不到 agent 工具状态（toolStateFor 抛错）⇒ 本次**不裁工具**（全量带出去）—— ${error?.message ?? error}`,
      )
      return assembly
    }
    /* P0-9：显式要求额外常驻的工具（DSH_COMPOSER_EXTRA_TOOLS，默认空）。 */
    const allow = new Set([...TOOL_CORE, ...TOOL_META, ...loadableResidentNames(state), ...TOOL_RESERVED, ...EXTRA_RESIDENT_TOOLS])
    let protectedKept = 0
    let mcpBlocked = 0
    const kept = tools.filter((entry) => {
      const name = entry === null || entry === undefined ? undefined : (entry.name ?? entry.function?.name)
      if (typeof name !== 'string') return false
      if (allow.has(name) || TOOL_RESERVED.has(name)) return true
      /* 系统自带 / 来历不明 ⇒ 放行（见 isProtectedTool 的说明）。 */
      if (isProtectedTool(name)) { protectedKept += 1; return true }
      /* 设计前提：「MCP 一开 就是 200+ 工具，以后还会增加，所以必须走路线二，
         要用的时候才给详细定义。」——单独数出来，让这件事**看得见**。 */
      if (name.startsWith('mcp__')) mcpBlocked += 1
      return false
    })
    /* 抄自 dsh-progressive-tools 的 `autoloadMaxTools`）：
       如果要被裁掉的工具本来就不多 ⇒ 干脆**全部常驻**，让模型原生直调、
       省掉整个转发层。默认 0 = 关闭（保持现状）；建议 60~120。
       详见文件上方 AUTOLOAD_MAX 处的长注释。 */
    if (AUTOLOAD_MAX > 0 && tools.length - kept.length > 0 && tools.length - kept.length <= AUTOLOAD_MAX) {
      if (state.assemblyNote !== `autoload:${tools.length}`) {
        state.assemblyNote = `autoload:${tools.length}`
        toolDietNote(
          `工具按需加载：非常驻仅 ${tools.length - kept.length} 个 ≤ 阈值 ${AUTOLOAD_MAX}`
          + ' ⇒ **自动全部常驻**（不裁；模型原生直调，零转发开销）',
        )
      }
      return assembly
    }
    const signature = `${tools.length}->${kept.length}`
    if (kept.length !== tools.length) {
      if (state.assemblyNote !== signature) {
        state.assemblyNote = signature
        /**
         * 这里以前只写「白名单 N 个」，而 N 是**实际施加**的数
         *   （宿主不认识的名字会被剔掉，见 applyToolRestriction 里那条剔除证据行）。
         *   于是日志里出现 29 而声明是 30，被当成"账不平"。现在两个数都写出来，
         *   差额为 0 时只说一个数，省得越读越乱。
         */
        const declared = [...TOOL_CORE, ...TOOL_META]
        const grantable = declared.filter((n) => !TOOL_RESERVED.has(n)).length
        toolDietNote(
          `工具按需加载：组装期兜底生效 —— 本轮请求头工具 ${tools.length} → ${kept.length} 个`
          + `（白名单声明 ${declared.length} 个${grantable === declared.length ? '' : `（可放行 ${grantable} 个）`}`
          /* 诊断：实测 3 个调用过 load_plugin 的会话，request/header 工具数始终 30（没有 33）。
           这里把 state.loaded 的真实内容打出来 —— 一眼就能分辨是【名字与宿主注册表不一致】
           还是【restrict 时机问题】。 */
        + ` + 已加载 ${state.loaded.size}${state.loaded.size > 0 ? `（${[...state.loaded].slice(0, 6).join('、')}` + `${state.loaded.size > 6 ? ' …' : ''}）` : ''}`
          + `${protectedKept === 0 ? '' : ` + 系统自带/来历不明 ${protectedKept}`}`
          + `${mcpBlocked === 0 ? '' : `；另按路线二挡住 MCP 工具 ${mcpBlocked} 个 —— 要用时 load_plugin("mcp:<服务器>")`}）`,
        )
      }
      return { ...assembly, tools: kept }
    }
    /* 一个都没删 ⇒ 这一轮本来就是干净的。第一次见到时留一行证据，免得"没删"和"没跑"分不清。 */
    if (state.assemblyNote !== 'clean') {
      state.assemblyNote = 'clean'
      toolDietNote(
        `工具按需加载：组装期检查通过 —— 本轮请求头工具 ${tools.length} 个，全部在白名单内`
        + `（其中系统自带/来历不明 ${protectedKept} 个是放行的）`
        + `；已加载 ${state.loaded.size}${state.loaded.size > 0 ? `（${[...state.loaded].slice(0, 6).join('、')}）` : ''}`
        + `；本轮请求头工具名里含已加载的 ${[...state.loaded].filter((x) => tools.some((t) => (t?.name ?? t?.function?.name) === x)).length} 个`,
      )
    }
    /* 诊断（**默认开**；设 DSH_COMPOSER_DIAG=0 关闭）：**每次请求都打一行**，
       带 agent 编号 + 工具数 + 工具名指纹。用途：判定"tools 反复变"到底是
         ① 同一个 agent 的状态被清零（= bug），还是
         ② 多个 agent 交替、各有各的 state（= 正常，但会让前缀交替失效）。
       历史教训：`state.assemblyNote !== 'clean'` 那条日志**每个 agent 只打一次** ⇒
       光看它无法区分这两种情况（本轮为此误判过两次）。
       不用 toolDietNote（它有去重），必须用 console.error 才每次都打。 */
    /* 默认开（诊断期），定位完成后设 DSH_COMPOSER_DIAG=0 关闭。 */
    if (process.env.DSH_COMPOSER_DIAG !== '0') {
      try {
        const id = agentIdOf(agent)
        const names = tools.map((t) => String(t?.function?.name ?? t?.name ?? '?')).sort()
        console.error('[composer/diag] agent#' + id + ' tools=' + names.length
          + ' loaded=' + state.loaded.size
          + ' head=' + names.slice(0, 8).join(','))
      } catch { /* fail-open */ }
    }
    return assembly
  }

  try {
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      try {
        /* 先收工具，再收提示段（互不依赖，顺序只为可读）。 */
        return maskAssemblySections(context?.agent, maskAssemblyTools(context?.agent, assembly))
      } catch (error) {
        noteOnce(
          `assemble-mask-fail:${error?.message ?? error}`,
          `工具按需加载：组装期兜底失败（这一轮可能把全部工具带出去）—— ${error?.message ?? error}`,
        )
        return assembly
      }
    }, { prepend: true })
  } catch (error) {
    noteOnce(
      `assemble-hook-fail:${error?.message ?? error}`,
      `工具按需加载：挂不上 system-prompt/assemble ⇒ 只能靠 pre-step 的限制（新会话首轮可能逃逸）—— ${error?.message ?? error}`,
    )
  }

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      // 把「最近一次对话的会话/工作区」记下来 —— UI 要显示"当前工作区是哪个"，
      // 但那条 HTTP 接口是没有 agent 上下文的裸请求，只能靠这里捎带。
      try { onScope?.(agent) } catch { /* 记环境失败绝不能影响对话 */ }
      refresh()
      ensureRegistered()
      const state = toolStateFor(agent)
      /* 组合切换 ⇒ 回收**旧组合遗留的已加载工具**
       *
       * 约定：「如果我启用了新的组合，那旧的组合还存在的话，那这个是需要修复的 bug，
       *   要进入组合器这个插件里面的，**不仅是技能插件里组合也是一样**。」
       *
       * 技能轴由 `compactSkillCatalogSurface` 收（旧目录 → 指路牌）；
       * **插件轴就在这里收**：`state.loaded` 是模型用 `load_plugin` 显式加载进来的工具名，
       * 设计上"只增不减"（只有超预算的 LRU 会卸）⇒ 一旦切到**不含那些插件**的新组合，
       * 它们的工具仍然常驻在每一次请求的请求头里 —— 表现就是"旧组合还在生效"，
       * 白占 token，而且与"组合决定可见范围"的语义直接矛盾。
       *
       * 判据：作用域 glob 签名变了（= 生效的插件组合变了）⇒ 把**已经不在新作用域里**的
       * 已加载工具全部卸掉。幂等：签名没变时一个都不动（所以不会误伤 load_plugin 的正常使用）。
       * `globs === null`（组合未设 = 不过滤）⇒ toolInScope 恒真 ⇒ 什么都不卸，语义正确。
       */
      try {
        let scopeGlobs = null
        try { scopeGlobs = getScopeGlobs(agent) } catch { scopeGlobs = null }
        const scopeSig = scopeGlobs === null ? 'null' : JSON.stringify([...scopeGlobs].sort())
        if (state.scopeSignature !== undefined && state.scopeSignature !== scopeSig) {
          const dropped = reclaimOutOfScopeLoadedTools(state, scopeGlobs)
          if (dropped.length > 0) {
            state.allowSignature = null // 强制下一步重算白名单，别把半成品当成已生效
            state.restrictionActive = false // 同样强制重算：别让早退把"工具集已经变了"当成没变
            toolDietNote(
              `组合已切换：回收旧组合遗留的 ${dropped.length} 个已加载工具`
              + `（${dropped.slice(0, 8).join('、')}${dropped.length > 8 ? '…' : ''}）`
              + ' —— 不回收它们会一直常驻在请求头里（= 旧组合还在生效）',
            )
          }
        }
        state.scopeSignature = scopeSig
      } catch (error) {
        /* 回收失败绝不影响这一步的对话；但也不能静默（本项目契约：不许静默不生效）。 */
        noteOnce(`tool-scope-reclaim-fail:${error?.message ?? error}`, `组合切换回收旧组合工具失败（这一步沿用旧常驻集）—— ${error?.message ?? error}`)
      }
      /**
       * 「首次接管这个会话」必须留一行证据（每个会话一次）。
       *
       * 为什么：致命 bug 正是**新会话第一步静默不生效** ——
       * 只靠"失败才说话"的日志，从外面完全看不出「这个会话到底有没有被接管」。
       * 现在：每个会话第一次 pre-step 都会写明这一步是"限制"还是"不过滤"。
       */
      if (state.entered !== true) {
        state.entered = true
        let globs = null
        try { globs = getScopeGlobs(agent) } catch { globs = null }
        toolDietNote(globs === null
          ? '工具按需加载：首次接管这个会话 —— 组合未设 ⇒ **不过滤**（全部插件的工具都会进上下文）'
          : `工具按需加载：首次接管这个会话 —— 组合放行 ${globs.length} 条工具 glob`)
      }
      /* 每次 pre-step 都拿插件扫描结果垫一下目录（幂等、便宜）。
         apply 时刻扫描可能还没跑完（实测只垫到 0 个名字），漏在这里补。
         必须**先垫目录再施加限制**：deny 是照着这份目录算的。 */
      try {
        const rows = typeof getAllPlugins === 'function' ? (getAllPlugins() ?? []) : []
        const before = toolCatalog.names.size
        for (const row of rows) for (const t of row.tools ?? []) toolCatalog.names.add(t)
        if (toolCatalog.names.size !== before) {
          toolDietNote(`工具按需加载：用插件扫描垫目录 +${toolCatalog.names.size - before} 个名字 ⇒ 共 ${toolCatalog.names.size} 个`)
        }
      } catch { /* 目录拿不到不影响主流程 */ }
      /* 目录完整性证据（硬要求：工具不许"缺失"、模型不许"发现不了"）。
         这里算的是「宿主注册表 ⊆ 本插件目录」——缺一个就写 ❌（不是静默），
         齐全就写一行覆盖率，一眼就能看出这只靴子到底掉没掉。 */
      try {
        const cov = coverageReport(ctx)
        if (cov.ok === true) {
          noteOnce('coverage-ok', `工具目录覆盖率 100%：宿主注册表 ${cov.host} 个工具全部在目录里（个个可搜、可加载）`)
        } else if (cov.ok === false) {
          noteOnce(
            `coverage-miss:${cov.missing.join(',')}`,
            `❌ 工具目录缺 ${cov.missing.length} 个工具（模型**永远发现不了**它们）：${cov.missing.slice(0, 12).join('、')}`
            + `（已并入兜底行「未归属工具」⇒ 下一步起可搜可加载；若反复出现请把这一行发我）`,
          )
        }
      } catch (error) {
        /* 这里**不许静默**（我自己的规矩）：覆盖率算不出来也必须说，
           否则"没跑"和"跑通了"在日志里长得一模一样（曾踩过这个坑）。 */
        noteOnce(`coverage-calc-fail:${error?.message ?? error}`, `工具目录覆盖率：这一步算不出来 —— ${error?.message ?? error}`)
      }
      if (registered) {
        applyToolRestriction(ctx, agent, state)
        // 路线二的"目录"那一半：把**插件目录**挂进这个 agent 的系统提示。
        try {
          applyCatalogPrompt(agent, getPromptText, ctx)
        } catch (error) {
          noteOnce(`catalog-prompt-fail:${error?.message ?? error}`, `工具按需加载：插件目录没挂进系统提示 —— ${error?.message ?? error}`)
        }
      }
    } catch (error) {
      // 拿不到作用域 / 名字未知 / restrict 抛错 —— 一律降级成"这一步不限制"，
      // 绝不允许影响这一次对话。写 stderr 是为了留得下证据。
      ctx.logger?.warn?.(`[composer] 工具按需加载限制失败（本步保持原样）：${error?.message ?? error}`)
      noteOnce(
        `tool-restrict-fail:${error?.message ?? error}`,
        `工具按需加载限制失败（已降级为不限制）：${error?.message ?? error}`,
      )
    }
    return next()
  })

  /* 把元工具注册器回传给调用方（`agent/session-start` 需要它，见 applyInner 里的说明）。 */
  return { ensureRegistered }
}

//
// ④ 给组合 UI 用的受控 HTTP 通道
//
// 客户端半边在浏览器里，碰不到文件系统，所以必须由宿主半边开一条口子。
// 用的是 `@deepseek-ai/dsh-host-webserver`（官方宿主 webserver，`register({kind,path,handler})`，
// handler 是 node:http 的 `(req,res)` 且自己拥有响应）。
//
// 安全设计（这条口子能改状态文件，必须收紧）：
//   · **形状强校验**：POST 的 body 会被重建为白名单形状，任何越界字段直接丢弃/报错
//     ⇒ UI 永远写不出坏状态文件（写坏状态 = 组合失效，但不会让 DSH 起不来）
//   · 请求体有大小上限；只挂 prefix 一条路由；只读写固定的 statePath
//

/** 组合 UI 的接口前缀。 */
const API_PREFIX = '/dsh-capability-composer'
/** POST body 上限（状态文件本身只有几 KB）。 */
const API_MAX_BODY_BYTES = 256 * 1024
/** 单个列表成员上限，防呆。 */
const API_MAX_LIST = 4000

/**
 * 全局工具目录：所有 agent 观察到的并集。
 * UI 要靠它列出"世界上有哪些工具可勾选"，所以它必须是模块级、跨 agent 累积的。
 */
const toolCatalog = {
  names: new Set(),
  hints: new Map(),
  bytes: new Map(),
  /** MCP：`server 名 → Set<工具名>`（也纳管；见 observeTools 里的说明）。 */
  mcp: new Map(),
}

/** 读满一个请求体，超限即断。 */
function readRequestBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > cap) {
        reject(new Error(`body too large (> ${cap} bytes)`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 一组短字符串（形状校验用）。重复项直接抵消（见 dedupeStrings）。 */
function sanitizeStringList(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  if (value.length > API_MAX_LIST) throw new Error(`${label} has too many entries (max ${API_MAX_LIST})`)
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 200) {
      throw new Error(`${label} entries must be non-empty strings (max 200 chars)`)
    }
    out.push(item)
  }
  return dedupeStrings(out)
}

/**
 * 去掉重复项、保持原顺序。
 *
 * 「重复的自动抵消」——设计约定：「不同组合内容有重复的，重复的内容
 * 给到调用方，那就是上下文爆炸，重复的自动抵消」。
 *
 * 运行时其实**已经是**去重的（插件按 id、技能按名字，全部走 Set），所以多选重叠
 * 的组合不会把同一份内容算两遍。这里再加一道**写入侧**的去重，理由有两个：
 *   ① 名单本身不该存重复项（否则 UI 数数、导出、人眼读都对不上）；
 *   ② 以后任何新消费者（启动器、脚本）拿到的是干净的数组，不用各自再防一遍。
 */
function dedupeStrings(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/**
 * 「名字 → 组合名」映射（形状校验用）。
 *
 * 值可以是**单个字符串**（旧版）或**字符串数组**（多选）。空数组/空串一律丢掉
 * （等价于"这一级没指定"），所以不用担心 UI 写进来一个空数组把继承链掐断。
 */
function sanitizeNameMap(value, label) {
  const out = {}
  if (value === undefined || value === null) return out
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const one = (v, key) => {
    if (typeof v !== 'string' || v.length === 0 || v.length > 200) {
      throw new Error(`${label}["${key}"] must be a non-empty string (or an array of them)`)
    }
    return v
  }
  for (const [key, val] of Object.entries(value)) {
    if (Array.isArray(val)) {
      const list = dedupeStrings(val.map((v) => one(v, key)))
      if (list.length > 0) out[key] = list
      continue
    }
    out[key] = one(val, key)
  }
  return out
}

/**
 * 把 UI 传来的对象**重建**成合法的状态。
 * 不做透传：任何未知字段一律丢弃，形状不对就抛错 —— 这样 UI 就写不坏状态文件。
 */
function sanitizeStateInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('body must be an object')
  const skill = {}
  for (const [name, entry] of Object.entries(raw.compositions?.skill ?? {})) {
    skill[name] = { skills: sanitizeStringList(entry?.skills, `compositions.skill["${name}"].skills`) }
  }
  const plugin = {}
  for (const [name, entry] of Object.entries(raw.compositions?.plugin ?? {})) {
    plugin[name] = { plugins: sanitizeStringList(entry?.plugins, `compositions.plugin["${name}"].plugins`) }
  }
  return {
    version: STATE_VERSION,
    pinned: {
      skill: sanitizeNameMap(raw.pinned?.skill, 'pinned.skill'),
      plugin: sanitizeNameMap(raw.pinned?.plugin, 'pinned.plugin'),
    },
    session: {
      skill: sanitizeNameMap(raw.session?.skill, 'session.skill'),
      plugin: sanitizeNameMap(raw.session?.plugin, 'session.plugin'),
    },
    compositions: { skill, plugin },
  }
}

/**
 * 挂上组合 UI 的接口。拿不到 webServer 就静默跳过（UI 会显示"宿主接口未注册"）。
 *
 * @param ctx - 宿主 ctx。
 * @param api - `{ snapshot, writeState, skills, statePath }` 由 applyInner 提供。
 */
function registerComposerApi(ctx, api) {
  const webServer = serviceOf(ctx, 'webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    // 真机实测：apply 那一刻 `webServer` **还没注册**，
    //   直接放弃会让组合 UI 永远拿不到数据（页签在、但显示"读不到宿主接口"）。
    //   `@deepseek-ai/dsh-client-modules` 对同一场景的官方写法就是这句：
    //     if (ctx.get("webServer") === void 0) ctx.inject(["webServer"], registerWebCarrier);
    //   宿主插件的运行时 `ctx.inject` 只是等服务的副作用，**不会**造成客户端那种 pending。
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['webServer'], () => {
          const late = serviceOf(ctx, 'webServer')
          if (late !== undefined && late !== null && typeof late.register === 'function') attachComposerApi(ctx, late, api)
          else noteOnce('api:no-webserver', '组合 UI 接口未注册：webServer 就绪后仍取不到（UI 会显示"宿主接口未注册"）')
        })
        return
      } catch {
        // 落到下面的放弃分支
      }
    }
    noteOnce('api:no-webserver', '组合 UI 接口未注册：拿不到 webServer 服务（UI 会显示"宿主接口未注册"）')
    return
  }
  attachComposerApi(ctx, webServer, api)
}

/**
 * 真正挂路由的那一半（拿到 webServer 之后调用）。
 *
 * @param ctx - 宿主 ctx。
 * @param webServer - 已就绪的 webServer 服务。
 * @param api - `{ snapshot, writeState, skills, statePath }`。
 */
function attachComposerApi(ctx, webServer, api) {
  const handler = async (req, res) => {
    const send = (code, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      send(400, { error: 'bad request url' })
      return
    }
    const route = url.pathname.slice(API_PREFIX.length)
    const method = (req.method ?? 'GET').toUpperCase()

    // 当前机器限定 + 防 CSRF（加固）
    // 这条口子能改组合状态，必须先确认请求**来自当前机器的浏览器**：
    //   ① 远端地址必须是环回（挡掉局域网 / 别的机器）
    //   ② 带 Origin 的请求，Origin 也必须是环回 —— 这挡的是"随便点开某个网页，
    //      那个网页偷偷往 127.0.0.1 发 POST"。**不给 Origin 的本地工具照常放行**，
    //      所以命令行/脚本不会被误伤。
    const remote = String(req.socket?.remoteAddress ?? '')
    const isLoopbackAddr = remote === '127.0.0.1' || remote === '::1' || remote.endsWith('127.0.0.1')
    if (!isLoopbackAddr) {
      send(403, { error: 'loopback only' })
      return
    }
    const origin = req.headers?.origin
    if (typeof origin === 'string' && origin.length > 0) {
      let originOk = false
      try {
        const host = new URL(origin).hostname
        originOk = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
      } catch {
        originOk = false
      }
      if (!originOk) {
        send(403, { error: 'origin not allowed' })
        return
      }
    }

    try {
      if (method === 'GET' && route === '/state') {
        /* 第②步：自适应常驻（方案 B = 全自动 + 排除名单）。
         *
         * 前端把「`tool.call.toolview` 槽上**真实注册**的 key」挂在这个 query 上带过来，
         * 过滤后写进 `<DSH_HOME>\.composer-resident-tools` 的**自动区**。
         *
         * 为什么需要：卡片插件按**工具名**匹配 slot（`key: <工具名>`），而走中转时
         * 调用名是 `invoke_tool` ⇒ 匹配不上 ⇒ 卡片静默不渲染。把这类工具**常驻**
         * 就能走原生直调 ⇒ 卡片正常。而"哪些工具注册了卡片"**只有客户端运行时知道**
         * （源码里常是变量，如 client-chart 的 `CHART_TOOLS.map(...)`）⇒ 必须上报。
         *
         * 只写文件、不改任何运行时行为；**重启后才生效**（所以不会中途改工具面、破前缀）。 */
        try {
          const probeKeys = url.searchParams.get('_probeKeys')
          if (typeof probeKeys === 'string' && probeKeys.length > 0) {
            const reported = probeKeys.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
            noteOnce(
              `toolview-probe:${probeKeys}`,
              `toolview 探针：客户端报告 tool.call.toolview 上注册的 key = ${probeKeys}`,
            )
            /* 选项 3：先取"宿主注册表里的真名集合"，写文件前用它过滤。
               取一次、建 Set（别在循环里反复调 schemas）。 */
            let knownNames
            try {
              const registry = serviceOf(ctx, 'tools')
              const schemas = registry?.schemas?.() ?? []
              knownNames = new Set(
                (Array.isArray(schemas) ? schemas : [])
                  .map((schema) => schema?.name)
                  .filter((n) => typeof n === 'string' && n.length > 0),
              )
            } catch { knownNames = undefined }
            syncAutoResidentTools(reported, knownNames)
          }
        } catch { /* 探针绝不影响 /state */ }
        send(200, await api.snapshot())
        return
      }
      if (method === 'GET' && route === '/skills') {
        send(200, { skills: await api.skills() })
        return
      }
      /**
       * 「当前生效的组合」—— 给**其它插件**（启动器 launcher）用的只读接口。
       *
       * 为什么单独开一条：启动器的「常用插件 / 技能」要跟组合器**同一份真相**，
       * 不能各自猜（它原来把全部插件都列出来了）。这里走**和对话完全相同**的
       * 三级解析 + 并集/全不选语义，所以"界面上显示什么 = 模型目录里有什么"。
       *
       * 加作用域参数（`?sessionId=` / `?cwd=`）：调用方常常**不在**
       * 最近一次跑过 pre-step 的那个会话里（在新会话、或换了个工作区打开启动器），
       * 此时 `lastEnv` 是**旧作用域** ⇒ 解析出来的是旧组合。实测症状：工作区里
       * 明明选了两套组合，启动器只显示其中一套。带上 sessionId 后按**调用方所在
       * 会话**解析，`lastEnv` 只作为没带参数时的兜底（向后兼容）。
       */
      if (method === 'GET' && route === '/effective') {
        send(200, api.effective({
          sessionId: url.searchParams.get('sessionId') ?? undefined,
          cwd: url.searchParams.get('cwd') ?? undefined,
        }))
        return
      }
      /* 插件目录：中文名 + 描述 + 工具数 + 字节数（启动器的常驻选择器用同一份真相）。 */
      if (method === 'GET' && route === '/catalog') {
        send(200, { plugins: api.catalog() })
        return
      }
      if (method === 'POST' && route === '/state') {
        const raw = await readRequestBody(req, API_MAX_BODY_BYTES)
        const parsed = JSON.parse(raw)
        /**
         * 两种形状都收：直接给 state（历史约定），或包一层 `{state: ...}`。
         *
         * 但**下面那道闸是必须的**：曾有一次误 POST 了 `{state: {...}}`
         * （外层多了个壳），旧代码 `sanitizeStateInput(parsed)` 看不到 comprehensions
         * ⇒ 当成"全部为空"⇒ **把 9 套插件组合 + 21 套技能组合全清了**。
         * 现在：body 里既没有 `compositions` 也没有 `pinned` 就 400 拒绝 ——
         * 绝不允许用"空"去覆盖已有状态。
         */
        const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          && parsed.state !== undefined && parsed.state !== null
          ? parsed.state
          : parsed
        const looksLikeState = body !== null && typeof body === 'object' && !Array.isArray(body)
          && (Object.prototype.hasOwnProperty.call(body, 'compositions')
            || Object.prototype.hasOwnProperty.call(body, 'pinned'))
        if (!looksLikeState) {
          throw new Error('拒绝写入：body 必须是状态对象（或 {state: ...}），且至少带 compositions / pinned —— 免得一个空 body 把组合清空')
        }
        const next = sanitizeStateInput(body)
        api.writeState(next) // 写盘 + 立刻重载（下一步生效）
        send(200, { ok: true, state: await api.snapshot() })
        return
      }
      send(404, { error: `no such route: ${method} ${url.pathname}` })
    } catch (error) {
      send(400, { error: String(error?.message ?? error) })
    }
  }
  try {
    const dispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
    ctx.effect?.(() => dispose, 'capability-composer: 组合 UI 接口')
    toolDietNote(`组合 UI 接口已挂载：${API_PREFIX}/state（GET 读 / POST 写）`)
  } catch (error) {
    noteOnce(`api:register-fail:${error?.message ?? error}`, `组合 UI 接口注册失败：${error?.message ?? error}`)
  }
}

/*
 * 历史遗留的「全量技能目录」：从**会话表面**上换掉
 *
 * 事实链（都在真机日志/真会话文件里核对过）：
 *   ① `agent/pre-step` 的 `decision.messages` 只有**本轮新消息** —— agent-loop 里
 *      是 `this.inbox.claim(...)`（dsh-agent-loop/lib/index.js:889），历史消息不在里面。
 *      所以「注入前裁小」对**已经落进会话日志**的旧目录彻底无能为力。
 *      实测：本次启动那条证据行一次都没出现过，而会话里躺着一条 168 个技能、
 *      62,960 字符（≈16.4K tokens）的目录消息 —— 这就是"技能占了 18k"的来源。
 *   ② 上游 `dsh-tool-skill` 换目录的方式是**再追加一条**新目录消息
 *      （"This complete catalog replaces every earlier available-skills list"），
 *      旧的那条照样留在模型可见上下文里，token 一分没省。
 *   ③ 官方给的正道是会话的 **surface replace**（append-only，dsh-session 校验）：
 *        session.append('user/message', 新目录, {
 *          surfaceOp: { op: 'replace', startSeq: 旧事件.seq, endSeq: 旧事件.seq },
 *          sourceEventSeqs: [旧事件.seq],   // 必须完整覆盖被遮蔽的节点
 *        })
 *      校验要点：startSeq/endSeq 必须指向**更早的、当前表面上的**节点；
 *      `sourceEventSeqs` 必须**完整列出**被遮蔽的每个表面节点（这里就一个）。
 *      效果：模型看不见旧的；人看的对话记录走 append-origin 事件，一条都不少
 *      （dsh-session 注释里明写"replacement copies stay model-only"）。
 *
 * 为什么放在本插件里：技能组合的允许名单只有本插件知道。新会话靠"遮蔽 provider"
 * 从源头就不注入全量目录；老会话里那份已经写进日志的，只能这样替换掉。
 */

/** 技能目录消息的 `source.kind`（上游 dsh-tool-skill 用它标记目录消息）。 */
const SKILL_CATALOG_SOURCE_KIND = 'skill-catalog'
/**
 * 本插件那条"这份目录已被取代"的指路牌用的 `source.kind`。
 *
 * **绝对不能再用 `skill-catalog`**：上游 `catalogHistory()` 是"从后往前找第一条
 * 可见的 skill-catalog"来决定 digest，而本插件的指路牌是**追加在尾巴上的**
 * ⇒ 它会变成"最后一条目录"，digest 变成空目录的 digest，跟当前技能快照永远对不上
 * ⇒ 上游**每一步都重发一条目录**，本插件又每步遮一条 —— 死循环，会话每步长两条事件。
 * 实测：会话里 skill-catalog 事件 365 个，最后 10 个正是
 * `entries=2 append` 与 `entries=0 replace(刚建那条)` 反复交替。
 * 换成非 skill-catalog 的 kind 之后，上游与本插件都会跳过它，digest 只看真目录。
 */
const SKILL_CATALOG_NOTE_KIND = 'capability-composer-catalog-note'
/** 目录行里的那个反引号：用码点写，免得源码里出现落单的反引号。 */
const CATALOG_TICK = '\u0060'

/** 上游 `escapeText`（@deepseek-ai/dsh-skill）的等价物：描述里的尖括号会弄坏框架标签。 */
function escapeCatalogText(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * 与上游 `renderCatalogUpdate` 逐字同格式的"替换版目录"。
 * 这段框架文本是给模型看的，格式必须跟 dsh-tool-skill 一致，否则模型读到的
 * 说明和它自己的目录协议对不上。
 */
function renderCatalogUpdateText(entries) {
  const tick = CATALOG_TICK
  const availability = entries.length === 0
    ? [
      `No skills are currently available through the ${tick}skill${tick} tool. Do not use names from earlier skill catalogs.`,
      `A user may still invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the ${tick}skill${tick} tool for it.`,
    ]
    : [
      `Use only names in this replacement catalog. If the user names a listed skill, or the task clearly matches its description, call the ${tick}skill${tick} tool with the exact name before acting.`,
      `A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the ${tick}skill${tick} tool again for that skill.`,
    ]
  return [
    '<system-reminder>',
    'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
    '',
    '<available_skills>',
    ...entries.map((entry) => `- ${tick}${entry.name}${tick}: ${escapeCatalogText(entry.description)}`),
    '</available_skills>',
    '',
    ...availability,
    '</system-reminder>',
  ].join('\n')
}

/** 一条消息里所有 text 块拼起来（只用于量体积）。 */
function catalogTextOf(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  let out = ''
  for (const block of content) {
    if (block === null || block === undefined || block.type !== 'text') continue
    if (typeof block.text === 'string') out += block.text
  }
  return out
}

/** 每个会话身上记一份「扫到第几个事件了」+「提醒过没有」，免得每个 step 全量扫日志。 */
const skillSurfaceSweepMark = new WeakMap()
const skillSurfaceAnnounced = new WeakSet()

/**
 * 被更新目录取代的旧目录，换成一个**极小**的指路牌。
 *
 * 上游 `dsh-tool-skill` 换目录的方式是**再追加一条**
 * （"This complete catalog replaces every earlier available-skills list in this session"）
 * —— 旧的那条照样留在模型可见上下文里，**一条都不省**。
 * 于是每换一次组合/每变一次技能快照，就永久多背一份旧目录。
 * 真机实测：<工作区> 的 session-eec06ad1 里 3 条可见目录累计 2,523 tokens，
 * 而其中两条早已被最新那条完全取代（技能名全都在最新那条里）。
 *
 * 这里把"已被完全取代"的旧目录换成一句话（省掉几乎全部体积）。判定保守：
 * **只有**旧目录的技能名**全都**出现在最新那条目录里，才认为它被完全取代。
 * 最新那条永远不动 ⇒ 上游读到的 digest 不变 ⇒ 不会来回打架。
 */
function renderSupersededCatalogText() {
  return [
    '<system-reminder>',
    'This earlier skill catalog was already replaced by a newer available-skills list in this session.',
    'Use only the most recent available-skills list.',
    '</system-reminder>',
  ].join('\n')
}

/**
 * 指路牌里那句固定台词 —— 用来认"这条节点是不是本插件写的指路牌"（而不是别的笔记）。
 * 只动本插件自己写的东西；将来若有别的 kind 复用同一 kind 值，这句不匹配就一个字不动。
 */
const SUPERSEDED_POINTER_MARK = 'already replaced by a newer available-skills list'
/**
 * 旧指路牌被压成的**极短占位**。
 *
 * 为什么需要它：上面那条 182 字符的指路牌本身也是**一条独立表面节点**，
 * 而"新的不回收旧的"——长会话里实测活着 58–74 条，合计 2,726–3,478 tokens/轮，
 * 全是同一句话的复制品。留着它们毫无信息量：模型只需要知道"用最新那份目录"，
 * 而最新那条完整目录自己就写着 "This complete catalog replaces every earlier available-skills list"。
 *
 * 不许压成空字符串：provider 侧对空 text 块有校验，宁可留一个短语。
 * 不许用跨节点 range replace 去一次扫掉一串：中间夹着的是真对话消息，会被一起遮蔽。
 */
const SUPERSEDED_PLACEHOLDER = '(superseded)'

/**
 * 把"本插件写的、已被取代的指路牌"压成极短占位，**只留最新那一条**（模型仍能看到那句指路）。
 *
 * 逐节点 `surfaceOp:{op:'replace',startSeq:seq,endSeq:seq}`（单节点替换，绝不跨节点），
 * 幂等：已经是 `(superseded)` 的不再动；认不出那句固定台词的也不动。
 * @returns {Array<{seq:number, before:number}>} 每条被压的记录
 */
function collapseSupersededPointers(session) {
  const collapsed = []
  const nodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : []
  const pointers = []
  for (const seq of nodes) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined
    if (event === undefined || event === null || event.type !== 'user/message') continue
    const source = event.data?.source
    if (source === undefined || source === null) continue
    if (source.kind !== SKILL_CATALOG_NOTE_KIND || source.superseded !== true) continue
    pointers.push({ seq: event.seq, text: catalogTextOf(event.data), source })
  }
  /* 最新那条留着长文案（"用最新的目录"这句提示需要一个可见的载体）。 */
  const keep = pointers.length === 0 ? null : pointers[pointers.length - 1].seq
  for (const pointer of pointers) {
    if (pointer.seq === keep) continue
    if (pointer.text === SUPERSEDED_PLACEHOLDER) continue
    if (!pointer.text.includes(SUPERSEDED_POINTER_MARK)) continue
    const replacement = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: SUPERSEDED_PLACEHOLDER }],
      source: Object.assign({}, pointer.source),
    }
    session.append('user/message', replacement, {
      surfaceOp: { op: 'replace', startSeq: pointer.seq, endSeq: pointer.seq },
      sourceEventSeqs: [pointer.seq],
    })
    collapsed.push({ seq: pointer.seq, before: pointer.text.length })
  }
  return collapsed
}

/**
 * 收集会话表面上**可见**的技能目录事件（按 seq 升序）。
 * @returns {Array<{seq:number, entries:Array<object>, text:string}>}
 */
function visibleSkillCatalogs(session) {
  const out = []
  const nodes = session.surface?.nodes
  if (!Array.isArray(nodes)) return out
  for (const seq of nodes) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined
    if (event === undefined || event === null || event.type !== 'user/message') continue
    const source = event.data?.source
    if (source === undefined || source === null || source.kind !== SKILL_CATALOG_SOURCE_KIND) continue
    const entries = Array.isArray(source.entries) ? source.entries : []
    out.push({ seq: event.seq, entries, text: catalogTextOf(event.data) })
  }
  return out
}

/**
 * 把已被最新目录完全取代的旧目录换成指路牌（见 renderSupersededCatalogText 的注释）。
 * @returns {Array<object>} 每条被处理的记录
 */
function dedupeSupersededCatalogs(session) {
  const visible = visibleSkillCatalogs(session)
  if (visible.length < 2) return []
  const newest = visible[visible.length - 1]
  /* 最新那份目录是空的 ⇒ 它没资格取代任何人（宁可留旧目录，也不能把技能发现能力清空）。 */
  if (newest.entries.length === 0) return []
  const deduped = []
  for (const older of visible.slice(0, -1)) {
    /* 旧判据是「旧目录的每个技能名都得在新目录里」才算被取代 —— 实测这会漏掉**最常见的一种**：
       把组合改**窄**（旧 20 条 → 新 8 条）时，旧目录不是子集，一份完整的旧目录
       就永远留在上下文里白占 ≈1,700 tok/轮。
       实测证据（<工作区>\tests\probe_catalog_position.mjs，会话 session-df0a83c1）：
         下标 7 = 6,643 字符 / 20 条技能，下标 14 = 2,169 字符 / 8 条技能，**两份同时活着**。
       上游语义本来就是「**最后一条可见目录说了算**」：
         · 它的 `catalogHistory()` 只读最后一条可见目录算 digest；
         · 注入文案自己写着 "This complete catalog replaces **every earlier** available-skills list"。
       ⇒ 把"更旧的全压成指路牌"与上游**完全一致**，不存在"把还在用的目录压掉"这回事。
         下面只保留一条护栏：最新目录不能是空的（见上）。 */
    if (older.text.length <= renderSupersededCatalogText().length) continue
    const replacement = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: renderSupersededCatalogText() }],
      /* 这里以前写的是 `kind: SKILL_CATALOG_SOURCE_KIND` + `entries: []` —— 那会让上游
         把这条指路牌当成"最后一条目录"，digest 对不上 ⇒ 每步重发一条目录，死循环。
         见 SKILL_CATALOG_NOTE_KIND 上面的长注释。 */
      source: { kind: SKILL_CATALOG_NOTE_KIND, form: 'catalog-note', superseded: true },
    }
    session.append('user/message', replacement, {
      surfaceOp: { op: 'replace', startSeq: older.seq, endSeq: older.seq },
      sourceEventSeqs: [older.seq],
    })
    deduped.push({ seq: older.seq, before: older.text.length, after: catalogTextOf(replacement).length, from: older.entries.length })
  }
  return deduped
}

/**
 * 把**旧版本留下的指路牌**换成新 kind。
 *
 * 早期版本把指路牌标成 `kind: skill-catalog` + `entries: []`，它会成为"最后一条可见目录"，
 * 让上游的 digest 永远对不上 ⇒ 每步重发一条目录（会话每步长两条事件，实测一个会话 365 条目录）。
 * 光改新代码不够 —— **老会话里那些旧指路牌还在**，必须就地换掉，否则循环不停。
 */
function retireLegacyPointers(session) {
  const retired = []
  const nodes = Array.isArray(session.surface?.nodes) ? [...session.surface.nodes] : []
  for (const seq of nodes) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined
    if (event === undefined || event === null || event.type !== 'user/message') continue
    const source = event.data?.source
    if (source === undefined || source === null) continue
    if (source.kind !== SKILL_CATALOG_SOURCE_KIND || source.superseded !== true) continue
    const replacement = {
      id: randomUUID(),
      role: 'user',
      content: Array.isArray(event.data.content) ? event.data.content : [{ type: 'text', text: renderSupersededCatalogText() }],
      source: { kind: SKILL_CATALOG_NOTE_KIND, form: 'catalog-note', superseded: true },
    }
    session.append('user/message', replacement, {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
      sourceEventSeqs: [event.seq],
    })
    retired.push({ seq: event.seq })
  }
  return retired
}

/**
 * **"改写历史"总开关**（默认 **关** = 不改历史）。
 *
 * 为什么要这个开关
 * 本函数里有 4 个动作，其中 3 个会用 `surfaceOp: {op:'replace'}` **改写已进日志的消息**：
 *   ① 把"已落进日志的全量目录"裁成允许范围
 *   ③ 把被取代的旧目录换成"指路牌"
 *   ④ 把本插件积下的旧指路牌压成极短占位
 * **DSH 的缓存是前缀匹配 ⇒ 改写点之后的全部作废。**
 * 真机实测：`省 1233 tok` ⇔ `赔 54,729 tok` ⇒ **44 倍**。
 *
 * 关掉它们会不会导致"全量技能涌入、组合器成摆设"？**不会**
 * 那是两件事：
 *   · **新注入的裁剪** 由 `shrinkSkillCatalog()` 负责 —— 它在**注入前**就把正文裁到
 *     只剩组合允许的技能（实测 `79695 字符 → 4854 字符`）。**这条路不走 surfaceOp，不破前缀。**
 *   · 本函数只处理"**历史里已经躺着**的旧目录"。关掉它，只是让那些旧目录**留着**，
 *     不影响"新进去的内容有多少"。
 * ⇒ **组合器的过滤能力完全保留**，代价仅是"历史里多留几 KB 旧目录"（那是热数据，几乎不花钱）。
 *
 * 为什么保留 ② `retireLegacyPointers`
 * 它把"早期版本留下的错误 kind"就地换成新 kind。不换的话上游 digest 永远对不上
 * ⇒ **每步重发一份完整目录、死循环**。它是**修 bug**，不是"省 token"，所以不归本开关管。
 *
 * 打开（恢复旧行为）：`DSH_COMPOSER_HISTORY_REWRITE=1`。
 */
function historyRewriteEnabled() {
  return process.env.DSH_COMPOSER_HISTORY_REWRITE === '1'
}

/**
 * 把会话表面上**超出组合允许范围**的技能目录换成只含允许技能的版本，
 * 再把"已被最新目录完全取代"的旧目录换成指路牌、把本插件积下来的旧指路牌压成极短占位。
 *
 * 后两个动作（去重 + 压占位）是**改写历史**，会让前缀缓存从那一点起全废 ——
 * 由 `historyRewriteEnabled()` 控制，**默认关**（见其注释）。① 的"新注入裁剪"不受影响。
 *
 * @returns {{fixed: Array<object>, deduped: Array<object>, retired: Array<object>, collapsed: Array<object>, reason?: string, swept: number}}
 */
function compactSkillCatalogSurface(agent, allow, onNote) {
  const session = agent?.session
  if (session === undefined || session === null) return { fixed: [], deduped: [], reason: 'no-session', swept: 0 }
  if (!Array.isArray(session.surface?.nodes)) return { fixed: [], deduped: [], reason: 'no-surface', swept: 0 }
  const total = typeof session.seq === 'number' ? session.seq : 0
  const mark = skillSurfaceSweepMark.get(session)
  /* 日志是 append-only 的，历史目录只可能出现在**新的尾巴**上 ⇒ 从上次扫到的地方接着扫。 */
  const from = typeof mark === 'number' && mark >= 0 && mark <= total ? mark : 0
  /* 组合未设 ⇒ 不裁目录。此时**不推进扫描游标**：否则组合晚点设上时，
     这段空窗期注入的全量目录会被永久跳过（游标已经越过它们了）。 */
  const allowUsable = allow !== null && allow !== undefined && typeof allow.has === 'function' && allow.size > 0
  const fixed = []
  /* 「把已落进日志的全量目录裁小」同样是**改写历史** ⇒ 默认关（见 historyRewriteEnabled）。
     为什么关掉不会让"全量技能涌入"：新注入的那份在**注入前**就被 shrinkSkillCatalog()
     裁到只剩组合允许的技能（实测 79695 字符 → 4854 字符）⇒ 组合器功能不受影响。
     这里只处理"历史里已经躺着"的旧目录 —— 留着它们只是多占几 KB 热数据。 */
  const rewriteHistory = historyRewriteEnabled()
  for (let seq = from; seq < total; seq += 1) {
    if (!rewriteHistory) break
    if (!allowUsable) break
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : undefined
    if (event === undefined || event === null) continue
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source === undefined || source === null || source.kind !== SKILL_CATALOG_SOURCE_KIND) continue
    /* 已经被遮蔽的（早就换过的）节点不再看第二眼。 */
    if (!session.surface.nodes.includes(event.seq)) continue
    const entries = Array.isArray(source.entries) ? source.entries : null
    if (entries === null || entries.length === 0) continue
    const kept = entries.filter((entry) => entry !== null && typeof entry === 'object' && allow.has(entry.name))
    /* 一条都没裁掉 ⇒ 这份目录本来就在组合允许范围内，别动它。 */
    if (kept.length >= entries.length) continue
    const before = catalogTextOf(event.data)
    if (before.length === 0) continue
    const nextText = renderCatalogUpdateText(kept)
    /* 关键：既然 `entries` 保持全量，就**不能再拿条数判断"要不要裁"** ——
       否则每次扫到这个节点都会算"裁掉了"（全量 40 → 允许 2）⇒ **每步改写一次、无限循环**。
       ⇒ 改成**按正文判断**：正文已经是裁过的那份（逐字符相同）就跳过。 */
    if (before === nextText) continue
    const replacement = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: nextText }],
      /* 同样**不动 `entries`**（与 shrinkSkillCatalog 的根治同理）：
         上游拿"最后可见目录的 entries digest"跟"当前技能快照 digest"比；
         把 entries 改成裁后的 N 条 ⇒ 与快照（全量 M 条）永远不等 ⇒ 每步重发一份完整目录
         ⇒ 每步 2 次表面改写 ⇒ 第 2 条往后前缀缓存每步全废。
         正文独立渲染，所以只改正文就够了。 */
      source: SHRINK_ENTRIES
        ? Object.assign({}, source, { update: true, entries: kept })
        : Object.assign({}, source, { update: true }),
    }
    session.append('user/message', replacement, {
      surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
      sourceEventSeqs: [event.seq],
    })
    fixed.push({
      seq: event.seq,
      before: before.length,
      after: catalogTextOf(replacement).length,
      from: entries.length,
      to: kept.length,
    })
  }
  if (allowUsable) skillSurfaceSweepMark.set(session, total)
  /* 这里起都是**改写历史**（`surfaceOp: replace`）—— 默认关，见 historyRewriteEnabled()。
     关掉后：历史里的旧目录/旧指路牌就留着（内容中性，只是多占几 KB 热数据），
     而"新注入的裁剪"仍由 shrinkSkillCatalog() 在注入前完成 ⇒ 组合器功能不受影响。 */
  const rewrite = historyRewriteEnabled()
  /* ② 不归本开关管：它把"早期版本的错误 kind"换成新 kind，不换会让上游 digest 永远对不上
     ⇒ 每步重发完整目录、死循环。它是修 bug，不是省 token。 */
  const retired = retireLegacyPointers(session)
  const deduped = rewrite ? dedupeSupersededCatalogs(session) : []
  /* ③ 每扫一轮把本插件自己积下的旧指路牌压成极短占位（幂等；最新那条长文案保留）。
     实测长会话里这种指路牌活着 58–74 条、合计 2,726–3,478 tokens/轮 —— 但压它们要
     改写历史 ⇒ 断一次前缀赔几万 tok，**账不划算**，所以默认关。 */
  const collapsed = rewrite ? collapseSupersededPointers(session) : []
  if (fixed.length > 0 && typeof onNote === 'function') onNote(fixed)
  return { fixed, deduped, retired, collapsed, swept: allowUsable ? total - from : 0 }
}

/*
 * 插件提示段按组合收窄 —— **模块级纯函数**（研-02 产物）
 *
 * 为什么放模块级：这样它能被单测直接调（`__composerTestHooks.prunePluginSections`），
 * 不必起 Cordis 运行时。闭包里的 `maskAssemblySections` 只负责"算出组合 ids"。
 *
 * 【实测依据】`插件组合` 只控制「工具白名单 + 插件目录」，**控制不了插件自己注册的
 * 系统提示段**。实测会话 `session-df0a83c1`（系统提示 19,098 字符 ≈ 5,329 tok）逐块量：
 *   · `agent-teams:usage`  ≈1,296 tok ← `dsh-agent-teams`，**不在** `开发·上下文治理` 组合
 *   · `plugin:dsh-docker`  ≈  579 tok ← `docker`，**不在**
 *   · `plugin:api-client`  ≈  254 tok ← `api-client`，**不在**
 *   ⇒ 合计 **≈2,129 tok/请求**，是"已决定这个工作区不需要的插件"的提示。
 *   （对照：`lint:findings`/`tool:codegraph`/`tool:context7`/`dsh-knowledge:mounts`
 *     的归属插件**都在**组合里 ⇒ 一个都不动。）
 *
 * 【为什么无损】组合明确声明了"这个工作区需要哪些能力"；没选的插件，
 * 其提示段既不该占上下文，也不该影响模型行为。
 * 与"抄梁神一刀切收窄"不同 —— 那个按 section 白名单过滤，会连
 * `capability-composer:plugin-catalog`（88.6% miss 的修复载体）一起删掉。
 *
 * 【防误删】① 只认显式映射表，**表里没有的一律保留**；② 本插件自己的前缀 + 无冒号段永远保留；
 * ③ 组合未设 ⇒ 完全不动；④ 每次丢弃记证据行；⑤ 可一键关。
 */
/**
 * 把硬编码的 `SECTION_OWNER_MAP` 换成**运行时推导**。
 *
 * 旧做法的毛病
 * 原来是一张写死的表：
 *   ['tool:codegraph', 'tool-codegraph']、['dsh-knowledge:mounts', 'knowledge']、…
 *   **装了新插件 ⇒ 它的段不在表里 ⇒ 认不出归属 ⇒ 一律保留**（fail-open）
 *      ⇒ 这个"按组合收窄"的功能对新插件永远失效（段白占上下文）。
 *      日志里那句反复出现的 `段 "tool:ralph" 不在归属表里 ⇒ 保留（不裁）` 就是它。
 *
 * 新做法：从段名推导
 * 段名形如 `<ns>:<rest>`（`tool:codegraph` / `plugin:dsh-docker` / `dsh-knowledge:mounts`）。
 * 拿 `<ns>` 去跟**实际存在的插件 id 清单**匹配，按可靠性从高到低：
 *   ① 完全相同
 *   ② 去掉 `dsh-` 前缀后相同（`dsh-knowledge` ↔ `knowledge`）
 *   ③ 互为子串，且**取最长匹配**（`codegraph` → `tool-codegraph`；
 *      而不是被更短的 `context` 抢走 `dsh-context` 的段）
 * ⇒ 不写死任何名字；装什么新插件都能认出来。
 *
 * @param name - 段名。
 * @param knownIds - 已知的全部插件 id（`string[]`）。
 * @returns {string|undefined} 归属的插件 id；认不出返回 undefined（调用方保留该段）。
 */
function inferSectionOwner(name, knownIds) {
  if (typeof name !== 'string' || !name.includes(':')) return undefined
  if (!Array.isArray(knownIds) || knownIds.length === 0) return undefined
  const ns = name.split(':')[0].toLowerCase()
  if (ns === '') return undefined
  const strip = (s) => s.replace(/^dsh-/, '')
  /* ① 完全相同 */
  for (const id of knownIds) if (String(id).toLowerCase() === ns) return id
  /* ② 去 dsh- 前缀后相同 */
  for (const id of knownIds) if (strip(String(id).toLowerCase()) === strip(ns)) return id
  /* ③ 互为子串 —— 取最长匹配（防"短词抢归属"） */
  let best
  let bestLen = 0
  for (const id of knownIds) {
    const i = String(id).toLowerCase()
    if (i.includes(ns) || ns.includes(i)) {
      const len = Math.min(i.length, ns.length)
      if (len > bestLen) { bestLen = len; best = id }
    }
  }
  return best
}
/** 永不丢的段名前缀（本插件自己的）。 */
const SECTION_PROTECTED_PREFIX_CONST = 'capability-composer:'

/**
 * 纯函数：按"可见插件 id 集合"裁掉不该进的提示段。
 * @param visibleIds - `Set<string>`，当前组合里可见的插件 id。
 *   **`null` / `undefined` ⇒ 不过滤**（fail-open，与"组合未设"同义）；
 *   **空 Set ⇒ 什么都不可见**（除保护项外全丢）—— 两者语义不同，别混。
 * @param assembly - `{ sections }`。
 * @param knownIds - 已知的全部插件 id（用于**推导**段归属，取代硬编码表）。
 *   省略时退化为"只认 visibleIds 里的"（仍比硬编码表更自适应）。
 * @returns `{ assembly, dropped: [{name, owner, bytes}], savedBytes }`。
 */
export function prunePluginSections(visibleIds, assembly, knownIds) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : null
  if (sections === null) return { assembly, dropped: [], savedBytes: 0 }
  /* null = "不过滤"（fail-open），不是"空可见集" —— 组合解析失败时必须走这条。 */
  if (visibleIds === null || visibleIds === undefined) return { assembly, dropped: [], savedBytes: 0 }
  const ids = visibleIds instanceof Set ? visibleIds : new Set(visibleIds)
  /* 推导用的候选池：已知全部插件 id ∪ 当前可见的（保证至少能认出可见的）。 */
  const pool = new Set()
  if (Array.isArray(knownIds)) for (const id of knownIds) if (id) pool.add(id)
  for (const id of ids) pool.add(id)
  const poolArr = [...pool]
  const dropped = []
  const kept = sections.filter((section) => {
    const name = typeof section?.name === 'string' ? section.name : ''
    if (name === '' || name.startsWith(SECTION_PROTECTED_PREFIX_CONST)) return true
    /* 不含冒号 ⇒ 官方/核心段 ⇒ 一律保留。 */
    if (!name.includes(':')) return true
    const owner = inferSectionOwner(name, poolArr)
    /* 认不出归属 ⇒ 保留（宁可留着，也要 fail-open）。 */
    if (owner === undefined) return true
    if (ids.has(owner)) return true
    dropped.push({ name, owner, bytes: Buffer.byteLength(String(section?.text ?? ''), 'utf8') })
    return false
  })
  if (dropped.length === 0) return { assembly, dropped, savedBytes: 0 }
  return {
    assembly: Object.assign({}, assembly, { sections: kept }),
    dropped,
    savedBytes: dropped.reduce((a, d) => a + d.bytes, 0),
  }
}

/** 给测试用的出口：真机逻辑原样暴露，测试不需要抄一份。 */
export const __composerTestHooks = {
  SKILL_CATALOG_SOURCE_KIND,
  escapeCatalogText,
  renderCatalogUpdateText,
  renderSupersededCatalogText,
  SUPERSEDED_PLACEHOLDER,
  compactSkillCatalogSurface,
  dedupeSupersededCatalogs,
  collapseSupersededPointers,
  reclaimOutOfScopeLoadedTools,
  residentOverBudget,
  enforceResidentBudget,
  residentTokens,
  applyToolRestriction,
  toolStateFor,
  skillCompositionSignature,
  /* 研-02：插件提示段按组合收窄（模块级纯函数，可单测）。 */
  prunePluginSections,
  inferSectionOwner,
  PRUNE_PLUGIN_SECTIONS,
  /* 函数声明会提升，所以即使定义写在本文件更下面也能这样导出（真机逻辑原样暴露）。 */
  healSemgrepShortPath,
  healSemgrepShortPathOnce,
}


/*
 * 自适应自愈 ②：semgrep 的短路径 junction（默认 `C:\dshse`）
 *
 * 为什么需要：`@aaub-software/dsh-semgrep-sast` 的内置 Python 一旦用**长路径**启动，
 * 就会 `ImportError: DLL load failed … 文件名或扩展名太长`（实测 tomli 那条）。
 * 本插件的补丁让插件改用短路径 `C:\dshse\…`，而那个 junction 指向的是
 * **当前 generation 的运行时目录** —— 插件一更新，generation 换名，junction 就断了
 * （实测：它还指着已删除的 0.1.2 目录）。
 * 所以启动时顺手把它重指到最新的运行时（幂等；找不到就留证据、绝不动手）。
 *
 * 短路径位置可用环境变量 `DSH_SEMGREP_SHORT_PATH` 覆盖；默认值与
 * `@aaub-software/dsh-semgrep-sast` 补丁约定的位置一致。没装那个插件时
 * 这一段整体不会被触发（找不到 semgrep 运行时就直接返回"未安装"）。
 */
const SEMGREP_SHORT_PATH = process.env.DSH_SEMGREP_SHORT_PATH ?? 'C:\\dshse'
const SEMGREP_PKG_DIR = '@aaub-software'
const SEMGREP_RUNTIME_DIR = 'semgrep-runtime-win32-x64'

/** 最新的 semgrep 运行时目录（generations 中挑最新的那个；旧布局兜底）。 */
function semgrepRuntimeTarget() {
  const home = resolveDshHome()
  const candidates = []
  try {
    for (const name of readdirSync(join(home, 'profiles', '.generations', 'live'))) {
      if (!name.includes('semgrep-sast')) continue
      const target = join(home, 'profiles', '.generations', 'live', name, 'node_modules', SEMGREP_PKG_DIR, SEMGREP_RUNTIME_DIR)
      if (existsSync(target)) candidates.push({ name, target })
    }
  } catch {
    /* 没有 generations 目录就走兜底 */
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => (a.name < b.name ? 1 : -1))
    return candidates[0].target
  }
  const legacy = join(home, 'profiles', 'web', 'node_modules', SEMGREP_PKG_DIR, SEMGREP_RUNTIME_DIR)
  return existsSync(legacy) ? legacy : null
}

/** 当前 `C:\dshse` 指向哪（不是 junction 或不存在都返回 null）。 */
function currentShortPathTarget() {
  try {
    const info = lstatSync(SEMGREP_SHORT_PATH)
    if (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) return readlinkSync(SEMGREP_SHORT_PATH)
    return ''
  } catch {
    return null
  }
}

/**
 * 把 `C:\dshse` 重指到最新运行时。幂等；失败不动手并留证据。
 * @returns {{action: string, target?: string, detail?: string}}
 */
function healSemgrepShortPath() {
  const target = semgrepRuntimeTarget()
  if (target === null) return { action: 'not-installed' }
  const current = currentShortPathTarget()
  if (current === target) return { action: 'already', target }
  try {
    if (current !== null) rmSync(SEMGREP_SHORT_PATH, { recursive: true, force: true })
    symlinkSync(target, SEMGREP_SHORT_PATH, 'junction')
  } catch (error) {
    return { action: 'write-fail', target, detail: String(error?.message ?? error) }
  }
  return { action: 'healed', target, previous: current ?? '(不存在)' }
}

/** 启动时自愈一次并写证据行。 */
function healSemgrepShortPathOnce() {
  let result
  try {
    result = healSemgrepShortPath()
  } catch (error) {
    toolDietNote(`semgrep 短路径：自愈时抛错（不影响其他功能）—— ${error?.message ?? error}`)
    return
  }
  switch (result.action) {
    case 'healed':
      toolDietNote(`semgrep 短路径：已把 ${SEMGREP_SHORT_PATH} 重指到最新运行时（插件更新后它会断）—— ${result.target}`)
      return
    case 'already':
      noteOnce('semgrep-shortpath:already', `semgrep 短路径：${SEMGREP_SHORT_PATH} 已经指向最新运行时`)
      return
    case 'not-installed':
      noteOnce('semgrep-shortpath:not-installed', 'semgrep 短路径：这台机器没装 semgrep-sast 运行时 ⇒ 不需要建')
      return
    default:
      toolDietNote(`semgrep 短路径：**未改动**（${result.action}${result.detail === undefined ? '' : ' · ' + result.detail}）`)
  }
}

/**
 * Cordis 应用体。**任何异常都不允许冒泡**——一旦抛出，整棵插件树加载失败，
 * DSH 直接起不来（曾踩过一次）。这里只做一层安全壳，逻辑放 applyInner。
 */
export function apply(ctx) {
  try {
    applyInner(ctx)
  } catch (error) {
    ctx.logger?.warn?.(`[composer] 初始化失败，已跳过（不影响 DSH 启动）：${error?.message ?? error}`)
  }
}

/**
 * 全新安装的初始状态：**永远为空**（`defaultState()` 的四个空档位）。
 *
 * 这里以前会优先读随包自带的 `seed/compositions.seed.json` —— 那是作者本机的
 * 20 多个组合，第一次启动就被写进 `$DSH_HOME/capability-composer/compositions.json`。
 * 那是错的，而且错得很隐蔽：
 *   · 组合库是**用户数据**，在插件之外。随包发一份 = 每个新用户都继承别人的组合，
 *     别人打开组合器会看到一堆自己从没建过的东西（真机测试当场被发现）。
 *   · seed 再"净化"（只留 `'*'` 通配、丢掉带分隔符的 key）也只是把硬编码藏起来，
 *     没有消除它。判断标准很简单：**新装的机器上必须什么都没有。**
 * 所以 seed 机制整条删除：落地文件、`package.json` 的 `files` 字段、发布副本一起清掉。
 *
 * 边界（很重要）：只有"状态文件不存在 / 读不出来"才会落到这里。
 * 用户已有的 `compositions.json` **绝不覆盖、绝不清空**。
 */

function applyInner(ctx) {
  const dshHome = resolveDshHome()
  const statePath = join(dshHome, 'capability-composer', 'compositions.json')
  const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')

  const rawState = readJson(statePath, null)
  let state = migrateState(rawState)
  if (state === null) {
    state = defaultState()
    writeJson(statePath, state)
    ctx.logger?.info?.(`[composer] 已写入初始组合配置：${statePath}`)
  } else if (rawState === null || rawState.version !== STATE_VERSION) {
    writeJson(statePath, state)
    toolDietNote(`状态文件已迁移（plugin 轴改用插件 id，不再往补丁层写 disabled）：${statePath}`)
  }

  /**
   * 惰性重读状态文件（按 mtime+size 判变化）。
   *
   * 为什么必须有：UI 改完组合必须立即生效、不能要求重启。这个插件原来只在 apply 时读一次，
   * 于是"UI 里改了没反应"。现在每次 pre-step / 技能列举前都尝一次，改了**下一步就生效**。
   * 读失败一律沿用旧状态，绝不让它影响对话。
   */
  let stateMtime = -1
  let stateSize = -1

  /**
   * 技能轴的「改完就生效」补丁（真机实测：缺这一环技能组合根本不生效）。
   *
   * DSH 的技能目录是按 `(cwd, scope 链, revision)` 缓存在 `SkillRegistry.collectCache`
   * 里的；`revision` 只在 provider 注册/注销、或有人显式 `invalidateCache()` 时才 +1。
   * 组合器改的是**自己的状态文件**，注册关系没变 ⇒ revision 不动 ⇒ 缓存里那份旧目录
   * 会被一直用下去。实测：把全局技能组合改成只有 1 个技能之后，遮蔽 provider
   * 一次都没再跑过（日志里没有新的 `技能遮蔽` 行），模型侧仍是全部技能。
   *
   * 所以状态一变就让 DSH 的目录缓存失效。**异步做**：`refreshState()` 也可能是在
   * provider 的 `list()` 里被调的，不能在 collect 中途清缓存。
   */
  let lastSkillSig = null
  let skillInvalidatePending = false
  /* 有效签名改成"只看在用的组合"（见 skillCompositionSignature 的长注释）。 */
  const skillSigOf = skillCompositionSignature
  function invalidateSkillCatalogSoon(reason) {
    if (skillInvalidatePending) return
    skillInvalidatePending = true
    const run = () => {
      skillInvalidatePending = false
      try {
        const skills = ctx.skills
        if (skills === null || skills === undefined || typeof skills.invalidateCache !== 'function') {
          noteOnce(
            'skill-invalidate:no-api',
            '技能目录缓存失效：拿不到 ctx.skills.invalidateCache ⇒ 技能组合要重启 DSH 才生效',
          )
          return
        }
        skills.invalidateCache()
        toolDietNote(`技能目录缓存已失效（${reason}）⇒ 技能组合下一步生效`)
      } catch (error) {
        ctx.logger?.warn?.(`[composer] 技能目录缓存失效失败：${error?.message ?? error}`)
      }
    }
    try {
      setTimeout(run, 0)
    } catch {
      run()
    }
  }

  function refreshState() {
    let stamp
    try {
      const info = statSync(statePath)
      stamp = { mtimeMs: info.mtimeMs, size: info.size }
    } catch {
      return // 文件暂时不可读（正在被原子写替换）：沿用旧状态
    }
    if (stamp.mtimeMs === stateMtime && stamp.size === stateSize) return
    const next = migrateState(readJson(statePath, null))
    if (next === null) return
    state = next
    stateMtime = stamp.mtimeMs
    stateSize = stamp.size
    // 只有**技能相关**的部分真的变了才动缓存：UI 是自动保存（400ms 防抖），
    // 每次勾选都敲一次黑板会让技能目录反复重算，没必要。
    const sig = skillSigOf(state)
    if (lastSkillSig !== null && sig !== lastSkillSig) invalidateSkillCatalogSoon('组合改动')
    lastSkillSig = sig
    noteOnce(
      `state-reloaded:${stamp.mtimeMs}`,
      `组合已重载：技能「${skillCompositionFor(null) ?? '未设'}」/ 工具「${resolveCompositionName(state, 'plugin', null) ?? '未设'}」`,
    )
  }

  /** 当前 agent 生效的技能组合名（三级：会话 > 工作区 > 全局）。 */
  function skillCompositionFor(agent) {
    return resolveCompositionName(state, 'skill', agent)
  }

  /**
   * 当前 agent 需要遮蔽的技能名集合。null = 不过滤。
   *
   * **多选 = 并集**：选中的几套组合里，任何一套放行的技能都放行。
   * 但只要**有一套是「全不选」**（名单 = `[__none__]`），整组就按"全不选"处理 ——
   * 不然"我明确说了什么都不要"会被别的组合悄悄救回来。
   */
  function skillAllowSetFor(agent) {
    const names = resolveCompositionNames(state, 'skill', agent)
    if (names === null) return null
    const allow = new Set()
    let sawMembers = false
    for (const name of names) {
      const entry = state.compositions?.skill?.[name]
      if (!entry || !Array.isArray(entry.skills) || entry.skills.length === 0) continue
      if (entry.skills.length === 1 && entry.skills[0] === NONE_MEMBER) return new Set([NONE_MEMBER])
      sawMembers = true
      for (const s of entry.skills) allow.add(s)
    }
    return sawMembers ? allow : null
  }

  /**
   * 最近一次对话的会话 id / 工作区路径。
   *
   * 为什么要这么绕：组合 UI 走的是 `/dsh-capability-composer/state` 这条**裸 HTTP
   * 接口**，它没有 agent 上下文，宿主没法从请求里知道"当前在哪个工作区"。
   * 所以由 pre-step 捎带记一份，UI 拿它来显示「当前工作区」并直接给出可选项。
   */
  let lastEnv = { sessionId: null, cwd: null, at: null }
  function noteEnv(agent) {
    const keys = scopeKeysOf(agent)
    if (keys.sessionId === lastEnv.sessionId && keys.cwd === lastEnv.cwd) return
    lastEnv = { sessionId: keys.sessionId, cwd: keys.cwd, at: Date.now() }
  }

  /**
   * 完整插件目录 = 真实插件 + 一个**兜底桶**。
   *
   * 兜底桶存在的理由：认领是靠**命名空间前缀**推导的，总有工具（`sql_query`、
   * `vault_get`…）对不上任何插件的命名空间。没有兜底桶它们就永远够不着了 ——
   * 省上下文不能以丢能力为代价。
   */
  /**
   * 这两个函数**搬到模块作用域**了（`hostToolUniverse(ctx)` / `coverageReport(ctx)`）——
   * 因为 `applyToolDiet` 是模块级函数，看不见 apply 内部的声明。
   * 真机日志里那句
   *   `工具目录覆盖率：这一步算不出来 —— coverageReport is not defined`
   * 就是这么来的（幸好按"不许静默"写了证据，否则又是一次静默失效）。
   */

  function pluginCatalogAll() {
    const real = pluginCatalog()
    /* 需求大头：「组合定好了，但万一目录**没扫到**、启发式**没归上**、
       工具就**缺失**了 —— 这个必须解决，要 100% 不出问题。」
       ⇒ 目录的**权威来源必须是宿主自己的注册表**，不能是"扫插件包扫出来的"。
       无参的 `tools.schemas()` 是**全局视图**（不受任何 agent 限制影响），
       它是"这台机器上到底注册了哪些模型可见工具"的唯一权威答案。
       先把权威全集并进 `toolCatalog.names`，下面的"兜底行"就会自动把
       **任何没被插件认领的工具**都收进去 ⇒ 模型至少搜得到、加载得了，绝不"缺失"。 */
    const universe = hostToolUniverse(ctx)
    if (universe !== null) {
      const before = toolCatalog.names.size
      for (const [name, schema] of universe) {
        toolCatalog.names.add(name)
        /* 补描述：这条路以前只补名字 ⇒ 目录里 MCP 工具全是"无名氏"。 */
        if (!toolCatalog.hints.has(name) || toolCatalog.hints.get(name) === '') {
          try {
            const hint = toolHint(schema?.description)
            if (typeof hint === 'string' && hint.length > 0) toolCatalog.hints.set(name, hint)
          } catch { /* 描述拿不到就算了，名字能加载就够 */ }
        }
        if (!toolCatalog.bytes.has(name)) {
          try { toolCatalog.bytes.set(name, Buffer.byteLength(JSON.stringify(schema ?? {}), 'utf8')) } catch { /* ignore */ }
        }
        /* 修：垫目录这条路上，`mcp__*` 名字以前只进 `names`，
           没进 `mcp` 分组、也没进 `hints`（描述）⇒ 目录里既没有 `mcp:<server>` 行、
           展开也没有描述（实测 toolCatalog.mcp=0 个服务器、hints=0 条，而 names 里
           有 213 个 mcp__*）。这里补齐，让 MCP 和普通工具一样能被目录列出。
           hostToolUniverse 只有名字（没有 schema）⇒ 描述留空，不影响"能加载"。 */
        if (String(name).startsWith('mcp__')) {
          const server = mcpServerOf(name)
          if (!toolCatalog.mcp.has(server)) toolCatalog.mcp.set(server, new Set())
          toolCatalog.mcp.get(server).add(name)
          if (!toolCatalog.hints.has(name)) toolCatalog.hints.set(name, '')
        }
      }
      if (toolCatalog.names.size !== before) {
        toolDietNote(`工具目录：用**宿主注册表**垫目录 +${toolCatalog.names.size - before} 个名字 ⇒ 共 ${toolCatalog.names.size} 个`)
      }
    }
    /* 把**扫出来的**工具名也灌进全局工具目录。
       理由：deny 列表按 `toolCatalog.names` 算（见 desiredToolDeny），而这份目录原本
       只在 `observeTools()` 里累积 —— 那要等某个 agent 的 tools.schemas() 能读到东西。
       冷启动（刚重启、还没有任何会话跑过 pre-step）时它是空的 ⇒ 第一个请求不设限。
       插件扫描是**启动时就能拿到**的静态事实，用它把目录先垫上。 */
    for (const row of real) for (const t of row.tools ?? []) toolCatalog.names.add(t)
    const claimed = new Set()
    for (const row of real) for (const t of row.tools) claimed.add(t)
    /* MCP 工具**已经由各自的 mcp:<server> 行认领**（下面几行），别再进兜底桶 ——
       否则同一个工具会被两行同时认领（e2e 自检的「工具归属无重复认领 / 账目自洽」就是这么红的）。 */
    const mcpClaimed = new Set()
    for (const tools of toolCatalog.mcp.values()) for (const t of tools) mcpClaimed.add(t)
    const rest = []
    for (const name of toolCatalog.names) {
      if (claimed.has(name) || mcpClaimed.has(name)) continue
      if (String(name).startsWith('mcp__')) continue
      if (TOOL_CORE.has(name) || TOOL_META.has(name) || TOOL_RESERVED.has(name)) continue
      rest.push(name)
    }
    if (rest.length === 0 && toolCatalog.mcp.size === 0) return [...real]
    rest.sort()
    const rows = [...real]
    if (rest.length > 0) {
      rows.push({
        id: 'unassigned',
        pkg: '(composer)',
        name: '未归属工具',
        description: '还没被任何插件认领的工具（组合器的兜底桶）。',
        keywords: ['unassigned', '未归属', '其他', 'misc'],
        words: [],
        globs: [...rest],
        tools: rest,
        // 手工造的行也必须补齐**和扫描行同形状**的字段。
        //    真机翻车：snapshot 里读 `row.exactTools.length`，
        //    这一行没有这个字段 ⇒ 整个 `/state` 接口 400 ⇒ 面板显示"读不到宿主接口"。
        exactTools: [],
        uiOnly: false,
        scanCertain: false,
        registersTools: false,
        scanFiles: 0,
        bytes: rest.reduce((sum, n) => sum + (toolCatalog.bytes.get(n) ?? 0), 0),
      })
    }
    /* MCP 服务器：每个服务器一行
       `mcp__<server>__<tool>` 这些工具以前是"完全不进目录、也永不限制"，结果是几百个
       工具全量常驻（实测 414 个工具定义 / 65.6k token）。
       现在：默认同样不常驻，但**在目录里以服务器为单位列出来**，模型需要时
       `load_plugin(ids:["mcp:<server>"])` 整组加载。id 前缀固定 `mcp:`，一眼可辨。 */
    /* 修复日志刷屏（血泪教训）：
       这条以前用 `toolDietNote`（**无去重**）⇒ `pluginCatalogAll()` 每被调用一次就打一条。
       实测同一秒连打几十条**完全相同**的行，把日志桥打爆：
         [warn] dsh-desktop-log-bridge: dropped 287 message(s) over the rate limit
       ⇒ 真正的错误日志被冲掉 —— 曾有一次 `注册元工具失败`（schema type 数组）
         就是这么被埋掉的，排查绕了很久。
       改成 `noteOnce`：**key 里带内容** ⇒ 内容不变只打一次、内容变了才再打一条。 */
    {
      /* 二次修复：key 里不能再带 `names`/`hints` 的数量 ——
         那两个数**每帧都在累积**（工具陆续注册），导致"内容每次都不同"，
         于是去重形同虚设：实测 3 分钟 1092 条，把日志桥打爆。
         现在 key 只取「**服务器集合**」（那才是这条诊断真正关心的东西），
         服务器变化 ⇒ 打一条；只是名字数在涨 ⇒ 不打。 */
      const serverSig = [...toolCatalog.mcp.entries()]
        .map(([k, v]) => k + '=' + v.size)
        .join(',') || '空'
      const mcpLine = `MCP 目录行：toolCatalog.mcp 有 ${toolCatalog.mcp.size} 个服务器`
        + `（${serverSig}）`
        + ` · toolCatalog.names ${toolCatalog.names.size} 个 · 其中 mcp__ 前缀 ${[...toolCatalog.names].filter((n) => String(n).startsWith('mcp__')).length} 个`
        + ` · toolCatalog.hints ${toolCatalog.hints.size} 条`
      noteOnce(`mcp-catalog-line:${serverSig}`, mcpLine)
    }
    for (const [server, tools] of toolCatalog.mcp) {
      const list = [...tools].sort()
      rows.push({
        id: 'mcp:' + server,
        pkg: '(mcp)',
        name: server + '（MCP 服务器）',
        description: `MCP 服务器「${server}」：${list.length} 个工具。它们默认不常驻（不占上下文、不进 tools 列表）。要用其中某个：invoke_tool({ tool: "mcp__${server}__<短名>", args: {...} })，不用先加载。`,
        keywords: ['mcp', server, 'mcp服务器'],
        words: [],
        globs: [],
        tools: list,
        exactTools: list,
        uiOnly: false,
        scanCertain: true,
        registersTools: true,
        scanFiles: 0,
        bytes: list.reduce((sum, n) => sum + (toolCatalog.bytes.get(n) ?? 0), 0),
      })
    }
    return rows
  }

  /**
   * **不过滤**的插件全集 —— "世界上有哪些插件"。
   *
   * 跟 `pluginsOf` 的区别就是它**不套组合**（真机测出的 bug）：
   *    一开始让 `load_plugin` 用 `pluginsOf(null)` 做存在性判断，而 `null` 只是
   *    "用全局默认组合"，结果组合外的**已存在**插件被误报成 `unknown` ——
   *    模型会以为它压根不存在，而不是"被当前组合排除了"。
   *    总数统计（`hiddenByComposition`）同理，用过滤后的算永远是 0。
   */
  function getAllPlugins() {
    return pluginCatalogAll()
  }

  /**
   * 这个 agent 作用域里**可见的插件**。
   *
   * `agent` 传 null = 全局默认那套。
   * 组合未设、或组合是空列表 ⇒ 不过滤 ⇒ 全部可见（这就是"默认走路线二"）。
   */
  function pluginsOf(agent) {
    const all = pluginCatalogAll()
    /* 这两类行**不受组合收窄**，永远出现在目录里：
         · MCP 服务器：由 MCP 面板启停，组合管不着；
         · 兜底行「未归属工具」：**没有任何插件认领的工具**。它是"目录完整性"的最后一道闸 ——
           如果连它都被组合收窄掉，那些没被扫到的工具就**永远发现不了**（硬要求）。 */
    const alwaysRows = all.filter((row) => row.id.startsWith('mcp:') || row.id === 'unassigned')
    const pluginRows = all.filter((row) => !row.id.startsWith('mcp:') && row.id !== 'unassigned')
    const names = resolveCompositionNames(state, 'plugin', agent)
    if (names === null) return all
    const ids = new Set()
    let sawMembers = false
    for (const name of names) {
      const entry = state.compositions?.plugin?.[name]
      const list = Array.isArray(entry?.plugins) ? entry.plugins : []
      if (list.length === 0) continue
      if (list.length === 1 && list[0] === NONE_MEMBER) return alwaysRows // 全不选 ⇒ 插件一个不要，但 MCP + 兜底行照旧
      sawMembers = true
      for (const id of list) ids.add(id)
    }
    if (!sawMembers) return all
    return [...pluginRows.filter((row) => ids.has(row.id)), ...alwaysRows]
  }

  /**
   * 按会话 id 查它的工作区路径（cwd），查不到返回 null。
   *
   * 真机教训：**必须走 `ctx.get('sessions')`，不能用 `ctx.sessions`**。
   * 本插件的宿主半边只声明了 `inject = ['skills']` —— 没注入 `sessions`，所以
   * `ctx.sessions` 是 **undefined**；上一版写成 `ctx.sessions?.get?.(...)` 时，
   * 可选链把它**静默吞掉**，cwd 永远是空，于是工作区级的 pin 一条也命中不了
   * （症状：组合器 UI 里明明选了两套组合，启动器只显示一套）。
   * 本文件里所有"别的插件的命名空间"都是用 `ctx.get()` 拿的（见 applyCatalogPrompt
   * 附近的说明），这里照同一规矩来。
   * @param sessionId - 会话地址。
   * @returns `{ cwd, via }`；`via` 是诊断用的解析途径（哪条路成功/失败）。
   */
  function sessionCwdOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return { cwd: null, via: 'no-id' }
    /* ① 正规途径：sessions 服务（ctx.get，绝不写进 inject）。 */
    try {
      const svc = ctx.get?.('sessions')
      if (svc !== undefined && svc !== null && typeof svc.get === 'function') {
        const cwd = svc.get(sessionId)?.header?.cwd
        if (typeof cwd === 'string' && cwd !== '') return { cwd, via: 'sessions.get' }
        return { cwd: null, via: 'sessions.get-empty' }
      }
      /* ② 有些组合把服务直接挂在 ctx 上（当前环境没有，留作兼容）。 */
      const direct = ctx.sessions?.get?.(sessionId)?.header?.cwd
      if (typeof direct === 'string' && direct !== '') return { cwd: direct, via: 'ctx.sessions' }
      return { cwd: null, via: 'sessions-missing' }
    } catch (error) {
      return { cwd: null, via: 'sessions-threw:' + String(error?.message ?? error).slice(0, 60) }
    }
  }

  /**
   * `/effective` 的载荷：**当前生效的组合**，给启动器等其它插件读。
   *
   * 作用域优先取**调用方显式给的**（`scope.sessionId` / `scope.cwd`，见路由层的
   * 说明），没给才回落到 `lastEnv`（最近一次对话的工作区/会话，pre-step 记的）。
   * 解析与并集语义跟对话路径共用同一套代码，所以两边永远一致：
   *   · `filtering:false` ⇒ 不过滤（全部可见），调用方照旧列全部；
   *   · `filtering:true`  ⇒ 只列 `pluginPkgs` / `skillNames` 里的（`none:true` 表示一个都不要）。
   * @param scope - 可选 `{ sessionId, cwd }`；两者都空时与旧行为完全一致。
   */
  function effectivePayload(scope) {
    const wantedId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : null
    let wantedCwd = typeof scope?.cwd === 'string' && scope.cwd !== '' ? scope.cwd : null
    /* 只给了 sessionId 时，从宿主自己的会话表补出 cwd —— 工作区级的 pin 也要能命中。 */
    let cwdVia = wantedCwd !== null ? 'given' : null
    if (wantedId !== null && wantedCwd === null) {
      const probe = sessionCwdOf(wantedId)
      cwdVia = probe.via
      if (probe.cwd !== null) wantedCwd = probe.cwd
    }
    const env = wantedId !== null || wantedCwd !== null
      ? { sessionId: wantedId, cwd: wantedCwd, at: Date.now(), explicit: true, cwdVia }
      : { ...lastEnv, explicit: false, cwdVia: null }
    const agentLike = {
      session: { id: env.sessionId ?? undefined, header: { cwd: env.cwd ?? undefined } },
    }
    const fromOf = (facet) => {
      const pinned = state?.pinned?.[facet] ?? {}
      const sessionMap = state?.session?.[facet] ?? {}
      if (env.sessionId !== null && pinToList(sessionMap[env.sessionId]) !== null) return '当前会话'
      if (env.cwd !== null && pinToList(pinned[env.cwd]) !== null) return '当前工作区'
      if (pinToList(pinned['*']) !== null) return '全局'
      return null
    }
    const namesFor = (facet) => resolveCompositionNames(state, facet, agentLike)
    const merge = (facet, names, ax) => {
      if (names === null) return { filtering: false, none: false, ids: [], names: [] }
      const ids = new Set()
      let sawMembers = false
      for (const name of names) {
        const entry = state.compositions?.[facet]?.[name]
        const list = Array.isArray(entry?.[ax]) ? entry[ax] : []
        if (list.length === 0) continue
        if (list.length === 1 && list[0] === NONE_MEMBER) return { filtering: true, none: true, ids: [], names }
        sawMembers = true
        for (const id of list) ids.add(id)
      }
      return { filtering: sawMembers, none: false, ids: [...ids], names }
    }

    const pNames = namesFor('plugin')
    const sNames = namesFor('skill')
    const p = merge('plugin', pNames, 'plugins')
    const s = merge('skill', sNames, 'skills')
    const rows = pluginCatalogAll()
    const pkgs = p.filtering ? rows.filter((row) => p.ids.includes(row.id)).map((row) => row.pkg).filter((x) => typeof x === 'string' && x !== '') : []
    return {
      ok: true,
      at: Date.now(),
      from: fromOf('plugin') ?? fromOf('skill'),
      names: pNames ?? sNames ?? [],
      plugin: { filtering: p.filtering, none: p.none, ids: p.ids, pkgs, from: fromOf('plugin') },
      skill: { filtering: s.filtering, none: s.none, names: s.ids, from: fromOf('skill') },
      /* 本次解析**实际用的**作用域 —— 调用方据此判断"我看到的是不是我自己那一级"
         （`explicit:false` 表示没带参数、用的是 lastEnv 兜底，可能已经过期）。
         `cwdVia` 是诊断字段：cwd 从哪条路解析出来的（sessions.get / given / 失败原因）。 */
      env: { sessionId: env.sessionId, cwd: env.cwd, explicit: env.explicit === true, cwdVia: env.cwdVia ?? null },
      totals: { plugins: rows.length },
      /* 目录完整性：宿主注册表里的工具是不是**全部**都在目录里。
         `missing` 必须永远是空的 —— 不为空就是"模型永远发现不了某个工具"（最要紧的一条）。
         体检脚本直接断言这一项。 */
      coverage: coverageReport(ctx),
    }
  }

  /**
   * 当前 agent 生效的**插件可见范围**（展开成工具 glob 列表）。
   * null = 不过滤 ⇒ 该作用域内**全部插件**的目录行都进模型上下文。
   * 非 null：只有列出的插件进目录；范围外的插件**连名字都进不了目录**，
   * 但插件本身照常运行、界面照常显示。
   */
  function toolScopeGlobsFor(agent) {
    const all = pluginCatalogAll()
    const visible = pluginsOf(agent)
    if (visible.length >= all.length) return null
    const globs = []
    for (const row of visible) {
      // 认领不到工具的插件也要收窄：用 id 当命名空间兜底，绝不因为"查不到"就放过。
      globs.push(...(row.globs.length > 0 ? row.globs : [`${row.id}_*`]))
    }
    // 名单**非空**却一个插件都没匹配上 = 客户端点了「全不选」（写的是哨兵 `__none__`）。
    //    这时不能退回 null（那等于"不过滤"，比要求更宽），要返回一个**永不匹配**的 glob。
    //    （空数组的名单仍然是"不过滤"，语义不变。）
    return globs.length > 0 ? [...new Set(globs)] : [NEVER_GLOB]
  }

  /**
   * 给系统提示用的**插件目录文本**。
   *
   * 这是路线二的"目录"那一半：模型看到的是**插件**（名字 + 描述 + 启用关键词），
   * 跟技能目录完全同构；工具一个都不列。需要哪个插件，用 `load_plugin` 整组拉进来。
   */
  /* 目录段的**会话内快照**（本轮最高价值修复）
   *
   * 为什么要（实测铁证）
   * 诊断脚本把 8 次 system 文本变化
   * **逐行打印**出来，发现**全部是同一处**：
   *     A: `- unassigned · 未归属工具 … · 12 个工具`
   *        `- mcp:vnpy · vnpy（MCP 服务器） · … · 213 个工具`
   *     B: `- unassigned · 未归属工具 … · 11 个工具`（**没有** mcp:vnpy 那一行）
   * 时间线：`00:40:27 → 00:40:37 → 01:38:51 → 01:39:03 → 01:52:57 → 01:53:14 → 03:00:21 → 03:00:37`
   *
   * 为什么贵
   * system prompt 是 provider 看到的 prompt 的**最前面**（在 messages 之前）。
   * DeepSeek 前缀缓存**从 token 0 连续匹配** ⇒ 这一段动 **128 字符**，
   * **整份 18,888 字符的前缀全部失效**（含后面所有历史 messages）。
   * 实测代价：system-prompt 类失缓 **9,012,979 tok ≈ ¥1.26/天**（峰值曾达 ¥64M）。
   *
   * 为什么这是"修正"而不是"绕过"
   * 「未归属工具有几个」与「MCP 此刻是否可见」都是**运行时状态**，
   * 而目录段的语义是「**这个工作区有哪些插件可以加载**」—— 后者才是"稳定前缀"该有的内容。
   * 把运行时状态放进最靠前的前缀，本身就是放错了位置。
   *
   * 修法
   * 按 **agent** 快照。只有「**真实插件行**的 id 集合」变化（= 真的有插件装卸）才重算；
   * `unassigned` 的计数抖动、`mcp:*` 行的出现/消失**不再触发重算**。
   *
   * 取舍（明说）
   * 会话中途新出现的 MCP 服务器 / 新增的未归属工具**不会**立刻反映到**这一段**里。
   * 但：`search_plugins` 是**实时**的（不走这个缓存）⇒ 模型仍能搜到并 `load_plugin` 加载，
   * 只是"目录这一段"保持不变。**对"能做什么"没有损失，对"前缀稳定"是决定性的收益。**
   */
  const CATALOG_GLOBAL_KEY = { note: '(global/agent=null)' }
  /** agent 对象（或全局哨兵）→ `{ sig, text }`。WeakMap 防泄漏。 */
  const catalogSnapshots = new WeakMap()
  const catalogKeyOf = (agent) => (agent !== null && typeof agent === 'object' ? agent : CATALOG_GLOBAL_KEY)
  /** 快照签名的计算口径 —— **排除** `unassigned` 与 `mcp:*`（那两类会抖）。 */
  const catalogSigOf = (rows) => rows
    .filter((r) => r.id !== 'unassigned' && !String(r.id).startsWith('mcp:'))
    .map((r) => `${r.id}:${(r.tools ?? []).length}`)
    .join('|')

  function pluginCatalogPromptText(agent) {
    const rows = pluginsOf(agent)
    if (rows.length === 0) return null
    /* 快照命中 ⇒ 直接返回上一次的文本（这就是"会话内稳定"）。
       **不缓存 null**：组合未就绪时返回 null 让官方走 fallback，
          之后组合就绪必须能恢复（缓存 null 会永久 fallback）。 */
    const key = catalogKeyOf(agent)
    const sig = catalogSigOf(rows)
    const snap = catalogSnapshots.get(key)
    if (snap !== undefined && snap.sig === sig) return snap.text
    const lines = [
      '# 可用插件与 MCP 工具',
      '',
      '**调用方式（重要）**：本目录列出的工具**一律不常驻** —— 它们不进你的 tools 列表，',
      '以此保持请求前缀稳定、不被缓存失效惩罚。',
      '要用其中任何一个：**直接调用** `invoke_tool({ tool: "<完整工具名>", args: {...} })`，',
      '它会按名字转发执行，**不需要事先加载**。例：`invoke_tool({ tool: "mcp__vnpy__run_backtest", args: {...} })`。',
      '完整工具名的规则：MCP 工具是 `mcp__<服务器>__<短名>`（双下划线；下面每个 MCP 服务器都列出了它的短名）；',
      '插件工具的完整名就是**工具原名**，不带任何前缀。',
      '（`load_plugin` 仍可用，但它会让 tools 列表变化 ⇒ 打断前缀缓存、代价很大；除非确实需要"常驻"，否则请优先用 `invoke_tool`。）',
      '目录里没列的插件 = 当前组合把它排除了（它本身仍在运行，只是你看不到）。',
      'MCP 服务器也在本目录里（id 以 `mcp:` 开头），它们的工具同样默认不常驻。',
      '',
    ]
    for (const row of rows) {
      const kw = (row.keywords ?? []).join(' ')
      lines.push(`- ${row.id} · ${row.name ?? row.id}${kw ? ` · ${kw}` : ''} · ${row.tools.length} 个工具`)
      if (typeof row.description === 'string' && row.description.length > 0) lines.push(`  ${row.description}`)
      /**
       * （追问"不只是 mcp 吧插件也是？"）：**插件行也列出工具名**。
       *
       * 原来插件行只有「若干工具」四个字 ⇒ 模型看不到里面有什么工具 ⇒
       * 只能整插件 load_plugin（把该插件所有工具一次注册，代价大）；
       * 而 MCP 行早就列了短名，两边待遇不一致。
       *
       * 与 MCP 的关键差别：
       *   · MCP 工具的调用名有前缀：mcp__<server>__<短名>
       *   · **插件工具的调用名就是工具原名**（没有插件前缀）—— 这点必须写清楚，
       *     否则模型会去猜 `<插件id>.<工具名>` 之类（MCP 那边它就猜错了三次）。
       *
       * 加载粒度差别：插件**不支持**单个工具加载（load_plugin 的单位是插件），
       * 所以这里给的是"加载后即可获得这些工具"的清单，而不是"挑一个加载"。
       *
       * 加新插件 ⇒ 自动套用（列表来自 toolCatalog，无硬编码）。
       */
      if (!String(row.id).startsWith('mcp:') && String(row.id) !== 'unassigned') {
        const toolList = Array.isArray(row.tools) ? row.tools : []
        if (toolList.length > 0) {
          const head = toolList.slice(0, 12)
          lines.push(`  （调用：invoke_tool({ tool: "<下面任一名字>", args: {...} }) —— 不用先加载；`)
          lines.push(`     下面这些名字就是**工具原名**，不带任何前缀：）`)
          for (const tn of head) {
            const hint2 = toolCatalog.hints.get(tn)
            const h2 = typeof hint2 === 'string' && hint2.length > 0 ? smartShortHint(hint2, 56) : ''
            lines.push(`    · ${tn}${h2 ? ' — ' + h2 : ''}`)
          }
          if (toolList.length > head.length) lines.push(`    …另 ${toolList.length - head.length} 个（用 search_plugins 可搜到）`)
        }
      }
      /**
       * （按方案）：MCP 服务器**展开列出每个工具的名字 + 一行描述**。
       *
       * 为什么：以前 MCP 只渲染成一行「213 个工具」⇒ 模型不知道有哪 213 个
       * ⇒ 只能 `load_plugin(["mcp:vnpy"])` 整组加载 ⇒ 213 个完整 schema 全进请求头
       * （实测每帧工具定义 4,740 → 24,209 tok，而整个会话只用 26 个）。
       *
       * 现在把「名字 + 描述」列出来（描述走 toolCatalog.hints，来源是 schema.description
       * 首行截断）⇒ 模型照抄一个名字即可精确加载：
       *   load_plugin({ ids: ["mcp:vnpy__run_backtest"] })
       * 这正是当初否掉「工具名粒度」的原因（当时没有名字可抄），现在不成立了。
       *
       * 加新 MCP / 新工具 ⇒ 自动出现在这里，零维护。
       */
      if (String(row.id).startsWith('mcp:')) {
        /**
         * 压缩版（"嫌大，压"）：
         *   · 去掉公共前缀 `mcp__<server>__` —— 213 个工具省掉 ~2.6K 字符；
         *   · 描述截到 40 字符（只用来"挑"，不用来读全）；
         *   · 顶部给一行拼接口诀，模型据此还原完整 id。
         * 加新 MCP / 新工具 ⇒ 自动套用同一规则，零维护。
         */
        /* 拼接口诀必须与 load_plugin 实际接受的形式**逐字一致**：
           接受的是 `mcp:<server>__<短名>`（带冒号），不是 `mcp__<server>__<短名>`。
           （首版口诀写成了下划线形式 ⇒ 模型会拼错 id 判 unknown。） */
        const server = String(row.id).slice(4)
        const prefix = 'mcp__' + server + '__'
        const firstShort = String(row.tools?.[0] ?? '<短名>').replace(prefix, '')
        /**
         * 二次修正（真机截图为证）：首版把引导语写成"列表前的 3 行"，
         * 下方 107 行短名列表直接把它淹没了 —— 模型看到短名 `get_gateway_status` 后，
         * 以为那是"已注册的工具名"，于是连拼三种前缀去**直接调用**：
         *   unknown tool "mcp_vnpy__get_gateway_status"
         *   unknown tool "vnpy__get_gateway_status"
         *   unknown tool "mcp:vnpy.get_gateway_status"
         * 正确做法是把短名当作 **load_plugin 的 id**，而不是工具名。
         * ⇒ 改成醒目的"步骤式"说明，并**明确写出反面例子**。
         */
        lines.push('')
        /**
         * 三次修正（真机截图为证）：
         * 模型做对了"加载"（load_plugin 用 mcp:vnpy__xxx），但**调用时连猜三个名字都错**：
         *   unknown tool "mcp_vnpy__get_gateway_status"   （下划线）
         *   unknown tool "get_gateway_status"             （没前缀）
         *   unknown tool "vnpy.get_gateway_status"        （点）
         * 根因：**加载名和调用名是两个不同的字符串** ——
         *   加载（load_plugin 的 id）： mcp:<server>__<短名>   ← 有冒号
         *   调用（真正的工具名）：      mcp__<server>__<短名>  ← 没冒号，双下划线
         * 上一版只教了"怎么加载"，第 2 步写成"像普通工具一样调用"⇒ 模型无从得知调用名。
         * ⇒ 现在把两个名字**并排写死**，并给出一条完整的正例。
         */
        lines.push(`  ✅ 用法（一步，**不用先加载**）：invoke_tool({ tool: "<完整工具名>", args: {...} })`)
        lines.push(`     完整工具名 = 下面短名前面补 **mcp__${server}__**（双下划线）。`)
        lines.push(`     例：短名 ${firstShort} ⇒ invoke_tool({ tool: "mcp__${server}__${firstShort}", args: {...} })`.replace(/\$\{firstShort\}/g, firstShort))
        lines.push(`  ⛔ 别用 mcp_${server}__短名（单下划线）、别漏前缀、别用点号 —— 那些一律 unknown tool。`)
        lines.push(`  ⛔ 也别把这个短名当成"已注册工具名"直接 tool_call —— **下面前缀省掉了，短名本身不是完整名**。`)
        /**
         * 三次修正（真机会话 694d7e41 的思考过程为证）：
         *   模型在**同一步**里同时发了 load_plugin 和 mcp__vnpy__xxx ⇒ DSH 并行执行
         *   ⇒ load_plugin 的 restrict() 还没落到这一帧的请求头 ⇒ 调用报 unknown tool。
         *   模型自己诊断出来了（它读到了 residentTools=30 enabledPlugins=0 loadedTools=0），
         *   然后"单独重新 load 一次"就成功了。
         *   ⇒ 把这条写成硬性规矩，省掉那一轮试错。
         */
        lines.push(`  ⏱️ invoke_tool 是**同步执行**：发出后当场返回结果 —— 没有"加载是否生效"的时序问题，`)
        lines.push(`     可以在同一个 assistant 步里连续调用多个工具。`)
        lines.push(`  🚫 常见错法（都会报 unknown tool）：`)
        lines.push(`     · "mcp_${server}__<短名>"（冒号写成下划线）`)
        lines.push(`     · "${server}.<短名>" 或 "${server}__<短名>"（少了 mcp__ 前缀）`)
        lines.push(`     · "mcp:${server}.<短名>"（点号）`)
        lines.push(`  ⚠️ 只写 "mcp:${server}" 会把全部 ${String(row.tools?.length ?? 0)} 个工具一次性注册，代价大得多，非必要不要用。`)
        const shorts = []
        for (const toolName of (row.tools ?? [])) {
          const short = String(toolName).startsWith(prefix) ? String(toolName).slice(prefix.length) : String(toolName)
          const hint = toolCatalog.hints.get(toolName)
          const h = typeof hint === 'string' && hint.length > 0 ? smartShortHint(hint, 56) : ''
          shorts.push(h ? `${short} — ${h}` : short)
        }
        /* 改回**一行一个**。
           原来两列挤压（"A — 描述 ｜ B — 描述"）在长中文描述下会视觉断裂，
           反而难读。一行一个换来的清晰度 > 省下的一半行数。 */
        for (const line of shorts) lines.push('    ' + line)
      }
    }
    const text = lines.join('\n')
    catalogSnapshots.set(key, { sig, text })
    /* 只在**真的重算**时留证据（快照生效后不该频繁重算）。 */
    if (snap !== undefined) {
      noteOnce(
        `catalog-snapshot-refresh:${sig.slice(0, 60)}`,
        `插件目录段重算（真实插件集合变了）：${snap.sig.slice(0, 60)} → ${sig.slice(0, 60)}`
        + ' —— 注意：`unassigned` 计数与 `mcp:*` 行的抖动**不会**再触发重算（2026-09-22 修复）。',
      )
    }
    return text
  }

  // ① 技能遮蔽 provider
  //
  // 关键点：provider.list() 内部会调用 ctx.skills.list() 拿到「其他 provider 提供
  // 的全部技能」，再为不在组合里的那些发同名遮蔽项。这会重入到本 provider，所以
  // 必须用 inList 标志把内层调用短路掉；短路后内层拿到的正好是「别人家的技能」。
  let inList = false
  /**
   * 造一个遮蔽 provider。`nested` 是"要往哪一层问内层技能"的那个 skills 服务：
   * 全局层用 `ctx.skills`，按 agent 注册时用 `agent.ctx` 的服务。
   */
  function makeShadowProvider(nested) {
    return {
      name: 'capability-composer',
      async list(lookup) {
        if (inList) return []
        // UI 可能刚改过组合 —— 列举前先重读一次，改完下一步就生效（不用重启）。
        refreshState()
        const allow = skillAllowSetFor(lookup?.scope)
        if (allow === null) {
          noteOnce('skill-shadow:no-allow', '技能遮蔽：组合未设或为空 ⇒ 不过滤（全部技能照旧进目录）')
          return []
        }
        inList = true
        let all = []
        try {
          all = await nested.list(lookup)
        } catch (error) {
          // 内层列举失败 = 这次一条都遮蔽不了。必须留下证据，否则表现和"没生效"一模一样。
          noteOnce(`skill-shadow:nested-fail:${error?.message ?? error}`, `技能遮蔽：内层列举失败，本次不遮蔽 —— ${error?.message ?? error}`)
          return []
        } finally {
          inList = false
        }
        const shadows = []
        for (const skill of all) {
          if (allow.has(skill.name)) continue
          shadows.push({
            name: skill.name,
            description: skill.description,
            invocation: { ...(skill.invocation ?? {}), modelInvocable: false },
            source: skill.source ?? 'composer',
            provider: 'capability-composer',
            rank: 0, // 最低 rank 者胜出，遮蔽原技能
            locator: skill,
          })
        }
        noteOnce(
          `skill-shadow:${allow.size}:${all.length}:${shadows.length}`,
          `技能遮蔽：allow=${allow.size}（${[...allow].slice(0, 8).join('、')}）内层看到=${all.length} 遮蔽=${shadows.length}`,
        )
        return shadows
      },
      get(candidate) {
        return Promise.resolve(candidate.locator)
      },
    }
  }
  /* 全局层那份**保留**（没有 preset 层的部署就靠它）。 */
  ctx.skills.registerProvider((_control) => makeShadowProvider(ctx.skills))

  /* **每个 agent 再挂一份「就近层」遮蔽** —— 这是 15k 技能目录的真凶。
   *
   * `dsh-skill` 的 SkillRegistry 文档原文：
   *   「A read merges the global layer with the viewing scope's chain — **the nearest
   *     layer's entry wins a duplicate name outright**, and the rank order decides
   *     duplicates only within one layer.」
   * 而技能是由 **agent preset 的常驻挂载层**提供的（比全局层更近）。
   * ⇒ 全局层里 rank=0 的遮蔽项**盖不住它**：日志写着「遮蔽=184」，
   *   而会话存档里的**真实注入**仍是 15,021 tokens（≈185 条全量）。工具那半已经
   *   收到 30 个了，技能这半却是全量 —— 就是这个原因。
   * ⇒ 必须在 agent 自己的层里注册（最近层 ⇒ 同名直接胜出）。
   */
  let agentShadowDisposers = null
  function ensureAgentSkillShadow(agent) {
    try {
      const skills = agent?.ctx?.get?.('skills') ?? agent?.ctx?.skills
      if (skills === undefined || skills === null || typeof skills.registerProvider !== 'function') {
        noteOnce('skill-shadow:no-agent-scope', '技能遮蔽：拿不到 agent 作用域的 skills ⇒ 只能靠全局层那份（preset 层可能盖不住）')
        return false
      }
      if (agentShadowDisposers === null) agentShadowDisposers = new WeakMap()
      if (agentShadowDisposers.has(agent)) return true
      agentShadowDisposers.set(agent, skills.registerProvider((_control) => makeShadowProvider(skills)))
      toolDietNote('技能遮蔽：已在 agent 就近层挂上遮蔽 provider（同名直接胜出，preset 层那份也盖得住）')
      /* 实测补的**第二次**失效（症状：「新会话第一步技能还是全量 18k」）。
       *
       * 病灶：遮蔽 provider 是**这一步**才挂到 agent 就近层的，而技能注册表的快照缓存
       * `(cwd, scope 链, revision)` 可能在本步 `snapshot()` **之前**就已经建好并缓存了 ——
       * 那一份是"没有遮蔽"的全量目录。原来只在**插件挂载时**敲过一次黑板（2255 行），
       * 对"挂载之后才出现的新 agent"完全无效。
       * ⇒ 每挂上一个新 agent 的就近层遮蔽，立刻再敲一次黑板，
       *    保证**这个 agent 的第一次 snapshot 就带遮蔽**（第一步就不再吃全量 18k）。 */
      invalidateSkillCatalogSoon('新 agent 就近层遮蔽已挂载 ⇒ 让缓存重建')
      return true
    } catch (error) {
      noteOnce(`skill-shadow:agent-fail:${error?.message ?? error}`, `技能遮蔽：挂 agent 层失败 —— ${error?.message ?? error}`)
      return false
    }
  }
  /* 技能目录的**硬闸门**（实测抓到 15.7k 之后的兜底）
   *
   * 实测（会话 `session-abd8e6e5`，「41k 里技能占 18k」就是它）：
   *   那个会话的 `skill-catalog` 注入项一直挂着 **15,748 tokens**（= 全量 185 条），
   *   而同一时刻新建的会话只有 284。也就是说：
   *   · 本插件的**全局**遮蔽 provider 生效（新会话 284 ✓）；
   *   · 但**老会话 / 被恢复的会话**吃的是技能注册表里那份（cwd, scope, revision）缓存，
   *     那条链上的 provider 从没被再调用过（日志里 `技能遮蔽：allow=` 本次启动只出现 1 次）⇒
   *     旧目录原封不动留在历史里，digest 也没变 ⇒ `dsh-tool-skill` 认为"没变化"，不替换。
   *
   * 与其继续赌注册表的层/缓存语义，这里直接**接管最终的 pre-step 决定**：
   * 用 `{prepend:true}` 站在瀑布最前面 ⇒ `await next()` 之后拿到链上所有人算完的 decision，
   * 再把里面那份技能目录**按允许集合就地裁小**。格式不动（照抄原来的条目行），
   * 所以模型看到的还是一份合法的技能目录，只是只剩组合允许的那几个。
   * ⇒ 这是"不论缓存/层怎么变，注入进去的技能目录绝不会是全量"的**硬保证**。
   */
  const SKILL_CATALOG_MARK = '<available_skills>'
  /** 累计"完全重复的目录注入被丢掉"的次数（给低频汇总证据行用）。 */
  let skillDroppedCopies = 0  /** 从消息里取出文本（content 是 block 数组）。 */
  function messageText(message) {
    const content = message?.content
    if (!Array.isArray(content)) return null
    const parts = []
    for (const block of content) {
      if (block === null || block === undefined || block.type !== 'text') continue
      if (typeof block.text !== 'string') continue
      parts.push(block.text)
    }
    return parts.length === 0 ? null : parts.join('\n')
  }
  /** 按允许集合裁一份技能目录文本；没变化就返回 null。 */
  function shrinkSkillCatalogText(text, allow) {
    const start = text.indexOf(SKILL_CATALOG_MARK)
    if (start < 0) return null
    const endMark = '</available_skills>'
    const end = text.indexOf(endMark, start)
    if (end < 0) return null
    const head = text.slice(0, start + SKILL_CATALOG_MARK.length)
    const body = text.slice(start + SKILL_CATALOG_MARK.length, end)
    const tail = text.slice(end)
    const lines = body.split('\n')
    const kept = []
    let matched = 0
    for (const line of lines) {
      const m = /^-\s+`?([^`:\s]+)`?\s*:/.exec(line.trim())
      if (m === null) { kept.push(line); continue }
      matched += 1
      if (allow.has(m[1])) kept.push(line)
    }
    /* 一条条目都没认出来 ⇒ 说明格式与设想的不一样 —— **宁可不动**，
       否则会把整份目录删成空壳（模型再也发现不了任何技能），那是比"目录大了点"严重得多的事故。 */
    if (matched === 0) return null
    const next = head + kept.join('\n') + tail
    if (next.length === text.length) return null
    return next
  }
  /** 把一个消息的文本换掉（浅拷贝，别动原对象）；给了 `entries` 就**同时**换 source.entries。 */
  function withRewrittenText(message, text, entries) {
    const content = Array.isArray(message?.content) ? message.content : []
    const next = Object.assign({}, message, {
      content: content.map((block) => (block !== null && block !== undefined && block.type === 'text'
        ? Object.assign({}, block, { text })
        : block)),
    })
    /* 只改正文、不改 `source.entries` = **记录与正文不一致**：上游 `catalogHistory()` 算 digest
       用的是 entries ⇒ 它算出旧的全量 digest（159 条），跟当前技能快照（2 条）永远对不上
       ⇒ 上游每一步都重发一条目录（实测日志 `169 个技能 → 2 个（967 字符 → 967 字符，省约 0 tokens）`
       就是这么来的：正文已经是 2 行，entries 还写着 169）。 */
    if (Array.isArray(entries) && message?.source !== null && message?.source !== undefined) {
      next.source = Object.assign({}, message.source, { entries })
    }
    return next
  }
  /**
   * 把 decision 里那份技能目录裁到只剩允许的技能。返回 { decision, before, after }。
   * `allow === null`（组合未设）⇒ 不动，这是"不过滤"的正常分支。
   */
  function shrinkSkillCatalog(agent, decision) {
    /* 这道「硬闸门」在 1821 行 composer 日志里**一次都没触发过**
       （从来搜不到 `技能目录：注入前裁小`），而它本该是"技能目录绝不会是全量"的最后保证。
       说明它一直卡在下面某个**静默 early-return** 上 —— 按本项目自己的契约
       「不许静默不生效」，每条 early-return 都必须留下证据行，否则哑掉也没人知道。 */
    if (decision === null || decision === undefined || typeof decision !== 'object') {
      noteOnce('skill-shrink:no-decision', '技能目录硬闸门：拿不到 decision ⇒ 本次不裁（注入什么就是什么）')
      return { decision }
    }
    if (decision.kind === 'reject') return { decision }
    let allow = null
    try { allow = skillAllowSetFor(agent) } catch { allow = null }
    if (allow === null) {
      noteOnce('skill-shrink:no-allow', '技能目录硬闸门：组合未设 ⇒ 不过滤（正常分支，全量目录照常注入）')
      return { decision }
    }
    const messages = Array.isArray(decision.messages) ? decision.messages : null
    if (messages === null) {
      noteOnce(
        'skill-shrink:no-messages',
        `技能目录硬闸门：decision.messages 不是数组（实测键=${Object.keys(decision).join(',')}）`
        + ' ⇒ 这一版**裁不了**，技能目录靠遮蔽 provider 收窄',
      )
      return { decision }
    }
    let before = 0
    let after = 0
    let sawMarker = 0
    const next = messages.map((message) => {
      const text = messageText(message)
      if (text === null || text.indexOf(SKILL_CATALOG_MARK) < 0) return message
      sawMarker += 1
      const shrunk = shrinkSkillCatalogText(text, allow)
      if (shrunk === null) return message
      before += text.length
      after += shrunk.length
      /* 真机铁证：**绝对不要动 `source.entries`** —— 这是"每步重发目录"死循环的根源。
       *
       * 现场（本会话，每看到一次就说明又发了一次）：这一轮对话里**连续 6 次**
       * 看到同一条 `The available skill catalog changed … <available_skills>`（8 条），
       * 而且 surfaceOp 每步 +2、`series` 请求头每步 +1。
       *
       * 上游 `dsh-tool-skill` 的判据（`catalogHistory()`）是：
       *   `history.visibleDigest`（**最后一条可见目录的 `source.entries`** 的 digest）
       *   `=== digest`（**当前技能快照**的 digest）
       * 不等 ⇒ 重发一份完整目录。
       *
       * 而旧会话的技能快照**始终是全量 186 条**（就近层遮蔽没生效）。所以：
       *   · 把 `entries` 也裁成 8 条 ⇒ visibleDigest(8) ≠ digest(186) ⇒ **每步重发**
       *   · `entries` 保持上游原样(186) ⇒ visibleDigest(186) === digest(186) ⇒ **不再重发**
       *
       * 那次改动（"正文裁了、entries 也必须跟着裁，否则记录与正文不一致 ⇒ 上游每步重发"）
       * **结论是反的**：它恰恰制造了这个循环。真机日志证据：`注入前裁小 —— 59914 字符 → 2169 字符`
       * 连续 12+ 步、每步都伴随一次"旧目录→指路牌"的改写。
       *
       * 为什么保持全量**不影响省量**：模型看到的是**正文**（正文独立渲染），实测模型侧就是 8 条
       * （本轮对话里那 6 次注入都只有 8 条）⇒ 省量照旧，而历史节点不再每步变化 ⇒ 前缀缓存放过。
       *
       * 安全阀：万一某个上游版本改成用 `entries` 渲染正文（那就会出现"模型看到全量"），
       * 设 `DSH_COMPOSER_SHRINK_ENTRIES=1` 可恢复旧行为（跟着裁）。 */
      if (SHRINK_ENTRIES) {
        const sourceEntries = Array.isArray(message?.source?.entries) ? message.source.entries : null
        const keptEntries = sourceEntries === null
          ? undefined
          : sourceEntries.filter((entry) => entry !== null && typeof entry === 'object' && allow.has(entry.name))
        return withRewrittenText(message, shrunk, keptEntries)
      }
      noteOnce(
        'skill-shrink:entries-kept',
        '技能目录硬闸门：**只裁正文、不动 `source.entries`**（2026-09-21 根治"每步重发目录"的死循环：'
        + '上游拿"最后可见目录的 entries digest"比"当前快照 digest"，我们一裁 entries 就永远对不上 ⇒ 每步重发一份全量目录，'
        + '而目录消息在会话第 2 条附近 ⇒ 后面整个前缀缓存每步全废）。'
        + '模型看到的是正文（独立渲染），所以省量不变。需要恢复旧行为设 DSH_COMPOSER_SHRINK_ENTRIES=1。',
      )
      return withRewrittenText(message, shrunk)
    })
    if (sawMarker === 0) {
      noteOnce(
        'skill-shrink:no-marker',
        `技能目录硬闸门：这一轮的 decision.messages（${messages.length} 条）里**没有** ${SKILL_CATALOG_MARK} `
        + '⇒ 本次注入是"无目录"或格式变了，没东西可裁',
      )
      return { decision }
    }
    if (after === 0 && before === 0) {
      noteOnce(
        'skill-shrink:no-change',
        `技能目录硬闸门：认到目录但裁不动（allow=${allow.size}）—— 逐条比对没命中任何技能名`,
      )
      return { decision }
    }

    /* **注入前丢掉"完全重复的目录"** —— 这是长会话最大的缓存杀手。
     *
     * 现场（真机日志，会话 session-df0a83c1，`17:27:08` 起每步一次）：
     *   技能目录：注入前裁小 —— **59914 字符 → 2169 字符**（每步都是这个数）
     *   技能目录：已把 1 条被最新目录取代的旧目录换成指路牌（seq=102,112,122,…每步 +1）
     *   技能目录：已把 1 条**旧指路牌**压成极短占位（seq=109,119,129,…）
     *
     * 也就是说：上游每步都重发一份**全量**目录（186 条 / 59,914 字符），本插件每步裁一次、
     * 再每步把上一份换成指路牌 —— **每步 2 次表面改写**。而目录消息落在会话**第 2 条附近**，
     * 一改就把**后面整个请求前缀的缓存全部作废**（实测该会话未命中 29,267 tok/轮，
     * 而同机器全新会话只有 6,982 tok/轮）。
     *
     * 为什么上游会每步重发：`dsh-tool-skill` 拿 `catalogHistory()`（**最后一条可见目录**的
     * entries digest）跟**当前技能快照**的 digest 比。裁了正文和 `entries`，
     * 但**快照仍是全量**（186 条）⇒ 两边永远不等 ⇒ 每步重发。这是本插件自己造成的循环。
     *
     * 根治点就是**注入前**：如果这一份（裁完之后的）目录跟**表面上最后一份可见目录**
     * **条目完全相同**，那么它对模型没有任何新信息 ⇒ 直接丢掉这次注入，
     * 让历史里那份继续生效。这样：既不新增事件、也不改写旧节点 ⇒ **前缀稳定、缓存不废**。
     *
     * 保守性：只丢**条目集合完全相等**的（用 名字+描述 的排序 JSON 比较，跟正文格式无关）；
     * 只要组合变了 / 技能集合变了 / 描述变了，就照常注入。首次丢弃留一行证据，之后每 100 次汇总一行。
     */
    const lastVisible = (() => {
      try {
        const list = visibleSkillCatalogs(agent?.session)
        return list.length === 0 ? null : list[list.length - 1]
      } catch {
        return null
      }
    })()
    if (lastVisible !== null && Array.isArray(lastVisible.entries) && lastVisible.entries.length > 0) {
      const keyOf = (entries) => {
        try {
          return JSON.stringify(
            entries
              .filter((e) => e !== null && typeof e === 'object')
              .map((e) => [e.name, e.description])
              .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
          )
        } catch {
          return null
        }
      }
      /* 两边都要按 `allow` 过滤后再比：`lastVisible.entries` 现在**保持上游原样**（可能 186 条），
         而新注入那份也要过滤 —— 只比"模型实际会看到的条目集合"。 */
      const lastKey = keyOf(lastVisible.entries.filter((e) => e !== null && typeof e === 'object' && allow.has(e.name)))
      let droppedCopies = 0
      const kept = []
      for (const message of next) {
        const isCatalog = message?.source?.kind === SKILL_CATALOG_SOURCE_KIND
          && messageText(message)?.indexOf(SKILL_CATALOG_MARK) >= 0
        if (isCatalog) {
          const entries = Array.isArray(message?.source?.entries) ? message.source.entries : null
          /* 新注入那份的 entries 是**全量**（上游给的）；要拿裁完的集合跟最后可见的比。 */
          const mine = entries === null
            ? null
            : entries.filter((e) => e !== null && typeof e === 'object' && allow.has(e.name))
          if (mine !== null && lastKey !== null && keyOf(mine) === lastKey) {
            droppedCopies += 1
            continue
          }
        }
        kept.push(message)
      }
      if (droppedCopies > 0) {
        /* 保守护栏：**别把这一步的 decision 清空**。真实情况下 decision 里还有用户那条消息，
           但万一某天格式变了只剩目录一条，丢掉它会让这一步"一条消息都没有" ⇒ 宁可照常注入。 */
        if (kept.length === 0) {
          noteOnce(
            'skill-shrink:keep-not-empty',
            '技能目录硬闸门：丢掉重复目录会让这一步一条消息都不剩 ⇒ 保守起见仍然注入（避免空请求）',
          )
        } else {
          skillDroppedCopies += droppedCopies
          noteOnce(
            'skill-shrink:dropped-duplicate-injection',
            '技能目录硬闸门：已开始**丢掉"与表面最后一份完全重复"的目录注入**'
            + '（上游每步重发全量、我们每步裁小 ⇒ 以前每步 2 次表面改写、把第 2 条往后的缓存全部作废）。'
            + '现在：条目集合一致就不注入、也不改写旧节点 ⇒ 前缀稳定。'
            + '（此后每 100 次汇总一行，避免刷屏。）',
          )
          if (skillDroppedCopies % 100 === 0) {
            toolDietNote(`技能目录硬闸门：累计丢掉 ${skillDroppedCopies} 次完全重复的目录注入（每次省掉 2 次表面改写 ⇒ 保住第 2 条往后的前缀缓存）`)
          }
          return { decision: Object.assign({}, decision, { messages: kept }), before, after, dropped: droppedCopies }
        }
      }
    }

    return { decision: Object.assign({}, decision, { messages: next }), before, after }
  }

  /* 挂在 pre-step：`dsh-tool-skill` 的目录构建是 `const decision = await next(); …snapshot()`
     ⇒ 本插件这一层一定在它取快照**之前**注册好。 */
  try {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      ensureAgentSkillShadow(agent)
      /* 第一道（必须在 next() **之前**）：会话表面上那份**历史遗留**的全量目录
         为什么要抢在下游之前：下游 `dsh-tool-skill` 是拿 `catalogHistory(agent)`
         （读会话日志里最后一条**可见**目录的 digest）跟当前技能快照的 digest 比。
         先把旧的换掉 ⇒ 它当场发现 digest 对不上 ⇒ **同一步**就把正确的目录补进来。
         （实测过的反面教材：放进 next() 之后，那条 4 技能旧目录被换成 0 条后，
          要等下一步上游才发现并补发 —— 中间有一次请求"看不到任何技能"。
          证据：<工作区> 的 session-eec06ad1，seq=48→89→94。） */
      try {
        let allow = null
        try {
          allow = skillAllowSetFor(agent)
        } catch (error) {
          /* 「不许静默不生效」：解析组合失败 = 这一轮技能轴不设防，必须留证据。 */
          noteOnce(
            `skill-surface:allow-fail:${error?.message ?? error}`,
            `技能目录：解析技能组合失败 ⇒ 会话表面这一轮不裁（旧目录照进）—— ${error?.message ?? error}`,
          )
          allow = null
        }
        /* 不再用 `allow !== null && allow.size > 0` 把整段包起来：
           组合未设时**照样**要跑「旧目录去重 + 旧指路牌压占位」—— 这两件事是内容中性的，
           跟组合设没设无关（实测组合未设的会话里两份完全相同的完整目录会一直共存，1,703 tok/轮）。
           compactSkillCatalogSurface 自己区分：allow 不可用时一个字都不裁目录内容。 */
        {
          const swept = compactSkillCatalogSurface(agent, allow, (fixed) => {
            for (const item of fixed) {
              toolDietNote(
                `技能目录：会话表面已换掉历史全量目录 —— seq=${item.seq} `
                + `${item.from} 个技能 → ${item.to} 个（${item.before} 字符 → ${item.after} 字符，`
                + `省约 ${Math.round((item.before - item.after) / 3.9)} tokens）`,
              )
            }
          })
          const deduped = Array.isArray(swept.deduped) ? swept.deduped : []
          const retired = Array.isArray(swept.retired) ? swept.retired : []
          if (retired.length > 0) {
            toolDietNote(
              `技能目录：已把 ${retired.length} 条**旧版指路牌**改成正确 kind（seq=${retired.map((item) => item.seq).join(',')}）`
              + ' —— 不这么做上游会每步重发一条目录、会话无限长',
            )
          }
          if (deduped.length > 0) {
            toolDietNote(
              `技能目录：已把 ${deduped.length} 条被最新目录取代的旧目录换成指路牌`
              + `（seq=${deduped.map((item) => item.seq).join(',')}；`
              + `共省约 ${Math.round(deduped.reduce((sum, item) => sum + (item.before - item.after), 0) / 3.9)} tokens）`,
            )
          }
          const collapsed = Array.isArray(swept.collapsed) ? swept.collapsed : []
          if (collapsed.length > 0) {
            toolDietNote(
              `技能目录：已把 ${collapsed.length} 条**旧指路牌**压成极短占位（seq=${collapsed.map((item) => item.seq).join(',')}；`
              + `共省约 ${Math.round(collapsed.reduce((sum, item) => sum + (item.before - SUPERSEDED_PLACEHOLDER.length), 0) / 3.9)} tokens）`
              + ' —— 指路牌本身也是独立表面节点，不压就会线性累积',
            )
          }
          if (swept.reason !== undefined) {
            noteOnce(
              `skill-surface:${swept.reason}`,
              `技能目录：会话表面换不动（${swept.reason}）—— 老会话里的全量目录这次仍会进上下文`,
            )
          } else if (swept.fixed.length === 0 && deduped.length === 0 && collapsed.length === 0 && !skillSurfaceAnnounced.has(agent?.session)) {
            if (agent?.session !== undefined && agent?.session !== null) skillSurfaceAnnounced.add(agent.session)
            toolDietNote(
              `技能目录：会话表面已检查（扫了 ${swept.swept} 个新事件）—— 没有历史遗留的全量目录`,
            )
          }
        }
      } catch (error) {
        noteOnce(
          `skill-surface-fail:${error?.message ?? error}`,
          `技能目录：会话表面替换失败（这一步的请求仍会带旧目录）—— ${error?.message ?? error}`,
        )
      }
      /* 必须把 next() 传下去：`agent/pre-step` 是瀑布，链上还有
         `dsh-tool-skill`（靠 `await next()` 拿 decision 之后才决定要不要注入目录）。
         不调用 next 就会把后面的处理器整条掐掉 —— 那就不是"省上下文"，是"破坏功能"。 */
      const decision = next === undefined ? undefined : await next()
      /* 第二道（链上所有人算完之后）：把本轮**正要注入**的技能目录裁小 */
      try {
        const shrunk = shrinkSkillCatalog(agent, decision)
        if (shrunk.before !== undefined && shrunk.before > shrunk.after) {
          toolDietNote(
            `技能目录：注入前裁小 —— ${shrunk.before} 字符 → ${shrunk.after} 字符`
            + `（只留组合允许的 ${(() => { try { return skillAllowSetFor(agent)?.size ?? '?' } catch { return '?' } })()} 个技能）`,
          )
        }
        return shrunk.decision
      } catch (error) {
        noteOnce(`skill-shrink-fail:${error?.message ?? error}`, `技能目录：裁小失败（这一步可能把全量目录注入进去）—— ${error?.message ?? error}`)
        return decision
      }
    }, { prepend: true })
  } catch (error) {
    noteOnce(`skill-shadow:hook-fail:${error?.message ?? error}`, `技能遮蔽：挂 pre-step 失败（会在首次列举时才注册）—— ${error?.message ?? error}`)
  }

  /* 会话启动即挂插件目录（新会话实测抓到的"半拍慢"）
   *
   * 实测（真机新会话 `session-3f12616a`，"自己测新会话"）：
   *   第一轮请求里**没有** `# 可用插件`（而日志同时写着"插件目录：已挂进系统提示（7 行 / 1972 字符）"），
   *   第二轮的请求里才出现，且此后稳定只有 1 份。
   * 原因：`applyCatalogPrompt` 只在 `agent/pre-step` 里调 —— 对新会话来说，
   *   这一挂发生在**本轮系统提示已经组装完之后**，于是目录晚一步才生效。
   *   （对比：dsh-knowledge 的挂载目录、review-squad 的说明都是**注册期**就挂好，所以它们第一轮就在。）
   *
   * 修法：再加一个 `agent/session-start` 钩子（官方 `dsh-agent-loop` 在**会话进入时**发出，
   * 早于第一步的组装），在那里也调一次同样两件事。
   *
   * 为什么这样是安全的（保守派）：
   *   · **纯追加**：不删不改任何现有路径，`agent/pre-step` 那条照旧；
   *   · **幂等**：`applyCatalogPrompt` 在文本没变时直接 return（`previous.text === text`），
   *     `ensureAgentSkillShadow` 用 WeakMap 记住已挂过的 agent；
   *   · 这个事件不存在时只是钩子永不触发 ⇒ 行为与今天完全一样，不会更糟；
   *     万一 `ctx.on` 本身抛，也照本项目契约留一行证据，绝不静默。
   */
  /**
   * 元工具的"注册器"句柄 —— 由 `applyToolDiet` 回传，供 `agent/session-start` 调用。
   *
   * 为什么需要它（第二个真 bug）：
   *   `ensureRegistered()` 只活在 `applyToolDiet` 内部，而 `applyToolDiet` 在**本函数更下面**才被调用；
   *   `agent/session-start` 的回调是在**运行时**触发的，所以只要在回调里读这个 holder 就能拿到。
   *   没有它时，`resume`（每轮第一步）的请求头会缺 `search_plugins`/`load_plugin`（28 vs 30）。
   */
  let ensureToolMetaRegistered = null

  try {
    ctx.on('agent/session-start', ({ agent }) => {
      try {
        ensureAgentSkillShadow(agent)
        /* 第二个真 bug 的修法：**元工具必须在"会话进入"这一刻就注册好**。
         *
         * 现场（会话 df0a83c1 的 207 个请求头，逐个头比对工具集）：
         *   resume(28) → change(30)  新增[load_plugin, search_plugins]   ← 每轮都这样
         *   change(30) → resume(28)  消失[load_plugin, search_plugins]
         * 即：**每轮第一步的请求头里，模型看不到那两个元工具**。
         *
         * 双重后果：
         *   ① **缓存**：请求头 tools 从这一处起就变（28 vs 30）⇒ 官方"缓存前缀单元"
         *      要求完整匹配 ⇒ **每轮第一步整段 miss**（实测 175,925 tok、命中率 56.6%）。
         *   ② **功能**：第一步模型**看不到 `search_plugins` / `load_plugin`**
         *      ⇒ 路线二在第一轮**完全不生效**。
         *
         * 根因：`ensureRegistered()` 原来只在 `apply` 与 `agent/pre-step` 里调，而 `resume`
         * 的第一步组装**早于 pre-step** ⇒ 那一步白名单里的元工具在宿主注册表里还不存在
         * ⇒ 被 `applyToolRestriction` 的"剔除宿主不认识的名字"剔掉 ⇒ 28 个。
         * （日志原话：`白名单里有**宿主当时还不认识**的名字 ⇒ 已剔除后重试（subagent；白名单 30 → 29 个）`）
         *
         * 修法：与"挂目录"同一时机注册。纯追加、幂等（`ensureRegistered` 自己用 `registered` 短路）。 */
        try {
          ensureToolMetaRegistered?.()
        } catch (error) {
          noteOnce(`tools:session-start-register-fail:${error?.message ?? error}`, `会话启动注册元工具失败（第一步可能仍缺 search_plugins/load_plugin）—— ${error?.message ?? error}`)
        }
        /* 必须用 `pluginCatalogPromptText` —— `getPromptText` 只是 applyToolDiet 的**形参名**，
           在 applyInner 这一层根本不存在。第一次写成 getPromptText，真机日志当场报
           `会话启动挂插件目录失败 —— getPromptText is not defined`
           （本项目「不许静默」的契约救了一次：它没哑掉，否则会以为挂上了。） */
        /* 修复（真机 dump 定位）：**先把工具名目录预热满，再挂目录段**。
         *
         * 现场（会话 08d10c82，两份 system prompt 逐行 diff）：
         *   第 1 帧的目录段里**没有**「· ralph — Run a foreground fresh-agent Ralph loop …」
         *   这一行，第 2 帧才有 ⇒ 其后 60+ 行整体位移 ⇒ system prompt 变 ⇒ 前缀断
         *   （该次 miss 2 万 tok，命中率从 99.9% 掉到 23%）。
         *
         * 根因：目录段内容取自 `toolCatalog.names`（只增集合），而它平时靠 `observeTools()`
         *   在 pre-step 里"每步观测"慢慢长 ⇒ **新会话第 1 帧天然不全**，第 2 帧补上 ⇒ 断一次。
         *   （这解释了 `section-order` 的"稳定 28 段 ↔ 29 段"来回跳，也解释了为什么
         *   关掉 reasoning-strip 毫无帮助 —— 那个改的是 messages，病在 system。）
         *
         * 修法：`agent/session-start` 早于第 1 帧的系统提示组装 ⇒ 在这里先观测一次，
         *   让 `names` 一步到位 ⇒ 目录段第 1 帧就完整 ⇒ 此后不再变。
         *
         * 为什么**无损**：只是"提前看到"，一个名字都不删、不改。
         *   （对比：曾考虑"目录里干脆不列工具名"—— 但 `invoke_tool` 要填"工具原名"，
         *   不列出名字模型就只能猜，那是有损的。）
         * 幂等：`observeTools` 只往 Set 里 add + 只在缺 key 时补 hints/bytes，重复调用无副作用。
         */
        try {
          observeTools(serviceOf(ctx, 'tools'), agent, toolStateFor(agent))
        } catch (error) {
          noteOnce(`tools:session-start-warmup-fail:${error?.message ?? error}`,
            `会话启动预热工具目录失败（第 1 帧的目录段可能仍缺名字 ⇒ 会破一次前缀）—— ${error?.message ?? error}`)
        }
        applyCatalogPrompt(agent, pluginCatalogPromptText, ctx)
      } catch (error) {
        noteOnce(`catalog:session-start-fail:${error?.message ?? error}`, `会话启动挂插件目录失败（pre-step 那条仍会补）—— ${error?.message ?? error}`)
      }
    })
  } catch (error) {
    noteOnce(`catalog:no-session-start-hook:${error?.message ?? error}`, `挂不上 agent/session-start（新会话第一轮可能拿不到插件目录）—— ${error?.message ?? error}`)
  }

  /* 挂载即让技能目录缓存失效一次（补充说明：「技能注入还是 15k」）。
   *
   * 病灶：DSH 的技能目录按 `(cwd, scope 链, revision)` 缓存，**冷启动时它可能在本 provider
   * 注册之前就被建好并缓存了** —— 那一份是"没有遮蔽"的全量目录，会被整个会话一直用下去
   * （实测：只有 2 个技能的组合，目录仍然是全量 185 条约 17k token；上一条 `refreshState`
   * 里的失效只在"签名变化"时触发，冷启动 `lastSkillSig === null` 不会触发）。
   * ⇒ 注册完立刻敲一次黑板，保证任何会话拿到的目录都带遮蔽。 */
  invalidateSkillCatalogSoon('遮蔽 provider 已挂载 ⇒ 让缓存重建')

  /* ①b 启动自愈：semgrep 的短路径 junction（插件更新后指向的 generation 会变） */
  healSemgrepShortPathOnce()

  // ② 插件组合 → 写 profile 补丁层的托管区块
  //
  // 两个必须踩过的坑（会让 DSH 起不来）：
  //   a) 补丁里的 `- id:` 要的是**条目 id**（`docker`），不是包名（`@hyzyn/dsh-docker`）。
  //   b) id 若以 `@` 开头，**必须加引号**——YAML 里 `@` 是保留字符，裸标量非法，
  //      整个补丁文件解析失败 ⇒ 插件树加载失败 ⇒ DSH 起不来。
  // 所以这里先扫各 bundle 的 cordis.patch.yml，建「包名 → 条目 id」映射；解析不到
  // 的包**跳过不写**，宁可少关一个，也不能写一行坏 YAML。

  /** 扫描 bundle 补丁文件，建「包名 → 条目 id」映射。 */
  function buildEntryIdMap() {
    const map = new Map()
    // root1: profile 的 node_modules（多为 junction）；root2: generation 实体目录。
    // 两个都扫，深度给够到 <pkg>/cordis.patch.yml，并跳过 .pnpm（体量大且重复）。
    const roots = [
      [join(dshHome, 'profiles', 'web', 'node_modules'), 3],
      [join(dshHome, 'profiles', '.generations', 'live'), 5],
    ]
    const walk = (dir, depth) => {
      if (depth < 0) return
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        const full = join(dir, ent.name)
        if (ent.isDirectory()) {
          if (ent.name === '.pnpm') continue
          walk(full, depth - 1)
          continue
        }
        if (ent.name !== 'cordis.patch.yml') continue
        let lines
        try {
          lines = readFileSync(full, 'utf8').split('\n')
        } catch {
          continue
        }
        for (let i = 0; i < lines.length; i += 1) {
          const m = /^\s*-\s*id:\s*(.+?)\s*$/.exec(lines[i])
          if (!m) continue
          const id = m[1].replace(/^['"]|['"]$/g, '')
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
            const n = /^\s*name:\s*(.+?)\s*$/.exec(lines[j])
            if (!n) continue
            const pkg = n[1].replace(/^['"]|['"]$/g, '')
            if (!map.has(pkg)) map.set(pkg, id)
            break
          }
        }
      }
    }
    for (const [root, depth] of roots) walk(root, depth)
    // 兜底：profile 的 `dsh.profile.bundles` 里列了**所有已启用**的包，
    // 有些包没有 cordis.patch.yml（如 `@nanmicoder/dsh-agent-teams`），光扫补丁会漏掉它，
    // 它底下的工具就全落进兜底桶了（实测：agent_teams_* 14 个工具）。
    // 用包名去掉 scope 的尾段当条目 id —— 与 DSH 自己的习惯一致（`@hyzyn/dsh-docker` → `docker`）。
    try {
      const profilePkg = join(dshHome, 'profiles', 'web', 'package.json')
      if (existsSync(profilePkg)) {
        const json = JSON.parse(readFileSync(profilePkg, 'utf8'))
        const bundles = json?.dsh?.profile?.bundles ?? json?.dsh?.bundles ?? null
        const list = Array.isArray(bundles) ? bundles : (bundles === null ? [] : Object.keys(bundles))
        for (const entry of list) {
          const pkg = typeof entry === 'string' ? entry : String(entry?.name ?? '')
          if (pkg === '' || map.has(pkg)) continue
          map.set(pkg, pkg.replace(/^@[^/]+\//, ''))
        }
      }
    } catch { /* 读不到 bundles 不影响主流程 */ }
    return map
  }

  /**
   * 条目映射改成**懒加载 + 磁盘缓存**（实测：这个扫描要 ~5 秒）。
   *
   * 实测：在 apply 阶段同步扫 `profiles/web/node_modules`(深 3) +
   * `profiles/.generations/live`(**深 5**，4568 个目录)要 2.4s + 2.4s ≈ **5 秒**，
   * 全部算在**开机**里；而宿主重启后第一次发消息本来就慢（实测 40 秒才出结论），
   * 这 5 秒是白加的。
   * 现在：① 懒加载（第一次真需要时才建，不占开机）；
   *      ② 磁盘缓存（profile 的 package.json 与 `live` 目录都没变就直接读缓存，毫秒级）。
   */
  const ENTRY_MAP_CACHE = join(dshHome, 'capability-composer', 'entry-id-map.json')
  /** 缓存有效性：profile 挂载清单 + generation 目录的 mtime/size。 */
  function entryMapStamp() {
    const parts = []
    for (const p of [join(dshHome, 'profiles', 'web', 'package.json'), join(dshHome, 'profiles', '.generations', 'live')]) {
      try {
        const st = statSync(p)
        parts.push(`${Math.round(st.mtimeMs)}:${st.size}`)
      } catch {
        parts.push('-')
      }
    }
    return parts.join('|')
  }
  let entryIdMap = null
  function ensureEntryIdMap() {
    if (entryIdMap !== null) return entryIdMap
    const stamp = entryMapStamp()
    try {
      const raw = readFileSync(ENTRY_MAP_CACHE, 'utf8')
      const cached = JSON.parse(raw)
      if (cached !== null && cached !== undefined && cached.stamp === stamp && Array.isArray(cached.entries)) {
        entryIdMap = new Map(cached.entries)
        toolDietNote(`插件条目映射：直接读缓存 ${entryIdMap.size} 条（不扫盘）`)
        return entryIdMap
      }
    } catch { /* 没缓存/读不动 ⇒ 老老实实扫一次 */ }
    const started = Date.now()
    try {
      entryIdMap = buildEntryIdMap()
      toolDietNote(`插件条目映射：建成 ${entryIdMap.size} 条（扫盘耗时 ${Date.now() - started}ms，已写缓存）`)
      try {
        mkdirSync(dirname(ENTRY_MAP_CACHE), { recursive: true })
        writeFileSync(ENTRY_MAP_CACHE, JSON.stringify({ stamp, entries: [...entryIdMap.entries()] }), 'utf8')
      } catch { /* 缓存写不进去只是下次再扫一次 */ }
    } catch (error) {
      entryIdMap = new Map()
      ctx.logger?.warn?.(`[composer] 扫描插件条目 id 失败：${error?.message ?? error}`)
    }
    return entryIdMap
  }

  /**
   * 包名 → 条目 id。**解析不到就返回 null**，调用方跳过。
   * 宁可少关一个插件，也绝不写一个可能不存在的 id —— 补丁层里一行坏 id 就可能
   * 让整棵插件树加载失败（DSH 起不来），代价远大于少省一点上下文。
   */
  function resolveEntryId(pkg) {
    const map = ensureEntryIdMap()
    return map.has(pkg) ? map.get(pkg) : null
  }

  // 插件目录（**以插件为单位**，这是路线二的正身）
  //
  // 路线二的单位是**插件**，不是工具。模型看到的目录是
  // 「插件名 + 描述 + 什么时候该启用它的关键词」，跟技能目录同构；需要时把**整个
  // 插件**调进来（它底下全部工具一起进），而不是从 211 个工具名里挑。
  //
  // 所以宿主必须能回答两件事：
  //   ① 这个插件是干什么的 → 读它自己的 package.json 的 description
  //   ② 它底下有哪些工具   → DSH 的 tools 注册表**不带归属**（schemaOf 只吐
  //      name/description/parameters），只能按**命名空间推导**：插件 id / 包名里
  //      那个有意义的词（docker、codegraph、api-client…）就是它工具名的前缀。
  //      推导不出来就留空，**绝不把猜的东西当事实写死**。
  //
  // MCP 不归本插件管：`mcp__*` 既不进插件目录，也不受工具限制。

  /** 命名空间里要丢掉的噪声词。 */
  const NAMESPACE_NOISE = new Set([
    'dsh', 'tool', 'tools', 'plugin', 'plugins', 'client', 'ui', 'api', 'core', 'the', 'and',
  ])

  /**
   * 少数插件的工具名跟自己的 id **没有可推导的命名空间关系**，只能显式兜一下。
   * 曾报出「插件全是 0 个工具」时，实测这些的确一条都认不回来。
   */
  const NAMESPACE_ALIAS = {
    flakefinder: ['flaky'],
    'furongjun1999-dsh-memory': ['lingshu'],
    'skills-manager': ['create_skill'],
    'dsh-chat-import': ['import_chat'],
    // 这两组工具名跟插件 id 完全没共同的词，只能显式点出来：
    'dsh-computer-use': ['app', 'screen'],
    'dsh-agent-teams': ['agent_teams'],
  }

  /**
   * 关键词里要丢掉的英文停用词。
   *
   * 为什么要这一条：关键词是从 `package.json` 的 description 里切词来的，
   * 英文描述里全是 `for / with / that / harness / plugin / deepseek` 这类词 ——
   * 留着它们会让目录里出现 `agent native api client for deepseek` 这种
   * **一点信息量都没有的"关键词"**，反而干扰模型判断（真机实测）。
   */
  const KEYWORD_STOPWORDS = new Set([
    'this', 'that', 'with', 'from', 'into', 'your', 'you', 'for', 'and', 'the', 'are', 'was',
    'will', 'can', 'has', 'have', 'not', 'but', 'its', 'it', 'use', 'uses', 'using', 'used',
    'when', 'what', 'which', 'while', 'where', 'how', 'all', 'any', 'each', 'more', 'most',
    'dsh', 'deepseek', 'harness', 'plugin', 'plugins', 'agent', 'agents', 'tool', 'tools',
    'native', 'support', 'supports', 'provide', 'provides', 'including', 'include', 'includes',
    'based', 'like', 'also', 'over', 'under', 'between', 'through', 'than', 'then',
  ])

  /** 从插件 id / 包名里抽出「命名空间词」，用于把工具认领回它所属的插件。 */
  function namespacesOf(id, pkg) {
    const out = []
    for (const raw of [id, pkg]) {
      const s = String(raw ?? '').toLowerCase()
      if (s === '') continue
      // 连写形式：`api-client` → `api_client`。没有这一条，`api_client_request`
      // 一条都认不回来（分词出来是 api / client，而它们在噪声表里）。实测。
      const joined = s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      if (joined.length >= 3 && !out.includes(joined)) out.push(joined)
      // 去掉 `dsh_` 前缀再来一份：`dsh_context_lens` → `context_lens`。
      // 没有这一条，`context_lens_*` 会按更短的 `context` 归到 `dsh-context` 头上（错的）。
      const bare = joined.replace(/^dsh_/, '')
      if (bare !== joined && bare.length >= 3 && !out.includes(bare)) out.push(bare)
      for (const tok of s.split(/[^a-z0-9]+/)) {
        if (tok.length < 3 || NAMESPACE_NOISE.has(tok)) continue
        if (/^\d+$/.test(tok)) continue
        if (!out.includes(tok)) out.push(tok)
      }
    }
    for (const alias of NAMESPACE_ALIAS[id] ?? []) if (!out.includes(alias)) out.push(alias)
    return out
  }

  // 工具归属：**读插件自己的包字节**（这是唯一能 0 误判的路子）
  //
  // 为什么不靠命名空间猜：DSH 的 tools 注册表**没有归属字段**（`register(definition)`
  // 只往一个全局 layer 里塞 name→definition，schemaOf 只吐 name/description/parameters），
  // 谁注册的它根本不记。所以按 id/包名推前缀必然有漏（`api_client_*`）也有错
  // （`context_lens_*` 会被算到 `dsh-context` 头上，真身是 `dsh-context-lens`）。
  //
  // 但插件**必须把工具名写进自己的代码**才能注册它。于是：
  //   ① 把该插件包 `lib/**/*.js` 全读进来；
  //   ② 里面出现过 `tools.register(` ⇒ 它注册工具；
  //   ③ 工具名是否属于它 —— 看名字**作为字符串字面量**出现在谁的包里（出现才算它的）。
  // 三条一起给出**可证明**的结论：
  //   · 读全了 + 没有 register 调用 + 一个工具名字面量都没有 ⇒ **证明性**「体验插件」；
  //   · 找到了工具名字面量 ⇒ 这些就是它的工具（精确，不用猜前缀）；
  //   · 读不到包 ⇒ **不下结论**（`certain: false`），界面显示"未识别"，绝不乱贴标签。
  const pluginScanCache = new Map()

  /** 递归收集一个目录下的 js/mjs/cjs（跳过嵌套 node_modules，避免读到依赖）。 */
  function collectPluginFiles(dir, out, depth) {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.bin') continue
        collectPluginFiles(full, out, depth + 1)
        continue
      }
      if (!entry.isFile() || !/\.(js|mjs|cjs)$/.test(entry.name)) continue
      try { if (statSync(full).size <= 12 * 1024 * 1024) out.push(full) } catch { /* 跳过读不到的 */ }
    }
  }

  /** 找插件包目录：profile 的 node_modules（junction/链接）优先，其次 live generation。 */
  function pluginPackageDir(pkg) {
    const roots = [
      join(dshHome, 'profiles', 'web', 'node_modules', pkg),
      join(dshHome, 'profiles', '.generations', 'live', pkg),
    ]
    for (const root of roots) {
      if (existsSync(join(root, 'lib'))) return root
    }
    return null
  }

  const REGISTER_TOOLS_RE = /\.tools\.register\s*\(|\btools\.register\s*\(|\bregisterTool\s*\(|\bregister_tool\s*\(/

  /**
   * Cordis 插件要用 `ctx.tools` 必须在 `inject` 里声明 —— 注册工具的插件**必然**注入 tools。
   * 这是「体验插件」判定的第二条独立负证据。
   */
  const INJECTS_TOOLS_RE = /inject\s*[=:]\s*\[[^\]]*['"]tools['"]/

  /**
   * 扫一个插件包，判定它的工具集。
   *
   * @param pkg - 包名。
   * @param gatedTools - 可归属的工具名（已剔除核心/元/MCP）。
   * @returns `{ files, registers, injectsTools, literals, certain, uiOnly }`
   */
  function scanPluginTools(pkg, gatedTools) {
    const cached = pluginScanCache.get(pkg)
    if (cached !== undefined && cached.stamp === gatedTools.length) return cached
    const dir = pluginPackageDir(pkg)
    const files = []
    if (dir !== null) collectPluginFiles(dir, files, 0)
    let text = ''
    for (const file of files) {
      try { text += readFileSync(file, 'latin1') + '\n' } catch { /* 单文件读不到就跳过 */ }
    }
    const registers = text !== '' && REGISTER_TOOLS_RE.test(text)
    const injectsTools = text !== '' && INJECTS_TOOLS_RE.test(text)
    const literals = text === '' ? [] : gatedTools.filter((n) => text.includes(`"${n}"`) || text.includes(`'${n}'`))
    const result = {
      files: files.length,
      registers,
      injectsTools,
      literals,
      // 「读全了」才算确定；读不到包就不下结论。
      certain: files.length > 0,
      /**
       * 证明性「体验插件」。四条**独立的负证据**同时成立才给：
       *   ① 读到文件（不是"读不到所以没发现"）
       *   ② 没有任何 `tools.register(` 调用
       *   ③ 没有在任何 inject 里声明 `tools`
       *   ④ 一个可归属工具名的**字符串字面量**都没有
       * 任何一条不成立就不贴标签（宁可不标，绝不误标）。
       */
      uiOnly: files.length > 0 && !registers && !injectsTools && literals.length === 0,
      stamp: gatedTools.length,
    }
    pluginScanCache.set(pkg, result)
    return result
  }

  /** 读一个插件的 package.json（拿 name / description）。读不到就返回空壳。 */
  function readPluginManifest(pkg) {    const roots = [
      join(dshHome, 'profiles', 'web', 'node_modules', pkg, 'package.json'),
      join(dshHome, 'profiles', '.generations', 'live', pkg, 'package.json'),
    ]
    for (const file of roots) {
      try {
        if (!existsSync(file)) continue
        const json = JSON.parse(readFileSync(file, 'utf8'))
        // 名字**优先 displayName，绝不回退到 package.json 的 `name`** ——
        // 那会显示成 `@hyzyn/dsh-docker` / `dsh-code-coverage/plugin` 这种包名，
        // 根本认不出这是哪个插件（真机截图里就是这么一坨）。
        // 拿不到 displayName 就返回空串，由调用方回退到**条目 id**（`docker`）。
        return {
          name: typeof json?.displayName === 'string' ? json.displayName : '',
          description: typeof json?.description === 'string' ? json.description : '',
        }
      } catch {
        // 读不到就当没有描述，绝不让它影响启动
      }
    }
    return { name: pkg, description: '' }
  }

  /**
   * 建插件目录：每个插件一行，含它认领回来的工具。
   *
   * @param toolNames - 全局工具名列表（`mcp__*` 已在调用方剔除）。
   * @returns `[{ id, pkg, name, description, keywords, globs, tools, bytes }]`
   */
  function buildPluginCatalog(toolNames) {
    // 核心 / 元 / MCP 之外的才参与归属：插件文档里到处都写 `read`/`write`，
    // 不过滤掉会把每个插件都算成"有工具"（实测：24 个插件全被 `read` 污染）。
    const gated = toolNames.filter((n) => !TOOL_CORE.has(n) && !TOOL_META.has(n) && !TOOL_RESERVED.has(n)
      && !String(n).startsWith('mcp__'))
    const rows = []
    for (const [pkg, id] of ensureEntryIdMap().entries()) {
      const manifest = readPluginManifest(pkg)
      const words = namespacesOf(id, pkg)
      const scan = scanPluginTools(pkg, gated)
      rows.push({
        id,
        pkg,
        name: manifest.name !== '' ? manifest.name : id,
        description: manifest.description,
        words,
        // 启用关键词：命名空间词 + 描述里的**实词**。
        // 必须滤掉英文停用词 —— 否则会得到 `agent native api client for deepseek`
        // 这种一点信息量都没有的东西（真机截图里就是这么一坨）。
        keywords: [...new Set([
          ...words,
          ...manifest.description.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/)
            .filter((w) => w.length >= 4 && !KEYWORD_STOPWORDS.has(w))
            .slice(0, 5),
        ])].slice(0, 8),
        // 加载口径：**精确名字 ∪ 命名空间 glob**。精确名字来自包字节（权威），
        // glob 兜住"工具名动态拼出来、包里没有字面量"的情况 —— 多加载一个只是多花点上下文，
        // 少加载一个就是丢能力，所以这里宁松不紧。
        globs: [...new Set([...scan.literals, ...words.map((w) => `${w}_*`)])],
        tools: [],
        exactTools: scan.literals,
        uiOnly: scan.uiOnly,
        scanCertain: scan.certain,
        registersTools: scan.registers,
        bytes: 0,
        scanFiles: scan.files,
      })
    }

    // 一个工具**只能属于一个插件**（真机测出来的 bug）：
    //   `dsh-context` 与 `dsh-context-lens` 都会推导出命名空间词 `context`，
    //   若各扫各的，`context_*` 就被两个插件同时认领 ⇒ 目录里的工具数重复计算
    //   （当时 194 + 47 = 241 > 实际 211），勾哪个插件都"能加载"同一批工具。
    //   修法：把「插件 × 命名空间词」摊平成候选，**最长词优先**，一个工具只归一家。
    // 这个前缀推导只是**兜底**了。优先用**包字节**里的精确名字
    //（`exactTools`，见 scanPluginTools），它不会把 `context_lens_*` 算到
    // `dsh-context` 头上 —— 真身是 `dsh-context-lens`。只有扫不出名字的插件才落回前缀。
    const exactOwner = new Map()
    const ambiguous = new Set()
    for (const row of rows) {
      for (const name of row.exactTools) {
        if (exactOwner.has(name)) ambiguous.add(name)
        else exactOwner.set(name, row)
      }
    }
    // 被两个以上的插件包同时提到 ⇒ 至少有一个是在**文案里**提到它，不可信 ⇒ 谁都不给，
    // 落进兜底桶（`workflow` 就是这样：真身是 DSH 自带的 dsh-tool-workflow）。
    for (const name of ambiguous) exactOwner.delete(name)

    /* 把这些"被多个插件同时认领"的名字并入 `TOOL_CORE` ——
       它们就是 `read`/`write` 那类**通用词**（插件文档里到处都写），既不该归某个插件，
       也不该被 deny 掉。并入之后 `TOOL_CORE` 会随插件生态**自动长大**，
       不再依赖写死的名单（DSH 升级新增官方工具时，它会自动进这里）。
       注意：`rows` 的 `exactTools` 来自"排除 TOOL_CORE 之后"的扫描，
       所以这里加进来的必然是**新发现**的，不会与静态名单重复。 */
    let coreAdded = 0
    for (const name of ambiguous) {
      if (!TOOL_CORE.has(name)) { TOOL_CORE.add(name); coreAdded += 1 }
    }
    if (coreAdded > 0) {
      noteOnce('core-discovered:' + coreAdded + ':' + TOOL_CORE.size,
        `工具按需加载：自动发现 ${coreAdded} 个"通用工具名"并入常驻核心（现共 ${TOOL_CORE.size} 个）`
        + ' —— 判据：被 ≥2 个插件包同时提到 ⇒ 是通用词而非某插件专属',
      )
    }

    const claims = []
    for (const row of rows) for (const word of row.words) claims.push({ row, word })
    claims.sort((a, b) => b.word.length - a.word.length || (a.row.id < b.row.id ? -1 : 1))
    for (const tool of toolNames) {
      const lower = tool.toLowerCase()
      // MCP 完全不归本插件管：不进目录、不算归属。
      if (lower.startsWith('mcp__')) continue
      const exact = exactOwner.get(tool)
      if (exact !== undefined) { exact.tools.push(tool); continue }
      if (ambiguous.has(tool)) continue
      /**
       * 这里**不能**跳过核心/元工具。
       *
       * 翻车记录：以前在这里 `continue` 掉了 `TOOL_CORE`，
       * 于是 `lint_diagnostics/lint_fix/lint_workspace_errors` 三个**核心工具**
       * 一个都不归 `lint-loop` ⇒ 它显示"工具数未知"。
       * 但"核心"只表示**常驻**，不代表"没有主人"—— 它就是 lint-loop 的工具。
       * 前缀匹配本身足够精确（`read`/`write`/`skill` 不会撞上任何插件的命名空间词），
       * 所以核心工具照常参与归属，只是它们**不参与兜底桶统计**（它们本来就常驻）。
       */
      for (const claim of claims) {
        // 也接受**完全相等**：像 `create_skill`、`ralph` 这种没有下划线的工具名，
        // 只按 `${word}_` 前缀永远匹配不上。
        if (lower === claim.word || lower.startsWith(`${claim.word}_`) || lower.startsWith(`${claim.word}-`)) {
          claim.row.tools.push(tool)
          break
        }
      }
    }

    /**
     * 同一个插件在 Loader 清单里可能有**多条 entry**，而它们会归一到**同一个 id**。
     *
     * 实测：`dsh-code-coverage` 与 `dsh-code-coverage/plugin` 两条 entry 都映射成
     * id `dsh-code-coverage` ⇒ 目录里出现**两行同 id**（一行 3 个工具、一行 0 个），
     * UI 上看着像重复项、React 的 `key` 也会撞。勾哪个都能用，但很迷惑，而且
     * "57 个插件"这个数字会多算一个。
     *
     * 按 id 合并：工具取**并集**，名字/描述/关键词取信息更全的那条。
     */
    const merged = new Map()
    for (const row of rows) {
      const cur = merged.get(row.id)
      if (cur === undefined) { merged.set(row.id, row); continue }
      for (const t of row.tools) if (!cur.tools.includes(t)) cur.tools.push(t)
      if (String(row.description ?? '').length > String(cur.description ?? '').length) cur.description = row.description
      if ((row.keywords ?? []).length > (cur.keywords ?? []).length) cur.keywords = row.keywords
      cur.entryCount = (cur.entryCount ?? 1) + 1
    }
    const outRows = [...merged.values()]
    for (const row of outRows) {
      row.tools.sort()
      row.bytes = row.tools.reduce((sum, n) => sum + (toolCatalog.bytes.get(n) ?? 0), 0)
    }
    return outRows.sort((a, b) => (a.id < b.id ? -1 : 1))
  }

  /**
   * 实时插件目录（带缓存）。
   *
   * 工具名只有被观测到才知道，所以目录是**渐长**的：缓存键用工具总数，
   * 数量没变就直接复用，避免每次 pre-step 都重算 40×211 次前缀匹配。
   */
  let pluginCatalogCache = { key: null, size: -1, rows: [] }
  function pluginCatalog() {
    /* 修：缓存键原来只有 `toolCatalog.names.size`（**只是个数量**）。
     *
     * 症状（由诊断脚本的逐行 diff 追到）：
     *   目录段里 `- unassigned · 未归属工具 … · 12 个工具` 会跳成 `11 个工具`
     *   —— 而 `rest`（未归属）= `names` − `claimed` − 其它，`claimed` 来自**这个缓存**。
     *   `names` 是**只增不减**的，但数量在两次调用间**恰好不变**是可能的
     *   （例如"加了一个、又少了另一个"），此时缓存命中 ⇒ 返回**过期归属**
     *   ⇒ `rest` 与 `real` 不一致 ⇒ 目录段内容跳动。
     *
     * 为什么这很贵：目录段在 system prompt 的**最前面**，DeepSeek 从 token 0 匹配
     *   ⇒ 它动 128 字符就让**整份前缀**全失效（实测该项 ¥1.26/天）。
     *
     * 修法：缓存键改用**内容签名**（数量 + 全部名字排序后连接）。
     *   成本：每个请求算一次，424 个短字符串排序 < 0.1ms，可忽略。
     */
    const key = toolCatalog.names.size + ':' + [...toolCatalog.names].sort().join('\u0001')
    if (pluginCatalogCache.key === key) return pluginCatalogCache.rows
    pluginCatalogCache = { key, size: toolCatalog.names.size, rows: buildPluginCatalog([...toolCatalog.names]) }
    return pluginCatalogCache.rows
  }

  /** id 一律加单引号：`@` 开头在 YAML 里是保留字符，裸写会让整个文件解析失败。 */
  function yamlId(id) {
    return `'${String(id).replace(/'/g, "''")}'`
  }

  function managedBlock(ids) {
    const lines = [MARK_BEGIN]
    for (const id of ids) {
      lines.push(`- id: ${yamlId(id)}`)
      lines.push('  disabled: true')
    }
    lines.push(MARK_END)
    return lines.join('\n')
  }

  /** 只替换托管区块内容，文件其余部分（含注释）原样保留。 */
  function writePluginComposition() {
    if (!existsSync(patchPath)) {
      ctx.logger?.warn?.(`[composer] 找不到 profile 补丁层，跳过插件组合：${patchPath}`)
      return { ok: false, reason: 'patch-missing', disabled: [] }
    }
    // 这条路**永久停用**：组合不再等于"关插件"。
    //   理由：真关插件会把它的 UI 一起关掉（对人友好的插件必须照常运行），且要重启；
    //   组合现在只决定"哪些工具进模型上下文"，由 ③ 的 restrict 在内存里 live 生效。
    //   这里恒写空区块：只为保住托管区块标记、且绝不碰文件其余内容。
    const wanted = []

    const skipped = []
    const ids = []
    for (const pkg of wanted) {
      const id = resolveEntryId(pkg)
      if (id === null) { skipped.push(pkg); continue }
      ids.push(id)
    }
    // 去重：两个包可能映到同一个条目
    const uniqueIds = [...new Set(ids)]

    const original = readFileSync(patchPath, 'utf8')
    const begin = original.indexOf(MARK_BEGIN)
    const end = original.indexOf(MARK_END)
    let next
    if (begin >= 0 && end > begin) {
      next = original.slice(0, begin) + managedBlock(uniqueIds) + original.slice(end + MARK_END.length)
    } else {
      const tail = original.endsWith('\n') ? '' : '\n'
      next = `${original}${tail}\n${managedBlock(uniqueIds)}\n`
    }
    if (next !== original) writeFileSync(patchPath, next, 'utf8')
    if (skipped.length > 0) ctx.logger?.warn?.(`[composer] 这些包找不到插件条目，已跳过：${skipped.join(', ')}`)
    return { ok: true, disabled: uniqueIds, skipped, changed: next !== original }
  }

  // 启动时落一次；之后每次 pre-step 前检查（组合可能在别的会话里被改过）。
  // 停用「关插件」后这里恒为 0，保留调用只为让托管区块标记继续存在。
  const applied = writePluginComposition()
  ctx.logger?.info?.(
    `[composer] 组合：技能「${skillCompositionFor(null) ?? '未设'}」允许 ${skillAllowSetFor(null)?.size ?? '全部'} 个技能；` +
    `工具可见范围「${resolveCompositionName(state, 'plugin', null) ?? '未设'}」；` +
    `插件不再被关（本次 disabled = ${applied.disabled?.length ?? 0}）`,
  )

  // ③ 工具按需加载（路线二）
  // 单独 try/catch：工具这一半挂了，也必须让技能与插件两个组合照常工作。
  try {
    /* 冷启动先把**扫出来的**工具名灌进全局工具目录。
       deny 列表按这份目录算（见 desiredToolDeny）：不垫的话，刚重启、还没有任何
       会话观察过工具时它是空的 ⇒ 第一个请求不设限（正是"新建会话回到原始"）。 */
    try {
      for (const row of getAllPlugins() ?? []) for (const t of row.tools ?? []) toolCatalog.names.add(t)
      toolDietNote(`工具按需加载：全局工具目录已垫 ${toolCatalog.names.size} 个名字（deny 依赖它）`)
    } catch { /* 目录拿不到不影响主流程 */ }
    /* 接住"元工具注册器"（`applyToolDiet` 现在返回它）—— `agent/session-start` 要靠它
       在"会话进入"那一刻就把 `search_plugins`/`load_plugin` 注册好，否则每轮第一步的请求头
       会缺这两个工具（28 vs 30），既毁缓存（整段 miss）又让路线二在第一轮失效。 */
    const diet = applyToolDiet(ctx, (agent) => toolScopeGlobsFor(agent), refreshState, noteEnv, pluginsOf, getAllPlugins, pluginCatalogPromptText)
    if (diet !== null && diet !== undefined && typeof diet.ensureRegistered === 'function') {
      ensureToolMetaRegistered = diet.ensureRegistered
      try { ensureToolMetaRegistered() } catch { /* 失败由 session-start 那条路再试 */ }
    }
  } catch (error) {
    ctx.logger?.warn?.(`[composer] 工具按需加载挂载失败，已跳过：${error?.message ?? error}`)
  }

  // ④ 组合 UI 的受控接口
  // 同样单独 try/catch：接口挂了也必须让前三条路径照常工作。
  try {
    registerComposerApi(ctx, {
      statePath,
      snapshot: async () => {
        const catalog = pluginCatalogAll()
        // 已知工作区：全局之外，pinned 里出现过的路径 + 会话覆盖的 key + 当前工作区
        const workspaces = [...new Set([
          ...Object.keys(state.pinned?.plugin ?? {}).filter((k) => k !== '*'),
          ...Object.keys(state.pinned?.skill ?? {}).filter((k) => k !== '*'),
          ...Object.keys(state.session?.plugin ?? {}),
          ...(typeof lastEnv.cwd === 'string' && lastEnv.cwd.length > 0 ? [lastEnv.cwd] : []),
        ])].sort()
        return {
          state: {
            version: state.version,
            pinned: state.pinned,
            session: state.session,
            compositions: state.compositions,
          },
          tools: [...toolCatalog.names].sort().map((name) => ({
            name,
            hint: toolCatalog.hints.get(name) ?? '',
            bytes: toolCatalog.bytes.get(name) ?? 0,
          })),
          coreTools: [...TOOL_CORE].sort(),
          metaTools: [...TOOL_META].sort(),
          residentBase: toolResidentBase(),
          // 目录是**插件**，不是工具（MCP 已整体排除）
          plugins: catalog.map((row) => ({
            id: row.id,
            pkg: row.pkg,
            name: row.name,
            description: row.description,
            keywords: row.keywords,
            toolCount: row.tools.length,
            // 归属是不是"读包字节读出来的精确名字"（true）还是"前缀兜底猜的"（false）
            toolNames: row.tools,
            // 一律防御式读取：兜底桶那一行是手工造的，字段可能不全，
            //    少一个字段就让整个 /state 400、面板全白（真机翻车）。
            exact: Array.isArray(row.exactTools) && row.exactTools.length > 0,
            // 「体验插件」只有四条负证据齐了才是 true
            uiOnly: row.uiOnly === true,
            scanCertain: row.scanCertain === true,
            bytes: row.bytes,
          })),
          env: {
            sessionId: lastEnv.sessionId,
            cwd: lastEnv.cwd,
            at: lastEnv.at,
          },
          workspaces,
          statePath,
        }
      },
      writeState: (next) => {
        state = next
        writeJson(statePath, next)
        refreshState() // 让内存与磁盘对齐；下一步就按新组合生效
      },
      effective: (scope) => effectivePayload(scope),
      /**
       * 插件目录（给启动器的「常驻插件」选择器用）。
       *
       * 为什么要开这条：启动器的选择器原来只有**包名**，认不出来哪个是哪个，
       * 也不知道"钉住它要多花多少上下文"。这里给出同一份真相：
       * 中文名 + 描述 + 工具数 + 字节数（换算成大概 token 也是它）。
       * 只读、不含工具名，所以不存在泄漏细节的问题。
       */
      catalog: () => pluginCatalogAll().map((row) => ({
        id: row.id,
        pkg: row.pkg,
        name: row.name ?? row.id,
        description: row.description ?? '',
        tools: Array.isArray(row.tools) ? row.tools.length : 0,
        bytes: row.bytes ?? 0,
        uiOnly: row.uiOnly === true,
        mcp: String(row.id).startsWith('mcp:'),
      })),
      skills: async () => {
        try {
          const list = await ctx.skills.list({})
          return list.map((entry) => ({ name: entry.name, description: entry.description }))
        } catch {
          return []
        }
      },
    })
  } catch (error) {
    noteOnce(`api:mount-fail:${error?.message ?? error}`, `组合 UI 接口挂载失败，已跳过：${error?.message ?? error}`)
  }

  // v1 不对外暴露服务（UI 还没做）。状态文件本身就是接口：
  //   $DSH_HOME/capability-composer/compositions.json
  // 不用 ctx.set()，少一个能在加载期抛错的地方。
  ctx.logger?.info?.(`[composer] 状态文件：${statePath}`)
}
