/**
 * dsh-capability-composer 的**客户端半边**（浏览器侧）。
 *
 * 两个页面，各管一个轴（互不干扰）：
 *   `SkillsTab`  挂在「技能中心 → 组合技能」   —— 只管**技能**
 *   `PluginsTab` 挂在「设置 → 插件 → 插件组合」 —— 只管**插件**
 *
 *
 * 这个插件到底是干什么的（UI 必须服务这件事）
 *
 * DSH 装了几十个插件 ⇒ 两百多个工具，全都塞进模型的上下文，又贵又吵。
 * 本插件的核心语义是：**"在这个工作区/这个会话里，模型只该看得见这些插件（和这些技能）"**。
 *
 * 于是要做的只有三件事，UI 就必须把这三件事摆明白：
 *   ① 在哪 —— 当前工作区 / 当前会话是什么（DSH 的真实清单，实时跟随）
 *   ② 现在生效的是哪套 —— 会话 > 工作区 > 全局 三级里，哪一级赢了、赢在哪
 *   ③ 改哪一套 —— 编辑"组合"（一份名单），再把它指定给某一级
 *
 * 设计要点
 *   · **工作区 / 会话一律读 DSH 自己的服务**（`ctx.get('workspaces')` /
 *     `ctx.get('sessions')` 的 `list.getSnapshot()` + `list.subscribe()`），
 *     **绝不自己拼一份假的** —— 上一版就是自己拼的，工作区永远是空的。
 *   · **空名单 = 不过滤 = 全部**：所以成员列表**永远全列出来**，不过滤时全部是勾上的。
 *     **没有「显示全部 / 只看已选」这种开关**（上一版就是把"不过滤"画成"0 个已选"）。
 *   · 单位一律是**插件 / 技能**，"几个工具"只作为次要说明。
 *   · **没有每秒 tick**：改由服务订阅驱动重渲染，空闲时一个 DOM 变动都没有（不跳）。
 *   · 改动**自动保存**（防抖 400ms）—— 不用先想"保存了没有"。
 *   · 组件一律定义在 factory 作用域，**绝不定义在渲染里**（不然每次渲染都重挂 = 跳动）。
 *   · 不编号（序号是给操作步骤的，不是装饰）。
 *
 * MCP servers get one catalog row each and are never narrowed by a composition;
 * their tools stay non-resident like every other tool.
 */

/**
 * Declare only services that actually resolve.
 *
 * A name in here that cannot be resolved leaves the loader pending forever, so
 * the plugin never reaches the system. 'locale' always resolves:
 * @deepseek-ai/dsh-client-locale calls ctx.provide('locale', …) on every client
 * start.
 *
 * The local binding is deliberately NOT called `inject`. Evaluating two versions
 * of this bundle in one tab (a stale HMR copy next to the new one) throws
 * `SyntaxError: Identifier 'inject' has already been declared`, and a duplicated
 * top-level identifier is a whole-bundle syntax error — every plugin on the page
 * goes blank. Every top-level const in this file carries a `CC_` or `composer`
 * prefix for that reason.
 */
/* i18n — 'locale' is declared because the UI copy follows the DSH interface
   language. Unlike a misspelt dependency this one always resolves:
   @deepseek-ai/dsh-client-locale provides it with ctx.provide('locale', …)
   on every client start. */
const composerInject = ['locale']

const CC_TAB_ID = 'capability-composer'
const CC_TAB_ORDER = 50
/** 「技能组合」页签的 id（与「插件组合」并列，同一个 settings.plugins.tab slot）。 */
const CC_SKILLS_TAB_ID = 'capability-composer-skills'
/** order 排在「插件组合」之后（+1），两者挨着显示。 */
const CC_SKILLS_TAB_ORDER = 51
const CC_API = '/dsh-capability-composer'
const CC_SAVE_DEBOUNCE_MS = 400

/**
 * 「全不选」的哨兵成员。
 *
 * 状态文件里 `plugins: []` / `skills: []` 的含义是**不过滤（全部）**，所以「一个都不要」
 * 没法用空数组表达。约定：名单里**只有** `__none__` 这一项 = 全不选。
 *   · 技能轴：宿主把 allow 集合当成 `{__none__}` ⇒ 所有技能都被遮蔽（现有逻辑直接支持）。
 *   · 插件轴：目录为空、`load_plugin` 一律判 blocked（现有逻辑直接支持）；
 *     工具 glob 那一层另有一行兜底（见 lib/index.js 的 NEVER_GLOB）。
 */
const CC_NONE = '__none__'

/**
 * 「系列」的分隔符与"新建系列"哨兵值。
 *
 * 系列**不是**状态文件里的新字段，就是组合名里 `·` 之前那一段：
 * `开发·日常` → 系列「开发」；`全量` → 不分组。这样 host 状态格式完全不动，
 * 跨版本 / 换电脑 / 别的地方（比如批量建组合的脚本）都能用同一套规则。
 */
const CC_SERIES_SEP = '·'
const CC_SERIES_NEW = '__new__'
/** 取组合名的系列（没写分隔符 = 不分组，返回 ''）。 */
function seriesOf(name) {
  const s = String(name ?? '')
  const i = s.indexOf(CC_SERIES_SEP)
  return i > 0 ? s.slice(0, i) : ''
}
/**
 * pin 值 → 组合名数组（**兼容两种写法**）。
 *   「开发·日常」 → ['开发·日常']（旧版单值）
 *   ['A','B']     → ['A','B']（新版多选）
 *   null / '' / [] → []（= 这一级没指定，往上继承）
 */
function pinNamesOf(value) {
  if (typeof value === 'string' && value !== '') return [value]
  if (Array.isArray(value)) return value.filter((n) => typeof n === 'string' && n !== '')
  return []
}
/** 把组合名按系列分组（有系列的按名字排前面，不分组排最后）。 */
function groupBySeries(names) {
  const map = new Map()
  for (const n of names) {
    const s = seriesOf(n)
    if (!map.has(s)) map.set(s, [])
    map.get(s).push(n)
  }
  const keys = [...map.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh')))
  return keys.map((s) => ({ series: s, names: map.get(s) }))
}

window.__ModuleLoader__.load({
  id: 'dsh-capability-composer',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const jsx = jsxRuntime.jsx
    const jsxs = jsxRuntime.jsxs
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    /** 客户端 ctx —— `apply` 里存下来，组件要用它读宿主服务。 */
    let HOST = null

    /* ------------------------------------------------------------------ *
     * Copy
     * ------------------------------------------------------------------ */
    const CC_ZH = {
          'unit.skill': '技能',
          'unit.plugin': '插件',
          'unit.skill.cap': '技能',
          'unit.plugin.cap': '插件',
          'common.compositionOf': '{unit}组合',
          'sep.enum': '、',
          'pick.inherit': '继承（不指定）',
          'pick.multiHint': '可多选 —— 选中的几套一起生效（并集）',
          'pick.clear': '清空（回到继承）',
          'btn.collapse': '收起',
          'pick.titleHint': '可以多选：同一级里选几套组合就一起生效（取并集）',
          'comp.empty': '还没有组合。',
          'search.skill': '搜索技能',
          'search.plugin': '搜索插件',
          'view.all': '全部',
          'view.on': '已选',
          'view.off': '未选',
          'btn.selectAll': '全选',
          'btn.selectNone': '全不选',
          'hint.noFilter': '不过滤：全部 {n} 个{unit}都可见。取消任意一项就变成白名单。',
          'hint.none': '全不选：一个都不进目录（{reason}）。',
          'hint.none.skill': '技能目录里不会出现任何技能',
          'hint.none.plugin': '插件目录里不会出现任何插件，工具也搜不到',
          'hint.allowlist': '白名单：只有勾上的 {n} 个进目录。',
          'warn.stale': '⚠ 名单里有 {n} 项现在已经不存在了（被卸载或改名），它们不会生效、也不会报错，只是白占位置：',
          'btn.pruneStale': '把不存在的清掉',
          'list.noMatch': '没有匹配的。',
          'list.notMissing': '一项都没漏 —— 现在是「不过滤」，全部都在名单里。',
          'list.noneOff': '没有没选中的。',
          'list.noneOn': '还没有选中任何一项。',
          'list.empty': '清单是空的。',
          'badge.uiOnly': '体',
          'badge.uiOnly.tip': '体验插件（只给你用，agent 调不到它）\n\n它没有向 agent 注册任何工具，装它只是为了让你在界面上用得更好。\n判定依据（四条同时成立才算，任何一条不成立都不标）：\n  ① 读到了它的包代码  ② 代码里没有 tools.register 调用\n  ③ 没有声明 inject: tools  ④ 代码里找不到任何工具名',
          'badge.unknown.tip': '读不到这个插件的包代码，所以不确定它有没有模型工具 —— 不贴标签（宁可不说，也不猜错）',
          'tools.list.tip': '它的工具：\n',
          'tools.count': '{n} 个工具',
          'unassigned.desc': '这些工具没有任何插件认领它们（比如 agent_teams_*、ppt_*）。勾上它模型才搜得到它们 —— 所以这条叫"兜底行"。',
          'badge.current': '当前',
          'disabled.skill': '已停用（{n} 个，勾不了 —— 模型看不到它们，去技能面板开）',
          'disabled.plugin': '未启用（{n} 个，勾不了 —— 插件没挂上，底下的工具也不存在）',
          'error.save': '保存失败：{error}',
          'error.hostApi': '读不到宿主接口：{error}',
          'btn.retry': '重试',
          'state.loading': '正在读取…',
          'level.session': '当前会话',
          'level.workspace': '当前工作区',
          'level.global': '全局',
          'state.saving': '保存中…',
          'state.pending': '待保存…',
          'state.saved': '已保存 · 下一步请求生效',
          'state.synced': '已同步',
          'state.autoSave': '(自动保存)',
          'btn.reload': '重新载入',
          'level.now': '现在',
          'level.workspaceShort': '工作区',
          'ws.unknown': '还没识别到（新会话发一条消息后就有）',
          'level.sessionShort': '会话',
          'ws.unknownShort': '还没识别到',
          'session.untitled': '（无标题）',
          'level.effective': '生效',
          'scope.none': '全不选（一个都不进目录）',
          'scope.allVisible': '不过滤（全部可见）',
          'level.list': '清单',
          'note.skills': '和「技能面板」同源：只列**已启用**的技能（停用的模型看不到，勾了也没用）。技能面板按来源计数、同名算两次，所以那边的总数会更大。',
          'note.plugins': '只列**已经启用**的插件（未启用的在列表末尾灰着）。工具数按工具名的命名空间推导 —— DSH 的工具注册表不带归属。',
          'scope.union': '（{n} 套并集）',
          'scope.from': '来自{from}',
          'scope.count': '{visible} / {total} 个{unit}',
          'skillStat.total': '技能 {n} 条 · 已启用（与技能面板一致）',
          'skillStat.disabledList': '，另有 {n} 条已停用',
          'pluginStat.total': '插件 {n} 个',
          'pluginStat.bucket': '，另加 1 条兜底行「未归属工具」',
          'pluginStat.disabledList': '；{n} 个插件未启用（不可选）',
          'pluginStat.rescanHint': ' · 工具归属与「体」徽标要重启 DSH 后才精确',
          'state.reloaded': '已重新载入 · {time}',
          'warn.missingSelected': '⚠ 选中的组合里有 {n} 套已经不存在了（{list}），它们不生效、也不算数，现在按剩下的处理。下面重新选一下就会覆盖掉。',
          'scope.usedHere': '这里用',
          'scope.writeTo': '写入「{name}」',
          'scope.createFirst': '（先在下面建一个组合）',
          'comp.header': '组合',
          'btn.new': '新建',
          'comp.intro': '一个组合就是一份{unit}名单。上面「这里用」选的就是这里的名字。想分类就用「系列」——系列就是名字里「{sep}」之前那一段（开发{sep}日常 属于系列「开发」），新建时选一个或自己起一个都行。',
          'series.tip': '系列：把组合按用途分家。就是个名字前缀（「开发{sep}日常」属于系列「开发」），\n换个系列名就是自定义系列。',
          'series.ungrouped': '不分组',
          'series.new': '＋新系列…',
          'series.namePlaceholder': '新系列名',
          'comp.namePlaceholder': '新组合的名字',
          'btn.create': '创建',
          'btn.cancel': '取消',
          'comp.duplicate': '这个名字已经有了',
          'btn.createNew': '新建一个',
          'series.dragHint': '按住 0.2 秒可以拖动整个系列（系列之间排序）',
          'series.label': '系列「{name}」· {n} 个',
          'series.deleteWarn': '⚠ 这是**系列**，删除「{name}」会连下面这 {n} 个组合一起删掉（绑过它们的地方会退回继承）：',
          'series.confirmDelete': '确认删除这 {n} 个',
          'series.renamePlaceholder': '新系列名（留空=取消系列）',
          'btn.done': '改好',
          'series.renameTip': '把这一组里 {n} 个组合的前缀**一起**改掉（绑定的引用也跟着改）；\n新名字留空 = 取消系列（回到「不分组」）。',
          'btn.renameSeries': '改系列名',
          'series.deleteTip': '删除整个系列：这一组 {n} 个组合会**一起被删掉**（会先红字列清单让你确认）',
          'btn.deleteSeries': '删系列',
          'comp.labelOf': '「{name}」的{unit}',
          'btn.rename': '改名',
          'btn.delete': '删除',
          'compact.hint.all': '不过滤 · 全部 {n} 个{unit}都进目录',
          'compact.hint.none': '全不选 · 一个都不进目录',
          'compact.hint.allow': '白名单 · 名单里 {n} 项：',
          'compact.hint.live': '{n} 项可用',
          'compact.hint.dead': '，{n} 项已失效（下面可一键清掉）',
          'scope.header': '用在哪',
          'scope.tip': '越具体越优先：会话 > 工作区 > 全局。没指定的就往上继承。',
          'scope.globalTip': '全局（所有工作区的默认）',
          'scope.noFilter': '不过滤',
          'inherit.global': '继承全局（{names}）',
          'inherit.global.short': '继承全局',
          'inherit.workspace.short': '继承工作区',
          'session.collapse': '收起会话',
          'session.header': '会话 {n}',
          'session.overridden': '（{n} 个单独指定）',
          'inherit.workspace': '继承工作区（{names}）',
          'session.orphan': '当前会话（不属于任何工作区）',
          'ws.currentDir': '当前目录（还没注册成工作区）',
          'ws.currentDirTip': '会话级没指定时按它走',
          'ws.none': 'DSH 里还没有工作区。用左侧边栏的「添加工作区」建一个。',
          'ws.serviceMissing': '读不到 DSH 的工作区服务（插件可能没挂上）。',
          'note.skillsTab': '这一页只管技能。没进名单的技能不进技能目录，但 /技能名 仍可手动调用。',
          'note.pluginsTab': '这一页只管插件。组合收窄的是"模型的插件目录"，插件本身照常运行、界面照常显示；收窄后仍是 search_plugins → load_plugin 整组拉进来。',
          'note.mcp': 'MCP 工具完全不受这里影响，归 MCP 面板自己管。',
          'error.render': '{unit}组合 UI 渲染失败（宿主页面不受影响）：{error}',
          'tab.plugins': '插件组合',
          'tab.skills': '技能组合',
          'confirm.cancelSeries': '取消「{name}」系列？这 {n} 个组合会回到「不分组」：\n\n{list}',
          'confirm.deleteComp': '删除组合「{name}」？引用它的地方会退回继承。',
          'compact.all': '不过滤（全部）',
          'compact.picked': '{live} 个可用，{dead} 个已失效',
          'compact.live': '{live} 个可用',
          'compact.dragHint': '\n\n按住 0.2 秒可以拖动排序（只在同一系列内挪）',
          'compact.count': '{live} 个',
          'compact.countBoth': '{live} 个 + {dead} 失效',
          'comp.willCreate': '将建成「{name}」'
    };

    /* English table: same key set and same key order as CC_ZH. It is also the
       fallback chain's terminator, so it has to be shipped. */
    const CC_EN = {
          'unit.skill': 'skill',
          'unit.plugin': 'plugin',
          'unit.skill.cap': 'Skill',
          'unit.plugin.cap': 'Plugin',
          'common.compositionOf': '{unit} composition',
          'sep.enum': ', ',
          'pick.inherit': 'Inherit (unspecified)',
          'pick.multiHint': 'Multi-select — every checked set applies (union)',
          'pick.clear': 'Clear (back to inherit)',
          'btn.collapse': 'Collapse',
          'pick.titleHint': 'Multi-select: checking several compositions at one level applies all of them (union)',
          'comp.empty': 'No compositions yet.',
          'search.skill': 'Search skills',
          'search.plugin': 'Search plugins',
          'view.all': 'All',
          'view.on': 'Selected',
          'view.off': 'Unselected',
          'btn.selectAll': 'Select all',
          'btn.selectNone': 'Select none',
          'hint.noFilter': 'No filtering: all {n} {unit}s are visible. Unchecking any one turns this into an allowlist.',
          'hint.none': 'Select none: nothing enters the catalog ({reason}).',
          'hint.none.skill': 'no skill will appear in the skill catalog',
          'hint.none.plugin': 'no plugin will appear in the plugin catalog and its tools cannot be found',
          'hint.allowlist': 'Allowlist: only the {n} checked ones enter the catalog.',
          'warn.stale': '⚠ {n} entries in this list no longer exist (uninstalled or renamed). They have no effect and raise no error — they just take up space:',
          'btn.pruneStale': 'Remove the missing ones',
          'list.noMatch': 'No matches.',
          'list.notMissing': 'Nothing is missing — with no filtering, everything is in the list.',
          'list.noneOff': 'Nothing is unchecked.',
          'list.noneOn': 'Nothing is selected yet.',
          'list.empty': 'The list is empty.',
          'badge.uiOnly': 'UX',
          'badge.uiOnly.tip': 'UI-only plugin (for you only — the agent cannot call it)\n\nIt registers no tools with the agent; it is installed purely to make the interface better for you.\nHow this is decided (all four must hold, otherwise no badge at all):\n  ① its package code was read  ② the code has no tools.register call\n  ③ it does not declare inject: tools  ④ no tool name can be found in the code',
          'badge.unknown.tip': 'This plugin\'s package code could not be read, so it is unknown whether it has model tools — no badge (better to say nothing than to guess wrong)',
          'tools.list.tip': 'Its tools:\n',
          'tools.count': '{n} tools',
          'unassigned.desc': 'No plugin claims these tools (for example agent_teams_*, ppt_*). The model can only find them when this row is checked — hence "catch-all row".',
          'badge.current': 'Current',
          'disabled.skill': 'Disabled ({n} of them, cannot be checked — the model cannot see them; enable them in the skills panel)',
          'disabled.plugin': 'Not enabled ({n} of them, cannot be checked — the plugin is not mounted, so its tools do not exist)',
          'error.save': 'Save failed: {error}',
          'error.hostApi': 'Cannot read the host API: {error}',
          'btn.retry': 'Retry',
          'state.loading': 'Loading…',
          'level.session': 'Current session',
          'level.workspace': 'Current workspace',
          'level.global': 'Global',
          'state.saving': 'Saving…',
          'state.pending': 'Pending save…',
          'state.saved': 'Saved · takes effect on the next request',
          'state.synced': 'Synced',
          'state.autoSave': '(auto-saved)',
          'btn.reload': 'Reload',
          'level.now': 'Now',
          'level.workspaceShort': 'Workspace',
          'ws.unknown': 'Not detected yet (it appears after you send a message in a new session)',
          'level.sessionShort': 'Session',
          'ws.unknownShort': 'Not detected yet',
          'session.untitled': '(untitled)',
          'level.effective': 'In effect',
          'scope.none': 'Select none (nothing enters the catalog)',
          'scope.allVisible': 'No filtering (all visible)',
          'level.list': 'List',
          'note.skills': 'Same source as the skills panel: only **enabled** skills are listed (the model cannot see disabled ones, so checking them does nothing). That panel counts by source and counts a duplicate name twice, so its total is larger.',
          'note.plugins': 'Only **enabled** plugins are listed (disabled ones sit greyed out at the end). Tool counts are inferred from the tool-name namespace — the DSH tool registry carries no ownership.',
          'scope.union': ' ({n} sets, union)',
          'scope.from': 'from {from}',
          'scope.count': '{visible} / {total} {unit}s',
          'skillStat.total': 'Skills: {n} · enabled (same as the skills panel)',
          'skillStat.disabledList': ', plus {n} disabled',
          'pluginStat.total': 'Plugins: {n}',
          'pluginStat.bucket': ', plus 1 catch-all row "Unassigned tools"',
          'pluginStat.disabledList': '; {n} plugins not enabled (not selectable)',
          'pluginStat.rescanHint': ' · tool ownership and the "UX" badge are only exact after restarting DSH',
          'state.reloaded': 'Reloaded · {time}',
          'warn.missingSelected': '⚠ {n} of the selected compositions no longer exist ({list}). They have no effect and do not count; the remaining ones are used. Picking again below overwrites this.',
          'scope.usedHere': 'Used here',
          'scope.writeTo': 'Writes to "{name}"',
          'scope.createFirst': '(create a composition below first)',
          'comp.header': 'Compositions',
          'btn.new': 'New',
          'comp.intro': 'A composition is one {unit} list. "Used here" above picks a name from this list. To group them, use a "series" — the part of the name before "{sep}" (dev{sep}daily belongs to the series "dev"). Pick one when creating, or type your own.',
          'series.tip': 'Series: split compositions by purpose. A series is just a name prefix ("dev{sep}daily" belongs to the series "dev");\nchoosing a different series name makes it a custom series.',
          'series.ungrouped': 'Ungrouped',
          'series.new': '+ New series…',
          'series.namePlaceholder': 'New series name',
          'comp.namePlaceholder': 'New composition name',
          'btn.create': 'Create',
          'btn.cancel': 'Cancel',
          'comp.duplicate': 'That name is already taken',
          'btn.createNew': 'Create one',
          'series.dragHint': 'Hold for 0.2 s to drag a whole series (reorders series)',
          'series.label': 'Series "{name}" · {n}',
          'series.deleteWarn': '⚠ This is a **series**: deleting "{name}" also deletes the {n} compositions below (anything bound to them falls back to inherit):',
          'series.confirmDelete': 'Delete these {n}',
          'series.renamePlaceholder': 'New series name (empty = drop the series)',
          'btn.done': 'Done',
          'series.renameTip': 'Renames the prefix of all {n} compositions in this group **together** (bound references follow);\nleaving the new name empty un-groups them (back to "Ungrouped").',
          'btn.renameSeries': 'Rename series',
          'series.deleteTip': 'Delete the whole series: all {n} compositions in this group are **deleted together** (a red list asks for confirmation first)',
          'btn.deleteSeries': 'Delete series',
          'comp.labelOf': '{unit} of "{name}"',
          'btn.rename': 'Rename',
          'btn.delete': 'Delete',
          'compact.hint.all': 'No filtering · all {n} {unit}s enter the catalog',
          'compact.hint.none': 'Select none · nothing enters the catalog',
          'compact.hint.allow': 'Allowlist · {n} entries:',
          'compact.hint.live': '{n} available',
          'compact.hint.dead': ', {n} missing (one click below clears them)',
          'scope.header': 'Where it applies',
          'scope.tip': 'The more specific level wins: session > workspace > global. Anything unspecified inherits upward.',
          'scope.globalTip': 'Global (the default for every workspace)',
          'scope.noFilter': 'no filtering',
          'inherit.global': 'Inherit global ({names})',
          'inherit.global.short': 'Inherit global',
          'inherit.workspace.short': 'Inherit workspace',
          'session.collapse': 'Collapse sessions',
          'session.header': 'Sessions: {n}',
          'session.overridden': ' ({n} set individually)',
          'inherit.workspace': 'Inherit workspace ({names})',
          'session.orphan': 'Current session (not in any workspace)',
          'ws.currentDir': 'Current directory (not registered as a workspace yet)',
          'ws.currentDirTip': 'Used when the session level specifies nothing',
          'ws.none': 'There are no workspaces in DSH yet. Create one with "Add workspace" in the left sidebar.',
          'ws.serviceMissing': 'Cannot read the DSH workspace service (the plugin may not be mounted).',
          'note.skillsTab': 'This page only covers skills. A skill outside the list stays out of the skill catalog, but /skill-name still works as a manual call.',
          'note.pluginsTab': 'This page only covers plugins. A composition narrows "the model\'s plugin catalog"; the plugins themselves keep running and keep rendering. Even when narrowed, search_plugins → load_plugin still pulls the whole group in.',
          'note.mcp': 'MCP tools are completely unaffected by this and are managed by the MCP panel itself.',
          'error.render': 'Failed to render the {unit} composition UI (the host page is unaffected): {error}',
          'tab.plugins': 'Plugin composition',
          'tab.skills': 'Skill composition',
          'confirm.cancelSeries': 'Drop the "{name}" series? These {n} compositions go back to "Ungrouped":\n\n{list}',
          'confirm.deleteComp': 'Delete the composition "{name}"? Anything referencing it falls back to inherit.',
          'compact.all': 'No filtering (all)',
          'compact.picked': '{live} available, {dead} missing',
          'compact.live': '{live} available',
          'compact.dragHint': '\n\nHold for 0.2 s to drag and reorder (within the same series only)',
          'compact.count': '{live}',
          'compact.countBoth': '{live} + {dead} missing',
          'comp.willCreate': 'Will be created as "{name}"'
    };

    /* ------------------------------------------------------------------ *
     * Copy / i18n
     *
     * The tables above hold EVERY user-visible string of this plugin; the code
     * below only ever reaches them through t(). Two rules keep that honest:
     *   · the zh table is the original copy, character for character — t() in zh
     *     renders exactly what this file rendered before the tables existed;
     *   · a key missing from the active language falls back to en, then to the key
     *     itself, so t() can never return undefined and can never throw.
     * ------------------------------------------------------------------ */
    const CC_COPY_LANGUAGES = ['zh', 'en']
    const CC_DICTS = {}
    function registerLanguage (id, table) {
      const key = typeof id === 'string' ? id.trim().toLowerCase() : ''
      if (key === '' || table === null || table === undefined || typeof table !== 'object') return false
      if (CC_COPY_LANGUAGES.indexOf(key) === -1) CC_COPY_LANGUAGES.push(key)
      CC_DICTS[key] = table
      return true
    }
    registerLanguage('zh', CC_ZH)
    registerLanguage('en', CC_EN)

    function copyDict (lang) {
      const key = typeof lang === 'string' ? lang.trim().toLowerCase() : ''
      if (Object.prototype.hasOwnProperty.call(CC_DICTS, key)) return CC_DICTS[key]
      return CC_EN
    }

    /* DSH's locale service keeps the document language in sync (dsh-client-locale
       does: document.documentElement.lang = active === 'zh' ? 'zh-CN' : active),
       so the DOM tag is a true mirror of the interface language, not a guess. */
    function normalizeLang (raw) {
      if (typeof raw !== 'string') return null
      const tag = raw.trim().toLowerCase()
      if (tag === '') return null
      /* A tag this plugin ships copy for keeps its own identity, so registering a
         new table (registerLanguage) is all it takes to switch to it. */
      if (Object.prototype.hasOwnProperty.call(CC_DICTS, tag)) return tag
      return tag === 'zh' || tag.indexOf('zh-') === 0 || tag.indexOf('zh_') === 0 ? 'zh' : 'en'
    }

    function langFromDom () {
      return typeof document === 'undefined' || !document.documentElement
        ? null
        : normalizeLang(document.documentElement.lang)
    }

    /* The declared 'locale' dependency may still be unresolved while the module is
       being evaluated, so every layer is defensive: unreadable means "fall back to
       the DOM", never an exception. */
    function localeServiceActive () {
      if (HOST === null || HOST === undefined) return null
      let service
      try { service = HOST.get('locale') } catch { return null }
      if (!service) return null
      /* Contract today: getLocale() -> { active, locales, revision }. A bare
         snapshot object is tolerated too, so a contract change degrades to
         "unreadable" instead of throwing. */
      let snapshot
      try {
        snapshot = typeof service.getLocale === 'function' ? service.getLocale() : service
      } catch { return null }
      return snapshot && typeof snapshot.active === 'string' ? normalizeLang(snapshot.active) : null
    }

    function currentLang () {
      return localeServiceActive() || langFromDom()
        || normalizeLang(typeof navigator === 'undefined' ? '' : navigator.language) || 'en'
    }

    function t (key, vars) {
      const lang = currentLang()
      const own = copyDict(lang)
      /* A key is always a string literal at the call sites, but this must be total:
         String() the key first so a stray null/undefined cannot make the lookups or
         the key fallback below anything other than a string. */
      const name = key === null || key === undefined ? '' : String(key)
      /* own table -> en -> the key itself: a registered table may be partial
         (a future language is not obliged to translate every row), and the key
         fallback is what keeps a missing row from rendering as "undefined". */
      const base = typeof own[name] === 'string'
        ? own[name]
        : (typeof CC_EN[name] === 'string' ? CC_EN[name] : name)
      let text = base
      if (vars) {
        for (const field of Object.keys(vars)) {
          text = text.split('{' + field + '}').join(String(vars[field]))
        }
      }
      return text
    }

    /* How each shipped language is named in a language picker. */
    const CC_COPY_LANGUAGE_LABELS = { zh: '中文', en: 'English' }

    /* Offer this plugin's languages to the locale service so a language the service
       does not ship yet can still be selected. Optional by design: every failure
       (older service, an id it already owns, a throwing implementation) is
       swallowed — losing this must never cost the plugin its mount. */
    function announceLanguages (service) {
      if (!service || typeof service.addLanguage !== 'function') return
      const known = {}
      try {
        const snapshot = typeof service.getLocale === 'function' ? service.getLocale() : service
        const locales = snapshot && snapshot.locales
        if (locales) {
          for (const id of Object.keys(locales)) known[id.trim().toLowerCase()] = true
        }
      } catch { /* unreadable snapshot: try every id and let the service decide */ }
      for (const id of CC_COPY_LANGUAGES) {
        /* Re-registering an id the service owns throws by contract, so skip the
           ones it already lists (zh and en in the shipped service). */
        if (Object.prototype.hasOwnProperty.call(known, id)) continue
        const label = Object.prototype.hasOwnProperty.call(CC_COPY_LANGUAGE_LABELS, id)
          ? CC_COPY_LANGUAGE_LABELS[id]
          : id
        try { service.addLanguage({ id, label, fallback: 'en' }) } catch { /* already registered */ }
      }
    }

    /* This plugin has no global store: its screens are plain React components, so
       the existing reactive mechanism IS React state. Every mount root subscribes
       through useCopy() and re-renders its own subtree when the language changes —
       no second rendering path is introduced. */
    const CC_LANG_SUBSCRIBERS = new Set()
    function retranslate () {
      for (const notify of Array.from(CC_LANG_SUBSCRIBERS)) {
        try { notify() } catch { /* one dead subscriber must not stop the others */ }
      }
    }
    function useCopy () {
      const [, setLanguageRevision] = useState(0)
      useEffect(() => {
        const notify = () => setLanguageRevision((n) => n + 1)
        CC_LANG_SUBSCRIBERS.add(notify)
        return () => { CC_LANG_SUBSCRIBERS.delete(notify) }
      }, [])
    }

    function languageWatcher (ctx) {
      let service = null
      try { service = ctx === undefined || ctx === null ? null : ctx.get('locale') } catch { service = null }
      if (service && typeof service.subscribe === 'function') {
        /* Preferred source: it fires even when <html lang> does not change (two
           locales collapsing to the same tag, or a future tag scheme). */
        service.subscribe(retranslate)
        announceLanguages(service)
        return undefined
      }
      /* No locale service: the DOM tag is the only live signal there is. */
      if (typeof MutationObserver !== 'function' || typeof document === 'undefined') {
        return undefined
      }
      const observer = new MutationObserver(retranslate)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
      return () => { try { observer.disconnect() } catch { /* ignore */ } }
    }


    /**
     * 组件重挂也不丢的临时 UI 状态。
     *
     * 宿主会周期性重挂设置面板，放 `useState` 里会出现"打一个字就被刷掉"。
     * 只放**纯 UI 的临时状态**（草稿与已保存值在 Composer 里单独保管）。
     */
    const PERSIST = {}
    /**
     * 最近一次**成功**拿到宿主 `/state` 的时间戳（模块级：跨面板重挂保留）。
     *
     * 反馈「进了 UI 会一直刷新刷新刷新，过一会又不刷新了，过一会又刷新」
     * 宿主的设置面板会被**周期性重挂**，每重挂一次本插件的 effect 就重跑一次、
     * 再打一次 `/state`，看上去就是面板在反复刷新。5 秒内已经拿到过就跳过
     * （显式点「重新载入」会给 reloadAt +1，不受这条节流限制）。
     */
    const STATE_FETCH_STAMP = { at: 0 }
    function useKeep(key, initial) {
      const [value, setValue] = useState(() => (Object.prototype.hasOwnProperty.call(PERSIST, key) ? PERSIST[key] : initial))
      const set = useCallback((next) => {
        setValue((prev) => {
          const v = typeof next === 'function' ? next(prev) : next
          PERSIST[key] = v
          return v
        })
      }, [key])
      return [value, set]
    }

    /*
     * **跨重启**的缓存（反馈「每次一启动就一直是正在读取，要等很久，
     * 退出再点开才正常」）。
     *
     * `PERSIST` 只是模块级对象：页面一刷新（DSH 每次重启都是新页面）它就空了。
     * 早先那版"缓存优先"因此只在**同一次页面生命周期**内成立 —— 冷启动时缓存
     * 必然是空的，面板只能整块等宿主 `/state`，而宿主那一刻还在装配插件（实测几十秒）。
     *
     * 现在把这几份"读得到就不用转圈"的数据同时写进 localStorage：刷新/重启后的第一帧
     * 就按上次的结果画，网络回来再刷新。读写全部包在 try 里 —— 隐私模式 / 配额满 /
     * 被策略禁用时静默降级回旧行为，绝不因此报错。
     *
    /**
 * localStorage 键前缀。
 *
 * 加了 `v2:` 版本段。
 *
 * 原因：老版本把「组合草稿」也缓存在这里，而自动保存是**整轴覆盖**写回
 * （见本文件 "修复「组合被旧快照覆盖」"）。结果是——外部往 compositions.json 里
 * 加了组合（脚本 / 手改 / 本插件升级自带），界面上只要动一下就被旧快照整批抹掉，
 * 界面上看到的永远是"新加的东西不存在"。
 *
 * 语义修正后，**老键里的旧快照必须作废**，否则它还会再覆盖一次。
 * 加版本段 = 让 old key 读不到（等价于"精确清掉本插件的缓存"，不影响别的插件）。
 * 以后再遇到"缓存格式/语义变了"，同样 bump 这个版本号，别去删别的东西。
 */
const LS_PREFIX = 'dsh-capability-composer:v2:'
    /** 面板里那份 `/state` 快照的缓存键（两个页签各一份，键名与面板里的 K() 一致）。 */
    function stateCacheKey(facet) { return 'composer:' + facet + ':stateCache' }
    /**
     * P2：「最后一次成功取到 /state 的时间」也落盘。
     *
     * 给 `prefetchStateOnce` 判断"缓存够不够新"用 —— 它原先只看"有没有"，于是重启后
     * （localStorage 里还留着上次的 state）预热直接 return ⇒ 面板一打开先看到一份
     * **可能很旧**的状态，然后才发请求去拉新的：多一次往返，还会短暂显示过期数据。
     *
     * 用独立键，**不动 stateCache 的结构**（面板那一侧还在读它）。
     */
    const STATE_CACHE_AT_KEY = 'composer:state:at'
    /** 缓存超过这个年龄就重新预热（只看"有没有"是不够的，见上）。 */
    const PREFETCH_MAX_AGE_MS = 5 * 60 * 1000
    /** 技能清单的缓存键（只用来画第一帧，随后总是被会话级清单覆盖）。 */
    const SKILL_CACHE_KEY = 'skills:list'
    function lsRead(key) {
      try {
        const raw = window.localStorage.getItem(LS_PREFIX + key)
        return raw === null ? null : JSON.parse(raw)
      } catch { return null }
    }
    function lsWrite(key, value) {
      try { window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value)) } catch { /* 降级：只留内存缓存 */ }
    }

    /** 像 useKeep，但**同时**落在 localStorage（跨刷新、跨重启还在）。只给"有它就不用转圈"的数据用。 */
    function useCached(key, initial) {
      const [value, setValue] = useState(() => {
        if (Object.prototype.hasOwnProperty.call(PERSIST, key)) return PERSIST[key]
        const saved = lsRead(key)
        PERSIST[key] = saved
        return saved === null || saved === undefined ? initial : saved
      })
      const set = useCallback((next) => {
        setValue((prev) => {
          const v = typeof next === 'function' ? next(prev) : next
          PERSIST[key] = v
          if (v === null || v === undefined) {
            try { window.localStorage.removeItem(LS_PREFIX + key) } catch { /* 忽略 */ }
          } else lsWrite(key, v)
          return v
        })
      }, [key])
      return [value, set]
    }

    /**
     * 带**超时**与有限重试的 JSON GET。
     *
     * 为什么必须有超时：宿主启动期事件循环被插件装配占住，一个已经建立的 HTTP 连接会
     * **挂住不返回**（不是 500，也不是拒绝）。没有超时的话面板就永远停在「正在读取…」
     * （实测"启动了十分钟还在读"）。超时后重试，仍然拿不到就由面板给出错误行 + 重试按钮。
     */
    /**
     * P0：超时预算集中在这里，别再散落在调用点上。
     *
     * 实测（harness.log 时间线）：DSH 启动 **25 秒**，其中这四个插件只占 1.2 秒 ——
     * 剩下的时间是别的插件在装配，以及 VeighNa MCP server 起 Python 子进程。
     * 这段时间里宿主事件循环被占住，**已建立的 HTTP 连接会挂住不返回**（不是 500，
     * 也不是拒绝）。界面上显示的就是「一直在读」。
     *
     * **无损原则：超时值一律保持原值。**
     *
     * 曾经把面板那处从 12000 收到 4000（最坏等待 38.1s → 8.9s），但那是**有损**的：
     * 如果宿主在 4~12 秒之间能回，原来会成功、收紧后会变成重试。虽然代码注释说
     * 那种连接是"挂住不返回"（暗示永不返回 ⇒ 收紧无损），但**这一点没有被实测证实**
     * 不能拿未证实的推断去换别人的等待时间。
     *
     * ⇒ 现在只做**不改变成败**的优化：退避间隔（省 1.2 秒，失败次数一样）。
     * 想真正缩短等待，正确做法是**加进度反馈**（面板在 4 秒时先显示「宿主正在启动…」），
     * 而不是把请求掐掉 —— 那是下一步，不是这里。
     *
     * 若将来实测确认"挂住 = 永不返回"（例如连续 N 次启动都在超时后仍未收到任何字节），
     * 再把 timeout 收紧才有依据。
     */
    const STATE_LOAD_TRIES = 3
    const STATE_LOAD_TIMEOUT_MS = 12000
    const STATE_PREWARM_TIMEOUT_MS = 15000

    /**
     * P1：自动保存的读写也要有超时。
     * 原先那两处是**裸 fetch**（没有 signal）—— 宿主挂住时保存请求永久不返回，
     * 界面卡在「保存中」，而且得不到任何错误。
     * **这一条是严格无损的**：原来那条路径没有超时（等价于无穷大），加 8 秒只会
     * 把"永久卡死"变成"8 秒后报错、可重试"，不减少任何原本能成功的路径。
     */
    const STATE_SAVE_TIMEOUT_MS = 8000

    /** 重试退避（毫秒），按序取，用完了就停在最后一个。原值 600/1500，省 1.2 秒且不改变成败。 */
    const RETRY_BACKOFF_MS = [300, 600]

    /**
     * 带**超时**与有限重试的 JSON GET。
     *
     * 为什么必须有超时：宿主启动期事件循环被插件装配占住，一个已经建立的 HTTP 连接会
     * **挂住不返回**（不是 500，也不是拒绝）。没有超时的话面板就永远停在「正在读取…」
     * （实测"启动了十分钟还在读"）。超时后重试，仍然拿不到就由面板给出错误行 + 重试按钮。
     */
    async function fetchJsonWithRetry(url, tries, timeoutMs) {
      let last = null
      for (let i = 0; i < tries; i += 1) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = controller === null ? null : setTimeout(() => { try { controller.abort() } catch { /* 忽略 */ } }, timeoutMs)
        try {
          const res = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: controller === null ? undefined : controller.signal,
          })
          const body = await res.json()
          if (timer !== null) clearTimeout(timer)
          if (!res.ok) throw new Error(body === null || body === undefined ? ('HTTP ' + String(res.status)) : (body.error ?? ('HTTP ' + String(res.status))))
          return body
        } catch (error) {
          if (timer !== null) clearTimeout(timer)
          last = error
          if (i < tries - 1) {
            const wait = RETRY_BACKOFF_MS[Math.min(i, RETRY_BACKOFF_MS.length - 1)]
            await new Promise((resolve) => setTimeout(resolve, wait))
          }
        }
      }
      throw last === null ? new Error('fetch failed') : last
    }

    /** P1：一次性的带超时 fetch（给自动保存的 GET/POST 用，见 STATE_SAVE_TIMEOUT_MS）。 */
    async function fetchWithTimeout(url, init, timeoutMs) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => { try { controller.abort() } catch { /* 忽略 */ } }, timeoutMs)
      try {
        return await fetch(url, controller === null ? init : { ...init, signal: controller.signal })
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    /**
     * 预热：客户端半边一挂上就先把 `/state` 取一次（不碰任何 UI）。
     *
     * 反馈「只要不点开那个界面，它就一直显示正在读取」：以前只有面板**挂载**才发请求，
     * 于是那次请求永远落在宿主最忙的时刻。现在页面一加载就取，等面板打开时缓存已经在了。
     * 拿不到也无所谓 —— 面板自己会重试，这只是把"等待"提前到界面看不见的地方。
     */
    let prefetchedState = false
    function prefetchStateOnce() {
      if (prefetchedState) return
      prefetchedState = true
      const has = (key) => PERSIST[key] !== null && PERSIST[key] !== undefined
      /* P2：缓存**够新**才跳过预热（原先只看"有没有"，重启后会拿旧状态先画一帧）。 */
      const cachedAt = Number(lsRead(STATE_CACHE_AT_KEY)?.at ?? 0)
      const freshEnough = Date.now() - cachedAt < PREFETCH_MAX_AGE_MS
      if (freshEnough && has(stateCacheKey('skill')) && has(stateCacheKey('plugin'))) return
      fetchJsonWithRetry(CC_API + '/state', STATE_LOAD_TRIES, STATE_PREWARM_TIMEOUT_MS).then((body) => {
        STATE_FETCH_STAMP.at = Date.now()
        lsWrite(STATE_CACHE_AT_KEY, { at: Date.now() })
        for (const facet of ['skill', 'plugin']) {
          const key = stateCacheKey(facet)
          /* 缓存旧 ⇒ 覆盖它；缓存新却走到这里（缺另一轴）⇒ 只补缺的那个。 */
          if (!freshEnough || !has(key)) {
            PERSIST[key] = body
            lsWrite(key, body)
          }
        }
      }).catch(() => { /* 预热失败不算错：面板挂载时会自己重试 */ })
    }

    /** 运行时取一个宿主服务；取不到返回 undefined（**绝不写 ctx.x 属性访问**）。 */
    function serviceOf(name) {
      try {
        const get = HOST === null || HOST === undefined ? undefined : HOST.get
        if (typeof get !== 'function') return undefined
        return get.call(HOST, name)
      } catch {
        return undefined
      }
    }

    /** 读某个宿主服务的快照（`svc.list.getSnapshot()`）；读不到返回 null。 */
    function snapshotOf(name) {
      try {
        const svc = serviceOf(name)
        const list = svc === undefined || svc === null ? null : svc.list
        if (list === null || list === undefined || typeof list.getSnapshot !== 'function') return null
        return list.getSnapshot()
      } catch {
        return null
      }
    }

    /**
     * 订阅一个宿主服务，**实时跟随**。
     *
     * 关键：快照由宿主缓存，**没变就是同一个对象** ⇒ `setSnap` 传同一个引用时
     * React 自己会 bail out，不会白渲染。所以这里可以放心跟着事件走，
     * 不需要（也故意不要）任何定时 tick。
     *
     * 服务可能比本组件晚就绪（宿主正在启动），此时退化为 500ms 轮询，
     * 绑定成功或试满 40 次就停。
     */
    function useHostSnapshot(name) {
      const [snap, setSnap] = useState(() => snapshotOf(name))
      useEffect(() => {
        let live = true
        const sync = () => { if (live) setSnap(snapshotOf(name)) }
        sync()
        let unsub = null
        let timer = null
        let tries = 0
        const bind = () => {
          try {
            const svc = serviceOf(name)
            const list = svc === undefined || svc === null ? null : svc.list
            if (list !== null && list !== undefined && typeof list.subscribe === 'function') {
              unsub = list.subscribe(sync)
              return true
            }
          } catch { /* 服务还没就绪，等下一轮 */ }
          return false
        }
        if (!bind()) {
          timer = setInterval(() => {
            tries += 1
            sync()
            if (bind() || tries >= 40) { clearInterval(timer); timer = null }
          }, 500)
        }
        return () => {
          live = false
          if (timer !== null) clearInterval(timer)
          if (unsub !== null) { try { unsub() } catch { /* 忽略 */ } }
        }
      }, [name])
      return snap
    }

    function clone(v) {
      return JSON.parse(JSON.stringify(v))
    }

    function shortId(id) {
      if (typeof id !== 'string') return ''
      return id.length > 26 ? id.slice(0, 10) + '…' + id.slice(-8) : id
    }

    /** 状态归一化：两轴都补全，成员一定是数组。读盘和写盘共用同一套形状。 */
    function normalizeState(raw) {
      const out = { version: raw?.version ?? 3, pinned: {}, session: {}, compositions: {} }
      for (const facet of ['skill', 'plugin']) {
        out.pinned[facet] = { ...(raw?.pinned?.[facet] ?? {}) }
        out.session[facet] = { ...(raw?.session?.[facet] ?? {}) }
        const axis = facet === 'skill' ? 'skills' : 'plugins'
        const next = {}
        for (const [name, entry] of Object.entries(raw?.compositions?.[facet] ?? {})) {
          const arr = entry === null || entry === undefined ? null : entry[axis]
          next[name] = facet === 'skill'
            ? { skills: Array.isArray(arr) ? [...arr] : [] }
            : { plugins: Array.isArray(arr) ? [...arr] : [] }
        }
        out.compositions[facet] = next
      }
      return out
    }

    // 插件 ↔ 工具 归属（客户端也做一遍，改完刷新就能看到真实工具数）
    //
    // DSH 的 tools 注册表**不带归属**，所以只能按命名空间词推导。宿主那边也在做同一件事
    // （`lib/index.js` 的 namespacesOf / buildPluginCatalog），这里保持一致的口径，
    // 但多两种写法，省掉"api-client 底下 6 个工具一条都认不回来"这种漏：
    //   · 分词形式：api-client → api / client
    //   · 连写形式：api-client → api_client（这样 api_client_request 才对得上）
    //   · 少数对不上的（flakefinder → flaky_*）用别名表兜。
    const NS_NOISE = new Set(['dsh', 'tool', 'tools', 'plugin', 'plugins', 'ui', 'core', 'the', 'and'])
    const NS_ALIAS = {
      flakefinder: ['flaky'],
      'furongjun1999-dsh-memory': ['lingshu'],
      'skills-manager': ['create_skill'],
      'dsh-chat-import': ['import_chat'],
      'dsh-computer-use': ['app', 'screen'],
      'dsh-agent-teams': ['agent_teams'],
    }

    /** 一个插件可能的命名空间前缀。 */
    function namespaceWordsOf(id, pkg) {
      const out = []
      for (const raw of [id, pkg]) {
        const s = String(raw ?? '').toLowerCase()
        if (s === '') continue
        const joined = s.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
        if (joined.length >= 3) out.push(joined)
        // 去掉 `dsh_` 再来一份：`dsh_context_lens` → `context_lens`
        const bare = joined.replace(/^dsh_/, '')
        if (bare !== joined && bare.length >= 3) out.push(bare)
        for (const tok of s.split(/[^a-z0-9]+/)) {
          if (tok.length < 3 || NS_NOISE.has(tok) || /^\d+$/.test(tok)) continue
          out.push(tok)
        }
      }
      for (const a of NS_ALIAS[id] ?? []) out.push(a)
      return [...new Set(out)]
    }

    /**
     * 统计每个插件认领了多少工具。
     * 与宿主同一套规则：把「插件 × 命名空间词」摊平、**最长词优先**，一个工具只归一家。
     * @returns `{ counts: Map<插件id, 数>, claimed: Set<工具名小写> }`
     */
    function countToolsPerPlugin(plugins, toolNames) {
      const names = (Array.isArray(toolNames) ? toolNames : []).map((t) => String(t))
      const claims = []
      for (const p of plugins) {
        for (const w of namespaceWordsOf(p.id, p.pkg)) claims.push({ id: p.id, w })
      }
      claims.sort((a, b) => b.w.length - a.w.length || (a.id < b.id ? -1 : 1))
      const counts = new Map()
      const claimed = new Set()
      for (const name of names) {
        const lower = name.toLowerCase()
        for (const c of claims) {
          if (lower === c.w || lower.startsWith(c.w + '_') || lower.startsWith(c.w + '-')) {
            counts.set(c.id, (counts.get(c.id) ?? 0) + 1)
            claimed.add(name)
            break
          }
        }
      }
      return { counts, claimed }
    }

    // 设计令牌
    /**
     * `--dsw-alias-brand-primary` **不是品牌色，是「反色前景」** —— 永远不能当填充色用。
     *    宿主自己的令牌表（`@deepseek-ai/dsh-client-ui-theme`）写得很清楚：
     *      浅色：--dsw-alias-brand-primary = neutral-bluish-1000 = #0f1115（近黑）
     *      深色：--dsw-alias-brand-primary = neutral-bluish-50   = #f9fafb（近白）
     *    所以拿它做 background，浅色模式画出**黑块**、深色模式画出**白块** ——
     *    实测「切成深色后两个 UI 还有白色小方块」就是这个。
     *    （同一个坑还有 `--dsw-alias-button-primary-fill`，它 = brand-primary。）
     *
     *    真正能做填充的两个令牌（浅色 #4176e6 / 深色 #679efe，两种模式都是蓝）：
     *      --dsw-alias-button-info-fill       ← 首选（语义就是"信息态按钮填充"）
     *      --dsw-alias-state-business-primary ← 备选（业务态主色）
     *    填充上的文字用它们的设计搭档 --dsw-alias-label-primary-foreground
     *      （浅色 #fff / 深色 #0f1115 —— 深色模式下填充是浅蓝，深字才够对比）。
     */
    const C = {
      accent: 'var(--dsw-alias-button-info-fill, var(--dsw-alias-state-business-primary, #4d6bfe))',
      onAccent: 'var(--dsw-alias-label-primary-foreground, #fff)',
      danger: 'var(--dsw-alias-label-danger, #e5484d)',
      ok: 'var(--dsw-alias-label-success, #30a46c)',
      warn: 'var(--dsw-alias-label-warning, #d9822b)',
      border: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.30))',
      borderSoft: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.18))',
      soft: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.09))',
      softer: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.05))',
    }

    const S = {
      page: { display: 'flex', flexDirection: 'column', fontSize: '12px', lineHeight: 1.55, paddingBottom: '10px' },
      bar: {
        // 这里**不要** position:sticky —— 宿主的面板是个滚动容器，sticky 会让它
        //    浮在卡片上方，往下滑时和内容叠在一起（即"UI 重叠"现象）。
        display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: '10px', padding: '6px 0 10px',
        borderBottom: '1px solid ' + C.borderSoft, marginBottom: '12px',
      },
      card: { border: '1px solid ' + C.borderSoft, borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '2px' },
      title: { fontSize: '13px', fontWeight: 600 },
      sub: { fontSize: '11px', opacity: 0.6, lineHeight: 1.6, margin: '2px 0 10px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      kv: { display: 'grid', gridTemplateColumns: '52px 1fr', gap: '4px 10px', alignItems: 'baseline' },
      label: { fontSize: '11px', opacity: 0.55 },
      meta: { fontSize: '11px', opacity: 0.62 },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', opacity: 0.85, wordBreak: 'break-all' },
      input: {
        fontSize: '12px', padding: '4px 8px', border: '1px solid ' + C.border,
        borderRadius: '6px', background: 'transparent', color: 'inherit', minWidth: 0,
      },
      select: {
        fontSize: '12px', padding: '3px 6px', border: '1px solid ' + C.border,
        borderRadius: '6px', background: 'transparent', color: 'inherit', maxWidth: '190px',
      },
      btn: {
        fontSize: '12px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid ' + C.border, background: 'transparent', color: 'inherit', whiteSpace: 'nowrap',
      },
      btnPrimary: {
        fontSize: '12px', padding: '4px 12px', borderRadius: '6px', cursor: 'pointer',
        border: '1px solid transparent', background: C.accent, color: C.onAccent, fontWeight: 500, whiteSpace: 'nowrap',
      },
      btnDanger: { color: C.danger, borderColor: C.danger },
      chip: {
        display: 'inline-flex', alignItems: 'baseline', gap: '6px', fontSize: '12px',
        padding: '4px 11px', borderRadius: '999px', border: '1px solid ' + C.border,
        cursor: 'pointer', background: 'transparent', color: 'inherit',
      },
      chipOn: { background: C.accent, borderColor: 'transparent', color: C.onAccent, fontWeight: 500 },
      pick: {
        display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '5px 8px',
        borderRadius: '6px', marginBottom: '2px', cursor: 'pointer',
      },
      pickOn: { background: C.softer },
      pickOff: { opacity: 0.45, cursor: 'not-allowed' },
      /**
       * 「体验插件」标记：一个字「体」。
       * 含义：这个插件不向 agent 注册任何工具，纯界面 / 交互用途。
       * 视觉：**故意做得很轻** —— 只有很淡的底和一圈浅边，字号/颜色都和旁边的灰字一个量级，
       *       起的是"扫一眼能分辨"的作用，不是抢眼。想细看就悬停。
       */
      badgeUi: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: '14px', padding: '0 4px', borderRadius: '4px',
        border: '1px solid ' + C.borderSoft, background: C.soft,
        color: 'inherit', opacity: 0.62,
        fontSize: '10px', lineHeight: '14px', fontWeight: 400,
        flex: '0 0 auto', userSelect: 'none',
      },
      /** 「未识别」：包读不到 ⇒ 不下结论。虚线浅框，绝不冒充"体验插件"。 */
      badgeUnknown: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: '17px', height: '17px', borderRadius: '6px',
        border: '1px dashed ' + C.border, color: 'inherit', opacity: 0.45,
        fontSize: '11px', lineHeight: '15px', flex: '0 0 auto', userSelect: 'none',
      },
      tag: { fontSize: '10px', padding: '1px 5px', borderRadius: '4px', background: C.soft, opacity: 0.9 },
      badgeCur: { fontSize: '10px', padding: '1px 6px', borderRadius: '999px', background: C.accent, color: C.onAccent, whiteSpace: 'nowrap' },
      line: {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px',
        borderRadius: '6px', borderBottom: '1px solid ' + C.borderSoft,
      },
      lineCur: { background: C.softer },
      lineMain: { flex: '1 1 auto', minWidth: 0 },
      lineTitle: { fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      scroller: { maxHeight: '320px', overflow: 'auto', marginTop: '6px', paddingRight: '2px' },
      empty: { fontSize: '12px', padding: '14px 12px', borderRadius: '8px', border: '1px dashed ' + C.border, textAlign: 'center', opacity: 0.75 },
      err: { fontSize: '12px', color: C.danger, whiteSpace: 'pre-wrap' },
      ok: { fontSize: '11px', color: C.ok },
      warnBox: {
        fontSize: '11px', lineHeight: 1.6, padding: '7px 9px', borderRadius: '6px',
        border: '1px solid ' + C.border, background: C.softer, marginBottom: '8px',
      },
      hint: { fontSize: '11px', opacity: 0.6, lineHeight: 1.65 },
      group: { fontSize: '11px', opacity: 0.5, padding: '6px 8px 2px' },
    }

    /* 宿主主题下的原生控件 + 浮层
     *
     * 为什么需要这一段（反馈：「为什么变白了要修复！」「白色小方块
     * 有很多很多」）：
     *   · `<input type=checkbox>` 是**原生控件**，宿主没给 color-scheme，Chromium
     *     就按浅色画 —— 在暗色面板上一堆 13px 的**白方块**。实测：appearance:auto、
     *     13×13、bg 透明、color rgb(255,255,255)。所以自己画（appearance:none）。
     *   · 展开的选组合列表原来是**就地展开**在行里（flex 列），于是行被撑高、
     *     右边留一大片空档，还会被面板的 overflow:hidden 裁掉。现在改成浮层：
     *     贴着手柄按钮，按剩余空间决定**往下开还是往上开**，横向也夹在视口里。
     */
    const CC_CSS = [
      /* 选择器必须写成 `input[type="checkbox"].dcc-cb`：宿主自己也有一条
         `input[type=checkbox]` 之类的规则（特异性 0,1,1 高于单个类名 0,1,0），
         只写 `.dcc-cb` 的话 appearance 生效、background 却被宿主的白底盖掉 ——
         实测就是这么"修了还是白的"。这里用 0,2,1 稳稳压过它。
         背景/边框还必须带 `!important`：实测宿主有**同特异性但更靠后**的规则
         （样式表是动态注入的，顺序不由本插件决定），不加就还是画成白底
         （量到的 computed background = rgb(249, 250, 251)）。 */
      'input[type="checkbox"].dcc-cb{-webkit-appearance:none;appearance:none;box-sizing:border-box;',
      'width:14px;height:14px;margin:0;flex:0 0 auto;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45)) !important;',
      'border-radius:4px;background:transparent !important;cursor:pointer;position:relative;',
      'transition:background .12s,border-color .12s}',
      'input[type="checkbox"].dcc-cb:hover{border-color:var(--dsw-alias-button-info-fill,#4d6bfe) !important}',
      /* 勾选后的填充色**不能用** `var(--dsw-alias-brand-primary)`：
         实测在这个设置面板里它被解析成了前景色 #f9fafb（宿主的 quiet 主题重定义了
         这个变量）⇒ 勾上的框全变成**白色小方块**，正是实际观察到的那个现象。
         量到的 computed background 就是 rgb(249, 250, 251)。**令牌表原文**：
         brand-primary = 浅色 neutral-bluish-1000(#0f1115) / 深色 neutral-bluish-50(#f9fafb)
         —— 它是"反色前景"，任何时候都不能当填充。填充改用 button-info-fill
         （浅 #4176e6 / 深 #679efe，两种模式都是蓝）+ label-primary-foreground 当字色。 */
      'input[type="checkbox"].dcc-cb:checked{background:var(--dsw-alias-button-info-fill,#4d6bfe) !important;border-color:transparent !important}',
      'input[type="checkbox"].dcc-cb:checked::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;',
      'border:solid var(--dsw-alias-label-primary-foreground,#fff);border-width:0 2px 2px 0;transform:rotate(45deg)}',
      'input[type="checkbox"].dcc-cb:disabled{opacity:.35;cursor:not-allowed}',
      'input[type="checkbox"].dcc-cb:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}',
      /* box-sizing:border-box 很关键：maxHeight 是**含 padding+border** 的总高，
         否则浮层实际高度比算出来的多 18px，贴边时会越界几个像素。 */
      /**
       * 反馈：「它的按钮和这个字重叠了，它应该固定在最底下，
       * 不管我怎么滑动它都死在这个位置，同时不与字重叠（字的滚动范围不在它的范围之内）」。
       *
       * 病根：底部按钮行原来只是 `position:sticky;bottom:0`，**没有背景**，
       * 于是文字从它下面穿过去，看着就是"按钮压在字上"。
       * 现在浮层改成 flex 纵列：里面单独一个**滚动区**（.dcc-pop-body），
       * 按钮行是**不滚的页脚**（.dcc-pop-foot）—— 字永远在页脚以上滚，不会再重叠。
       */
      '.dcc-pop{box-sizing:border-box;position:fixed;z-index:2147483000;border-radius:10px;padding:8px;overflow:hidden;',
      'display:flex;flex-direction:column;',
      'overscroll-behavior:contain;box-shadow:0 14px 34px rgba(0,0,0,.34)}',
      '.dcc-pop-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}',
      '.dcc-pop-foot{flex:0 0 auto;display:flex;gap:6px;margin-top:6px;padding-top:6px;',
      'border-top:1px solid var(--dsw-alias-border-l2);position:relative;z-index:1}',
      '.dcc-pop-row{display:flex;gap:8px;align-items:center;font-size:12px;padding:3px 4px;',
      'border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.dcc-pop-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16))}',
    ].join('')

    function ensureComposerStyle () {
      try {
        if (typeof document === 'undefined' || document.getElementById('dcc-style') !== null) return
        const el = document.createElement('style')
        el.id = 'dcc-style'
        el.textContent = CC_CSS
        document.head.appendChild(el)
      } catch { /* 样式挂不上也不该让面板崩 */ }
    }

    /** 往上找一个**不透明**的背景色当浮层底色：宿主明暗主题都不用猜。 */
    function surfaceBackground (node) {
      try {
        let cursor = node
        for (let i = 0; i < 30 && cursor !== null && cursor !== undefined; i += 1) {
          const bg = window.getComputedStyle(cursor).backgroundColor
          if (typeof bg === 'string' && bg !== '' && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') return bg
          cursor = cursor.parentElement
        }
      } catch { /* 读不到就用兜底色 */ }
      return 'var(--dsw-alias-bg-layer-1, #1c1c1f)'
    }

    /**
     * 浮层几何：贴着手柄按钮，**优先往下开**；下面放不下就往上开。
     * 横向和纵向都夹在视口里（"不要超出界面边框，不然不好选择"）。
     */
    function popGeometry (anchorRect, preferredWidth, preferredHeight) {
      const margin = 8
      const vw = typeof window === 'undefined' || !window.innerWidth ? 1024 : window.innerWidth
      const vh = typeof window === 'undefined' || !window.innerHeight ? 768 : window.innerHeight
      const width = Math.max(200, Math.min(preferredWidth, vw - margin * 2))
      const left = Math.max(margin, Math.min(anchorRect.left, vw - width - margin))
      const below = vh - anchorRect.bottom - margin - 4
      const above = anchorRect.top - margin - 4
      const down = below >= 150 ? true : (above >= 150 ? false : below >= above)
      const maxHeight = Math.max(110, Math.min(preferredHeight, down ? below : above))
      /* 最后**必须再夹一次**：手柄那一行本身可能在视口外（面板很长、刚滚动过，
         实测 anchor.top=1382 而视口只有 1070），这时 "往上开" 算出来的 top 会跑到
         1070 以下 ⇒ 浮层整个落在屏幕外。夹一次保证 bottom ≤ vh − margin。 */
      const topRaw = down ? anchorRect.bottom + 4 : anchorRect.top - 4 - maxHeight
      const top = Math.max(margin, Math.min(topRaw, vh - margin - maxHeight))
      return {
        left: Math.round(left), top: Math.round(top), width: Math.round(width),
        maxHeight: Math.round(maxHeight), down: down,
      }
    }

    function Empty(props) {      return jsxs('div', { style: S.empty, children: [
        jsx('div', { children: props.text }),
        props.action
          ? jsx('button', { style: { ...S.btn, marginTop: '8px' }, onClick: props.onAction, children: props.action })
          : null,
      ] })
    }

    /**
     * 选组合的控件（**可多选**）。空 = 该级没指定 ⇒ 继承上一级。
     *
     * 多选语义 = **并集**：同一级里选了几套，几套一起生效（技能/插件取并集）。
     * 为什么做成"按钮 + 弹出来的勾选列表"而不是 `<select multiple>`：
     *   · `<select multiple>` 要按住 Ctrl 才多选，没人会想到；
     *   · 这里还要显示"当前选了几套"，按钮上的文字一眼就能看到。
     * 后来改成**浮层**（原来是就地展开）：
     *   · 就地展开会把行撑高、右边留一大片空档（"中间有空档一起打开，有点夸张"）；
     *   · 列表还会被面板的 overflow:hidden 裁掉。
     *   现在按按钮上下剩余空间决定开合方向，横向纵向都夹在视口里。
     *   浮层虽然 position:fixed，但**仍留在本组件的 DOM 子树里**（没上 portal），
     *   这样宿主重挂时的相对关系不变；Settings 祖先链实测没有 transform/filter，
     *   fixed 就是相对视口定位的。
     */
    function PickCompose(props) {
      const values = Array.isArray(props.values) ? props.values : []
      /**
       * 展开状态必须用 `useKeep`（组件重挂也不丢），**不能**用普通 useState。
       *
       * 宿主会周期性重挂设置面板；用 useState 的话，勾了第一项 → 保存 →
       * 面板重挂 → 浮层自己关掉，想再勾第二项还得重新点开（多选直接不好用了）。
       * 这是会话级绑定那条自检反复假失败的根因。
       */
      const [open, setOpen] = useKeep('pick:' + String(props.popKey ?? 'default'), false)
      const [box, setBox] = useState(null)
      const btnRef = useRef(null)
      const popRef = useRef(null)
      const label = values.length === 0 ? (props.inheritLabel ?? t('pick.inherit')) : values.join('  +  ')
      const toggle = (n) => {
        const next = values.includes(n) ? values.filter((x) => x !== n) : [...values, n]
        // 兼容：**只选 1 套时仍旧发字符串**（旧宿主只认字符串），只有真的多选才发数组。
        //    这样"多选"这个新能力在宿主重启前，单选照常能存。
        props.onChange(next.length === 0 ? null : next.length === 1 ? next[0] : next)
      }

      const place = useCallback(() => {
        const el = btnRef.current
        if (el === null || el === undefined || typeof el.getBoundingClientRect !== 'function') return
        const rect = el.getBoundingClientRect()
        const geo = popGeometry(rect, 300, 280)
        geo.bg = surfaceBackground(el)
        /* 只有几何**真的变了**才 setState。滚动监听是 capture 的，面板自己滚动、
           宿主插入内容都会触发；每来一次就 setState 会和"重渲染引起的滚动"互相喂，
           变成刷屏级重渲染（K1/K2 的按键就在这时被吞掉）。 */
        setBox((prev) => (prev !== null && prev.left === geo.left && prev.top === geo.top
          && prev.width === geo.width && prev.maxHeight === geo.maxHeight && prev.bg === geo.bg
          ? prev
          : geo))
      }, [])

      useEffect(() => {
        ensureComposerStyle()
        if (open) place()
        else setBox(null)
        return undefined
      }, [open, place])

      useEffect(() => {
        if (!open) return undefined
        const follow = () => place()
        /* 面板本身是滚动容器 —— 滚动/改窗口大小时浮层要么跟着走，要么关掉。
           跟着走更不打断操作（capture 才能收到面板内部的滚动）。 */
        window.addEventListener('resize', follow)
        window.addEventListener('scroll', follow, true)
        const onDown = (event) => {
          const target = event.target
          if (btnRef.current !== null && btnRef.current.contains(target)) return
          if (popRef.current !== null && popRef.current.contains(target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => {
          window.removeEventListener('resize', follow)
          window.removeEventListener('scroll', follow, true)
          document.removeEventListener('mousedown', onDown, true)
        }
      }, [open, place])

      const popKey = String(props.popKey ?? 'default')
      const pop = open && box !== null
        ? jsxs('div', {
            ref: popRef,
            className: 'dcc-pop',
            /* 浮层与它的 ▾ 按钮共用同一个 key：这样"这张浮层属于哪一行"是可判定的
               （一行一个浮层，同时可能有好几张开着；测试与无障碍都靠它对上号）。 */
            'data-dcc-pop': popKey,
            style: {
              left: box.left + 'px', top: box.top + 'px', width: box.width + 'px',
              maxHeight: box.maxHeight + 'px', background: box.bg,
              border: '1px solid ' + C.border, color: 'inherit',
            },
            children: [
              /* 滚动区：标题 + 组合列表都在这层滚。 */
              jsxs('div', { className: 'dcc-pop-body', children: [
                jsx('div', { style: { ...S.meta, marginBottom: '4px' }, children: t('pick.multiHint') }),
                props.names.length === 0
                  ? jsx('div', { style: S.meta, children: t('comp.empty') })
                  : jsx('div', { children: props.names.map((n) => jsxs('label', {
                      key: n,
                      className: 'dcc-pop-row',
                      children: [
                        jsx('input', { type: 'checkbox', className: 'dcc-cb', checked: values.includes(n), onChange: () => toggle(n) }),
                        jsx('span', { children: n }),
                      ],
                    })) }),
              ] }),
              /* 页脚：**不参与滚动**，所以永远不会和上面的字重叠。 */
              jsxs('div', { className: 'dcc-pop-foot', children: [
                jsx('button', { style: S.btn, onClick: () => { props.onChange(null); setOpen(false) }, children: t('pick.clear') }),
                jsx('button', { style: S.btn, onClick: () => setOpen(false), children: t('btn.collapse') }),
              ] }),
            ],
          })
        : null

      return jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', alignItems: 'flex-start' }, children: [
        jsxs('button', {
          ref: btnRef,
          style: {
            ...S.btn, textAlign: 'left', maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', display: 'block',
            ...(values.length > 1 ? { borderColor: C.accent, fontWeight: 600 } : {}),
          },
          disabled: props.disabled === true,
          title: t('pick.titleHint'),
          'aria-expanded': open,
          'data-dcc-key': popKey,
          onClick: () => setOpen(!open),
          children: [
            jsx('span', { children: (values.length === 0 ? '' : values.length === 1 ? '☑ ' : '☑' + String(values.length) + ' ') + label + ' ▾' }),
          ],
        }),
        pop,
      ] })
    }

    /**
     * 成员勾选器（技能 / 插件共用）。
     *
     * **永远列全部**：空名单 = 不过滤 = 全部已勾。
     * 取消任意一项 ⇒ 自动落成显式白名单（"除了它都可见"）。
     * 找不到的成员（被卸载 / 改名）单独提示，可一键清掉。
     */
    function MemberPicker(props) {
      const { universe, isSkill, members, onSet, query, setQuery, view, setView, notSelectable } = props
      /* 原生勾选框在暗色面板上会被画成白方块 —— 样式表在这里挂一次。 */
      useEffect(() => { ensureComposerStyle() }, [])
      const ids = useMemo(() => universe.map((it) => it.id), [universe])
      const idSet = useMemo(() => new Set(ids), [ids])
      // 三种状态：不过滤（空数组 = 全部）· 全不选（只有哨兵 CC_NONE）· 白名单（显式名单）
      const isNone = members.length === 1 && members[0] === CC_NONE
      const noFilter = members.length === 0
      const realMembers = useMemo(() => (isNone ? [] : members), [members, isNone])
      const selected = useMemo(() => new Set(realMembers), [realMembers])
      const q = query.trim().toLowerCase()
      const items = q === ''
        ? universe
        : universe.filter((it) => String(it.id).toLowerCase().includes(q)
          || String(it.name).toLowerCase().includes(q)
          || String(it.description ?? '').toLowerCase().includes(q)
          || (it.keywords ?? []).some((k) => String(k).toLowerCase().includes(q)))
      const stale = realMembers.filter((id) => !idSet.has(id))
      const picked = realMembers.filter((id) => idSet.has(id)).length
      const onCount = noFilter ? universe.length : picked
      // 三态筛选：全部 / 只看已选 / 只看没选
      const shown = items.filter((it) => {
        if (view === 'all') return true
        const on = noFilter || selected.has(it.id)
        return view === 'on' ? on : !on
      })

      const toggle = (id) => {
        if (noFilter) onSet(ids.filter((x) => x !== id))          // 不过滤 → 白名单：勾掉这一个
        else if (isNone) onSet([id])                              // 全不选 → 从这一个开始挑
        else if (selected.has(id)) onSet(realMembers.filter((x) => x !== id))
        /* 加成员时**顺手去重**：名单可能是从别处（旧状态文件 / 脚本）带进来的重复项，
           不去重的话每点一次就多一条。 */
        else onSet([...new Set([...realMembers, id])])
      }

      const bulk = (label, onClick, disabled) => jsx('button', {
        style: { ...S.btn, padding: '2px 9px', fontSize: '11px', opacity: disabled ? 0.45 : 1 },
        disabled: disabled,
        onClick: onClick,
        children: label,
      })

      const viewBtn = (key, label, n) => jsx('button', {
        key: key,
        style: {
          fontSize: '11px', padding: '2px 8px', cursor: 'pointer', whiteSpace: 'nowrap',
          border: '1px solid ' + C.border, background: view === key ? C.accent : 'transparent',
          color: view === key ? '#fff' : 'inherit',
          borderRadius: key === 'all' ? '6px 0 0 6px' : key === 'off' ? '0 6px 6px 0' : '0',
          borderLeftWidth: key === 'all' ? '1px' : '0',
        },
        onClick: () => setView(key),
        children: label + ' ' + String(n),
      })

      return jsxs('div', { children: [
        jsxs('div', { style: { ...S.row, marginBottom: '4px' }, children: [
          jsx('input', {
            style: { ...S.input, flex: '1 1 150px' },
            placeholder: isSkill ? t('search.skill') : t('search.plugin'),
            value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
          jsxs('div', { style: { display: 'flex' }, children: [
            viewBtn('all', t('view.all'), universe.length),
            viewBtn('on', t('view.on'), onCount),
            viewBtn('off', t('view.off'), universe.length - onCount),
          ] }),
          bulk(t('btn.selectAll'), () => onSet([]), noFilter),
          bulk(t('btn.selectNone'), () => onSet([CC_NONE]), isNone),
        ] }),
        jsx('div', { style: { ...S.meta, marginBottom: '4px' }, children: noFilter
          ? t('hint.noFilter', { n: universe.length, unit: isSkill ? t('unit.skill') : t('unit.plugin') })
          : isNone
            ? t('hint.none', { reason: isSkill ? t('hint.none.skill') : t('hint.none.plugin') })
            : t('hint.allowlist', { n: picked }) }),

        stale.length > 0
          ? jsxs('div', { style: S.warnBox, children: [
              jsxs('div', { children: [
                t('warn.stale', { n: stale.length }),
              ] }),
              jsx('div', { style: { ...S.mono, marginTop: '2px' }, children: stale.join(t('sep.enum')) }),
              jsx('button', { style: { ...S.btn, marginTop: '6px' }, onClick: () => onSet(realMembers.filter((id) => idSet.has(id))), children: t('btn.pruneStale') }),
            ] })
          : null,

        jsxs('div', { style: S.scroller, children: [
          shown.length === 0
            ? jsx('div', { style: { ...S.meta, padding: '10px 4px' }, children: q !== ''
                ? t('list.noMatch')
                : view === 'off'
                  ? (noFilter ? t('list.notMissing') : t('list.noneOff'))
                  : view === 'on' ? t('list.noneOn') : t('list.empty') })
            : null,
          ...shown.map((it) => {
            const on = noFilter || selected.has(it.id)
            return jsxs('label', {
              key: it.id,
              style: { ...S.pick, ...(on ? S.pickOn : {}) },
              title: it.pkg === undefined ? it.id : it.pkg,
              children: [
              jsx('input', { type: 'checkbox', className: 'dcc-cb', checked: on, onChange: () => toggle(it.id), style: { marginTop: '2px' } }),
              jsxs('div', { style: { flex: '1 1 auto', minWidth: 0 }, children: [
                jsxs('div', { style: S.row, children: [
                  jsx('span', { style: { fontSize: '12.5px', fontWeight: 500 }, children: it.name }),
                  it.name === it.id ? null : jsx('span', { style: S.meta, children: it.id }),
                  isSkill
                    ? null
                    : (it.uiOnly === true
                        // 有颜色的一个字：这是「体验插件」，agent 调不到它，纯界面用途
                        ? jsx('span', {
                            style: S.badgeUi,
                            title: t('badge.uiOnly.tip'),
                            children: t('badge.uiOnly'),
                          })
                        : it.scanCertain === false
                          ? jsx('span', {
                              style: S.badgeUnknown,
                              title: t('badge.unknown.tip'),
                              children: '?',
                            })
                          : (it.toolCount > 0
                              // 只显示**确切的**数量；数不出来就一个字都不说，绝不写"未知"。
                              ? jsx('span', { style: S.meta, title: t('tools.list.tip') + (it.toolNames ?? []).join('\n'), children: t('tools.count', { n: it.toolCount }) })
                              : null)),
                ] }),
                (it.id === 'unassigned'
                  ? t('unassigned.desc')
                  : it.description) === ''
                  ? null
                  : jsx('div', {
                      style: { ...S.meta, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      children: it.id === 'unassigned'
                        ? t('unassigned.desc')
                        : it.description,
                    }),
                (it.keywords ?? []).length > 0
                  ? jsxs('div', { style: { ...S.row, gap: '4px', marginTop: '3px' }, children: it.keywords.slice(0, 6).map((k) => jsx('span', { key: k, style: S.tag, children: k })) })
                  : null,
              ] }),
            ] })
          }),

          // 不可选的那些（没启用的插件 / 已停用的技能）：灰着列在尾巴上，勾不了
          notSelectable.length === 0 ? null : jsxs('div', { style: { marginTop: '8px', borderTop: '1px dashed ' + C.borderSoft, paddingTop: '6px' }, children: [
            jsx('div', { style: { ...S.meta, marginBottom: '2px' }, children: isSkill
              ? t('disabled.skill', { n: notSelectable.length })
              : t('disabled.plugin', { n: notSelectable.length }) }),
            ...notSelectable.map((it) => jsxs('div', {
              key: 'off:' + it.id,
              style: { ...S.pick, ...S.pickOff },
              title: it.pkg === undefined ? it.id : it.pkg,
              children: [
                jsx('input', { type: 'checkbox', className: 'dcc-cb', checked: false, disabled: true, style: { marginTop: '2px' } }),
                jsxs('div', { style: { flex: '1 1 auto', minWidth: 0 }, children: [
                  jsxs('div', { style: S.row, children: [
                    jsx('span', { style: { fontSize: '12.5px', fontWeight: 500 }, children: it.name }),
                    it.name === it.id ? null : jsx('span', { style: S.meta, children: it.id }),
                  ] }),
                ] }),
              ],
            })),
          ] }),
        ] }),
      ] })
    }

    /** 一行作用域（全局 / 工作区 / 会话）—— 「用哪套组合」。 */
    function LevelRow(props) {
      const { title, detail, isCur, value, names, inheritLabel, onPick, indent, levelKey } = props
      return jsxs('div', {
        style: { ...S.line, ...(isCur ? S.lineCur : {}), paddingLeft: indent === true ? '22px' : '8px' },
        children: [
        jsxs('div', { style: S.lineMain, children: [
          jsxs('div', { style: { ...S.row, gap: '6px' }, children: [
            jsx('span', { style: { ...S.lineTitle, flex: '0 1 auto' }, title: detail ?? title, children: title }),
            isCur ? jsx('span', { style: S.badgeCur, children: t('badge.current') }) : null,
          ] }),
          detail === undefined || detail === '' ? null : jsx('div', { style: S.mono, children: detail }),
        ] }),
        jsx(PickCompose, { popKey: 'level:' + String(levelKey ?? title), values: value, names, inheritLabel, onChange: onPick }),
      ] })
    }

    /** 两个界面共用的壳 —— 按 `facet` 只画自己那一轴。 */
    function Composer(props) {
      const facet = props.facet === 'plugin' ? 'plugin' : 'skill'
      const isSkill = facet === 'skill'
      /* Language change -> re-render this subtree (see useCopy). */
      useCopy()
      const unit = isSkill ? t('unit.skill') : t('unit.plugin')
      /* EN capitalises at sentence/heading start: 'Plugin composition'. */
      const unitCap = isSkill ? t('unit.skill.cap') : t('unit.plugin.cap')
      const axis = isSkill ? 'skills' : 'plugins'
      // `K` 必须是**稳定**的 —— 它一抖，`load` 就抖，`useEffect([load])` 就会无限重拉。
      const prefix = 'composer:' + facet + ':'
      const K = useCallback((name) => prefix + name, [prefix])

      const wsSnap = useHostSnapshot('workspaces')
      const seSnap = useHostSnapshot('sessions')

      /**
       * 缓存优先（反馈「显示正在加载/正在读取，要过一会才好」）。
       *
       * 面板以前整块等 `/state` 这个宿主 RPC：`data === null` 就只画「正在读取…」，
       * 而 DSH 刚启动时宿主在装配插件（实测几十秒），于是三个界面一起转圈。
       * 现在把上次的结果**持久化缓存**一份，冷开先用它画（`useState(() => stateCache)`），
       * 网络回来再刷新 —— 面板立刻可用，且不会显示过期数据以外的东西。
       */
      const [stateCache, setStateCacheRef] = useCached(K('stateCache'), null)
      const [data, setData] = useState(() => stateCache)
      /* 技能清单也吃同一份"跨重启缓存"：否则冷启动第一帧里 `<available_skills>` 那份
         组合可选清单是空的（面板画得出来，但技能那一栏是 0 个）。它随后总会被会话级
         清单覆盖，所以缓存只是"第一帧不空白"。 */
      const [skillInfo, setSkillInfo] = useState(() => {
        const cached = lsRead(SKILL_CACHE_KEY)
        const list = Array.isArray(cached?.list) ? cached.list : []
        return { list, source: list.length > 0 ? 'cache' : 'loading', at: Number(cached?.at) || 0, error: '' }
      })
      const [reloadedAt, setReloadedAt] = useState(0)
      const [draft, setDraft] = useKeep(K('draft'), null)
      const [saved, setSaved] = useKeep(K('saved'), null)
      const [active, setActive] = useKeep(K('active'), null)
      const [openWs, setOpenWs] = useKeep(K('openWs'), null)
      const [query, setQuery] = useKeep(K('query'), '')
      const [view, setView] = useKeep(K('view'), 'all')
      // 这两个是**用户正在输入的内容**，必须放 PERSIST：
      //   宿主会周期性重挂设置面板，放 useState 里会出现「刚点开新建、输入框就没了 / 打字打不进去」。
      const [newName, setNewName] = useKeep(K('newName'), null)
      /**
       * 「系列」——把组合按用途分家。
       *
       * 数据模型**不加字段**：系列就是组合名里 `·` 之前那一段（`开发·日常` → 系列「开发」），
       * 名字里没有 `·` 的归到「不分组」。这样：
       *   · host 状态文件格式完全不用动（跨版本、跨电脑都安全）；
       *   · "自定义系列" = 建组合时选/填一个系列名，或直接把名字改成 `我的系列·名字`；
       *   · 组里的组合还是普通组合，改名/删除/绑定全都照旧。
       */
      const [newSeries, setNewSeries] = useKeep(K('newSeries'), '')
      const [seriesDraft, setSeriesDraft] = useKeep(K('seriesDraft'), '')
      /**
       * 正在改名的**系列**（null = 没在改）+ 输入框里的新系列名。
       *
       * 为什么需要单独一个状态：系列是一组组合的**共同前缀**，改系列名 = 一次改一整组
       * （`开发·日常 → 研发·日常`），光靠单个组合的「改名」得改 8 次、还会漏掉引用。
       */
      const [seriesRenaming, setSeriesRenaming] = useKeep(K('seriesRenaming'), null)
      const [seriesRenameDraft, setSeriesRenameDraft] = useKeep(K('seriesRenameDraft'), '')
      /**
       * 正在确认删除的系列（null = 没在确认）。
       *
       * 为什么单独一个状态、还要红字：**删系列 = 一次删掉一整组组合**（开发系列就是 8 个），
       * 比删单个组合危险得多。所以点「删系列」先就地摊开一块红字警示，写清"要删哪几个"，
       * 再点「确认删除」才真的动。`window.confirm` 在设置面板里不好看也不够显眼。
       */
      const [seriesDeleting, setSeriesDeleting] = useKeep(K('seriesDeleting'), null)
      /**
       * 长按拖动排序（芯片 / 整个系列）。
       *
       * 顺序**不新增字段**：JS 对象保留字符串键的插入顺序，而状态文件是 JSON，host 的
       * `sanitizeStateInput` 与 client 的 `normalizeState` 都是**按插入顺序重建**的 ⇒
       * 「键的顺序 = 显示顺序」。拖完只要把 compositions 的键按新顺序重写一遍就落盘了。
       *
       * 为什么不用原生 HTML5 拖放：`draggable` 是在 **pointerdown 那一刻**决定这次手势能不能拖的，
       * 而本实现要求"**长按** ~180ms 之后才能拖"——按住之后再把它设成 draggable 已经晚了
       * （浏览器不会为这次手势起拖）。所以自己用 pointermove + elementFromPoint 实现。
       */
      const [dragName, setDragName] = useState(null)
      const [dragSeries, setDragSeries] = useState(null)
      const [previewOrder, setPreviewOrder] = useState(null)
      const dragRef = useRef({ name: null, kind: null, active: false, x: 0, y: 0, timer: null, preview: null, onMove: null, onUp: null })
      const [renaming, setRenaming] = useKeep(K('renaming'), null)
      const [error, setError] = useState('')
      const [saveError, setSaveError] = useState('')
      const [status, setStatus] = useState('idle')
      const [reloadAt, setReloadAt] = useState(0)

      const load = useCallback(async () => {
        setError('')
        try {
          /* GET 加超时 + 有限重试。宿主启动期连接会挂住不返回，
             原来的裸 fetch 遇到那种情况就是"永远正在读取"（见 fetchJsonWithRetry）。 */
          const body = await fetchJsonWithRetry(CC_API + '/state', STATE_LOAD_TRIES, STATE_LOAD_TIMEOUT_MS)
          const next = normalizeState(body.state ?? {})
          setData(body)
          /* 把这次拿到的 `/state` 也缓存一份。
             反馈「界面显示正在加载/正在读取，要过一会才好」——根因是面板
             **整块等这个 RPC**（下面 `data === null` 就只画「正在读取…」），
             而 DSH 刚启动时宿主忙着装配插件，这个 RPC 会排在后面。
             这份缓存同时写进 localStorage ⇒ 重启后第一帧也有东西可画
             （原来只存在内存里，页面一刷新就空了）。 */
          setStateCacheRef(body)
          STATE_FETCH_STAMP.at = Date.now()
          const localDraft = PERSIST[K('draft')]
          const localSaved = PERSIST[K('saved')]
          const dirty = localDraft !== null && localDraft !== undefined
            && localSaved !== null && localSaved !== undefined
            && JSON.stringify(localDraft) !== JSON.stringify(localSaved)
          if (!dirty) {
            setDraft(clone(next))
            setSaved(clone(next))
          }
          setActive((prev) => (prev !== null && next.compositions[facet][prev] !== undefined
            ? prev
            : Object.keys(next.compositions[facet])[0] ?? null))
          setStatus('idle')
        } catch (e) {
          setError(String(e?.message ?? e))
        }
      }, [facet, setDraft, setSaved, setActive, K])

      useEffect(() => {
        /* 宿主周期性重挂面板 ⇒ 5 秒内已经拿过一次就不重复打（即"一直刷新"现象）。
           节流**绝不能把"手里没数据"的面板一起挡掉**。原判据只有下面
           那个 fresh，于是：技能页刚拿到 /state（stamp 置位），5 秒内再挂载的插件页
           因为自己没有缓存而 `data === null`，却被告知"刚拿过，不用拿"⇒ 永远停在
           「正在读取…」，直到某次重挂超过 5 秒才自己好 —— 正是反馈的现象
           「点开要等很久，退出等一会再点开才正常」。没数据就永远去拿。 */
        const fresh = reloadAt === 0 && STATE_FETCH_STAMP.at > 0 && Date.now() - STATE_FETCH_STAMP.at < 5000
        const haveData = data !== null && data !== undefined && draft !== null && draft !== undefined
        if (!fresh || !haveData) void load()
      }, [load, reloadAt])

      /**
       * 「新组合的名字」输入框：只要它是开着的，就保证**光标在里面**。
       *
       * 为什么不能只靠 `autoFocus`：宿主会把设置面板整块重挂，重挂出来的新 input
       * 在有的分支下拿不到焦点 ⇒ 点上去也没光标、打不了字。这里每次 `newName`
       * 变化（含重挂后从 PERSIST 恢复）都补一次 focus。
       */
      const newNameRef = useRef(null)
      useEffect(() => {
        if (newName === null) return
        const el = newNameRef.current
        if (el === null || el === undefined) return
        if (document.activeElement !== el) {
          try { el.focus() } catch { /* 忽略 */ }
        }
      }, [newName])

      /** 「改名」输入框同理：重挂后必须把光标补回来。 */
      const renameRef = useRef(null)
      useEffect(() => {
        if (renaming === null) return
        const el = renameRef.current
        if (el === null || el === undefined) return
        if (document.activeElement !== el) {
          try { el.focus() } catch { /* 忽略 */ }
        }
      }, [renaming])

      // 技能清单**必须按会话来取**，见下面 derived 之后的那个 effect。
      //    这里原来只拉宿主 /skills（= 全局层，185 条），跟技能面板的真实清单对不上。

      const dirty = saved !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(saved)

      // 自动保存（防抖）
      useEffect(() => {
        if (!dirty || draft === null) return undefined
        setStatus('pending')
        const timer = setTimeout(async () => {
          setStatus('saving')
          try {
            /**
             * **读-改-写**：不能把本地草稿整个 POST 上去。
             *
             * 状态文件是一份、两个页面各管一轴（技能页 / 插件页）。如果直接 POST 本地草稿，
             * 那么"先在插件页改、再在技能页改"会把插件页那一改**整段抹掉**
             * （技能页的草稿是它加载时的旧快照）。
             * 所以：先拿服务器当前状态，只把**本轴的三块**（pinned / session / compositions）
             * 覆盖上去，再写回。
             */
            const freshRes = await fetchWithTimeout(`${CC_API}/state`, { headers: { accept: 'application/json' } }, STATE_SAVE_TIMEOUT_MS)
            const freshBody = await freshRes.json()
            if (!freshRes.ok) throw new Error(freshBody?.error ?? ('HTTP ' + String(freshRes.status)))
            const merged = normalizeState(freshBody.state ?? {})
            const sent = clone(draft)
            merged.pinned[facet] = sent.pinned[facet]
            merged.session[facet] = sent.session[facet]
            /**
             * 修复「组合被旧快照覆盖」—— 不许再写回整轴赋值！
             *
             * 症状：外部（脚本/手改/另一个页面）往状态文件里加了组合，界面上动一下就
             * 整批消失；`pinned` 也被打回旧值。
             *
             * 根因：`sent` 是本地草稿，来自 localStorage 里的旧快照。整轴赋值
             * （`merged.compositions[facet] = sent.compositions[facet]`）等于让"打开面板
             * 那一刻的旧世界"覆盖掉"服务器现在的世界" —— 这跟本函数开头防"另一轴被
             * 抹掉"是同一个 bug，只是换了个轴。
             *
             * 修法：**按组合名逐项合并** —— 以服务器为底，只覆盖本地草稿里**确实有**的
             * 那些名字。服务器上存在但本地快照里没有的组合会被保留（这正是本插件要的：
             * 外部新建的组合不该被界面误删）。
             *
             * 代价：本地删掉的组合会被服务器"复活"。这是**故意选的保守方向** ——
             * 删组合有二次确认，发现复活再删一次即可；而误删别人/脚本写的组合
             * 是不可逆的静默损失。宁可多按一次删除。
             */
            merged.compositions[facet] = {
              ...(merged.compositions[facet] ?? {}),
              ...(sent.compositions[facet] ?? {}),
            }

            const res = await fetchWithTimeout(`${CC_API}/state`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(merged),
            }, STATE_SAVE_TIMEOUT_MS)
            const body = await res.json()
            if (!res.ok) throw new Error(body?.error ?? ('HTTP ' + String(res.status)))
            setSaveError('')
            setStatus('saved')
            setSaved(clone(sent))
            setData((d) => (d === null ? d : { ...d, state: body?.state?.state ?? d.state }))
            // 等待期间没有再改动的话，顺便把本地视图对齐到合并后的完整状态（这样另一轴的改动也看得见）
            setDraft((prev) => (JSON.stringify(prev) === JSON.stringify(sent) ? clone(merged) : prev))
          } catch (e) {
            setSaveError(t('error.save', { error: e?.message ?? e }))
            setStatus('error')
          }
        }, CC_SAVE_DEBOUNCE_MS)
        return () => clearTimeout(timer)
      }, [draft, dirty, setSaved])

      // 从宿主快照里派生"当前在哪"
      const derived = useMemo(() => {
        const wsItems = Array.isArray(wsSnap?.items) ? wsSnap.items : []
        const seOk = seSnap !== null && seSnap !== undefined && seSnap.byId !== undefined && seSnap.byId !== null
        const byId = seOk ? seSnap.byId : {}
        const curSessionId = seOk && typeof seSnap.current === 'string' && seSnap.current.length > 0 ? seSnap.current : null
        const curSession = curSessionId === null ? null : (byId[curSessionId] ?? null)
        let curWs = null
        if (curSessionId !== null) curWs = wsItems.find((w) => (w.sessionIds ?? []).includes(curSessionId)) ?? null
        if (curWs === null) {
          const cwd = typeof curSession?.cwd === 'string' && curSession.cwd.length > 0
            ? curSession.cwd
            : (typeof data?.env?.cwd === 'string' && data.env.cwd.length > 0 ? data.env.cwd : null)
          if (cwd !== null) curWs = wsItems.find((w) => w.path === cwd) ?? null
        }
        const curWsPath = curWs !== null
          ? curWs.path
          : (typeof curSession?.cwd === 'string' && curSession.cwd.length > 0
            ? curSession.cwd
            : (typeof data?.env?.cwd === 'string' && data.env.cwd.length > 0 ? data.env.cwd : null))
        return { wsItems, byId, curSessionId, curSession, curWs, curWsPath, sessionsOk: seOk, workspacesOk: wsSnap !== null && wsSnap !== undefined }
      }, [wsSnap, seSnap, data])

      /**
       * 技能全集 —— **按会话取**，跟「技能面板」「模型看到的目录」用同一份来源。
       *
       * 为什么不能用宿主 /skills：那走的是 `ctx.skills.list({})`，只有**全局层**，
       * 既少了 agent 作用域的技能（`dsh-plugin-patch-layer` 这种），又含了被技能面板
       * 关掉的技能。真身是宿主在 agent/pre-step 里用的那句：
       *     ctx.skills.snapshot({ cwd: agent.session.header.cwd, scope: agent })
       * 客户端对应的是 `ctx.get('remote.skills').list({ sessionId })`（带 sessionId 的 RPC），
       * 它会给 `{ name, description, modelInvocable }`，正是这里要的。
       */
      useEffect(() => {
        let live = true
        const sid = derived.curSessionId
        /* 两个成功分支都顺手记一份（跨重启缓存），下一帧冷启动就不用干等这一栏。 */
        const remember = (list) => { lsWrite(SKILL_CACHE_KEY, { list, at: Date.now() }) }
        const run = async () => {
          try {
            const remote = serviceOf('remote.skills')
            if (remote !== null && remote !== undefined && typeof remote.list === 'function' && typeof sid === 'string') {
              const r = await remote.list({ sessionId: sid })
              if (r !== null && r !== undefined && r.ok === true && Array.isArray(r.value?.skills)) {
                if (!live) return
                const list = r.value.skills.map((s) => ({ name: s.name, description: s.description ?? '', modelInvocable: s.modelInvocable !== false }))
                setSkillInfo({ list, source: 'session', at: Date.now(), error: '' })
                remember(list)
                return
              }
            }
          } catch { /* 掉到下面用宿主接口兜底 */ }
          try {
            const b = await (await fetch(`${CC_API}/skills`, { headers: { accept: 'application/json' } })).json()
            if (!live) return
            const list = (Array.isArray(b?.skills) ? b.skills : []).map((s) => ({ name: s.name, description: s.description ?? '', modelInvocable: true }))
            setSkillInfo({ list, source: 'global', at: Date.now(), error: '' })
            if (list.length > 0) remember(list)
          } catch (e) {
            if (live) setSkillInfo((p) => ({ ...p, error: String(e?.message ?? e) }))
          }
        }
        void run()
        return () => { live = false }
      }, [reloadAt, derived.curSessionId])

      /**
       * 插件启用状态 —— 读 DSH 自己的 Loader 清单（`remote.pluginInventory`）。
       *
       * 为什么要有这一条：插件可以"装着但没启用"（当前机器上就是 `mcp-panel` / `mcp-connector`
       * 在 profile 补丁层被 `disabled: true` 关掉了）。没启用的插件底下工具根本不存在，
       * 把它勾进组合没有意义，所以界面上要**灰掉、不可选**。
       *
       * 判定：按**包名**归并，只要同一包名下**有任何一条 entry 是启用的**就算启用
       *（内置包常常一条 disabled、另一条 active，不能只看单条）。
       */
      const [pluginState, setPluginState] = useState({ byPkg: {}, at: 0, ok: false })
      useEffect(() => {
        let live = true
        const run = async () => {
          try {
            const inv = serviceOf('remote.pluginInventory')
            if (inv === null || inv === undefined || typeof inv.list !== 'function') return
            const r = await inv.list()
            const entries = r !== null && r !== undefined && r.ok === true ? r.value?.entries : null
            if (!Array.isArray(entries) || !live) return
            const byPkg = {}
            for (const e of entries) {
              const k = e === null || e === undefined ? '' : String(e.moduleName ?? '')
              if (k === '') continue
              byPkg[k] = byPkg[k] === true || e.enabled === true
            }
            setPluginState({ byPkg, at: Date.now(), ok: true })
          } catch { /* 拿不到就当作"全都没禁用"，不要让 UI 崩 */ }
        }
        void run()
        return () => { live = false }
      }, [reloadAt])

      if (error !== '' && data === null) {
        return jsxs('div', { style: S.page, children: [
          jsx('div', { style: S.title, children: t('common.compositionOf', { unit: unitCap }) }),
          jsx('div', { style: { ...S.err, marginTop: '8px' }, children: t('error.hostApi', { error }) }),
          jsx('button', { style: { ...S.btn, marginTop: '8px' }, onClick: () => setReloadAt((n) => n + 1), children: t('btn.retry') }),
        ] })
      }
      if (data === null || draft === null) {
        /* 这一行是界面上显示的「正在读取…」。以前它可能永远不消失
           （请求挂住 + 缓存丢），现在：① 缓存跨重启还在（第一帧通常直接有内容）；
           ② GET 有超时 + 重试；③ 这里就地给一颗「重试」，不用等面板自己重挂。 */
        return jsxs('div', { style: { ...S.meta, padding: '6px 0' }, children: [
          jsx('span', { children: t('state.loading') }),
          jsx('button', {
            style: { ...S.btn, marginLeft: '10px' },
            onClick: () => setReloadAt((n) => n + 1),
            children: t('btn.retry'),
          }),
        ] })
      }

      try {
        const comps = draft.compositions[facet]
        const compNames = Object.keys(comps)
        const membersOf = (n) => (Array.isArray(comps[n]?.[axis]) ? comps[n][axis] : [])

        // 两轴各自的"可选清单"
        // 技能：只要**已启用**的（`modelInvocable !== false`）。停用的技能模型看不到，
        //       勾进组合也没有意义 —— 技能面板的"156 个已启用"就是这一批。
        // 插件：只要 Loader 里**真的启用**的；没启用的单独灰在列表尾巴上，不可选。
        /* 修复「技能全失效」死循环 —— 别再加回 modelInvocable 过滤！
         *
         * 症状：打开任意组合，成员几乎全部标成「失效」，点一下「一键清除」就真删了。
         *
         * 根因（自己造的循环）：
         *   ① index.js 的 makeShadowProvider 会把**不在当前生效组合里**的技能重新登记成
         *      `invocation.modelInvocable = false`，以此把它们遮蔽出技能目录；
         *   ② 会话级 RPC（remote.skills.list）返回的 modelInvocable **正是被①改过的值**；
         *   ③ 老代码在这里 `.filter(modelInvocable !== false)` ⇒ universe 只剩**当前生效
         *      组合里那几个**；
         *   ④ 于是"打开别的组合"时，成员在 universe 里找不到 ⇒ 显示「失效」。
         *
         * 修法：universe 一律用 **skillInfo.list 全量**。modelInvocable 只保留语义用于
         * 「界面灰度」（见下方 notSelectable），**不再用于判定「这条技能存在不存在」**。
         * 判定存在与否只能看名字在不在全集里 —— 遮蔽不该被误读成删除。 */
        const enabledSkills = skillInfo.list
        const disabledSkills = []
        const pluginRows = Array.isArray(data.plugins) ? data.plugins : []
        const toolNamesAll = (Array.isArray(data.tools) ? data.tools : []).map((t) => t.name)
        const isPkgEnabled = (pkg) => {
          if (pluginState.ok !== true) return true            // 拿不到清单就当作全启用，别误伤
          const v = pluginState.byPkg[String(pkg ?? '')]
          return v === undefined ? true : v === true          // 清单里没有这个包 ⇒ 不判死
        }
        const pluginCounts = countToolsPerPlugin(pluginRows, toolNamesAll)
        // 兜底桶自己重算一遍：没被任何插件认领、又不是核心/元工具/MCP 的，就是它的。
        //（宿主也给了个数，但那是宿主那套旧推导算的，跟这里的口径会打架 —— 同一屏不能出现两个数。）
        const coreSet = new Set(Array.isArray(data.coreTools) ? data.coreTools : [])
        const metaSet = new Set(Array.isArray(data.metaTools) ? data.metaTools : [])
        const orphanCount = toolNamesAll.filter((n) => !coreSet.has(n) && !metaSet.has(n)
          && !String(n).startsWith('mcp__') && !pluginCounts.claimed.has(n)).length
        const countOf = (p) => (p.id === 'unassigned' ? orphanCount : (pluginCounts.counts.get(p.id) ?? p.toolCount ?? 0))
        // 宿主那一半**重启后**才会在 /state 里带 `scanCertain`。带了就用它的权威结论，
        // 没带就退回本地前缀推导（界面不至于空白，但徽标不会出现 —— 会在清单行里写明）。
        const scanReady = pluginRows.length > 0 && pluginRows.some((p) => typeof p.scanCertain === 'boolean')
        const enabledPlugins = []
        const disabledPlugins = []
        for (const p of pluginRows) {
          const row = {
            id: p.id,
            name: p.name ?? p.id,
            description: p.description ?? '',
            keywords: p.keywords ?? [],
            // 宿主给了**读包字节**出来的精确工具表和「体验插件」判定，就用它的；
            // 宿主还没重启（没有这些字段）时退回本地前缀推导，界面不至于空白。
            toolCount: scanReady ? (typeof p.toolCount === 'number' ? p.toolCount : countOf(p)) : countOf(p),
            toolNames: Array.isArray(p.toolNames) ? p.toolNames : null,
            uiOnly: scanReady && p.uiOnly === true,
            scanCertain: scanReady ? p.scanCertain !== false : null,
            pkg: p.pkg,
          }
          if (isPkgEnabled(p.pkg)) enabledPlugins.push(row)
          else disabledPlugins.push(row)
        }
        /* universe = 技能**全集**（见上方修复说明）。modelInvocable 用真实值，
           仅供界面灰度；不参与「是否存在」的判定。 */
        const universe = isSkill
          ? enabledSkills.map((s) => ({ id: s.name, name: s.name, description: s.description, keywords: [], toolCount: 0, modelInvocable: s.modelInvocable !== false }))
          : enabledPlugins
        const notSelectable = isSkill
          ? disabledSkills.map((s) => ({ id: s.name, name: s.name, description: s.description, keywords: [], toolCount: 0 }))
          : disabledPlugins

        const pin = draft.pinned[facet]
        const ses = draft.session[facet]
        const gNames = pinNamesOf(pin['*'])
        const wNames = derived.curWsPath === null ? [] : pinNamesOf(pin[derived.curWsPath])
        const sNames = derived.curSessionId === null ? [] : pinNamesOf(ses[derived.curSessionId])
        // 三级：会话 > 工作区 > 全局；**同一级可多选**，取并集。
        const effective = sNames.length > 0 ? { names: sNames, from: t('level.session') }
          : wNames.length > 0 ? { names: wNames, from: t('level.workspace') }
            : gNames.length > 0 ? { names: gNames, from: t('level.global') }
              : { names: [], from: t('level.global') }
        const effectiveLabel = effective.names.length === 0 ? '' : effective.names.join(' + ')
        const effectiveMissing = effective.names.filter((n) => comps[n] === undefined)
        /**
         * 把多套组合的名单合成一份。三态和宿主**完全一致**：
         *   · 有任一「全不选」⇒ 全不选（不然"显式声明全不选"会被别的组合救回来）；
         *   · 都没名单 ⇒ 不过滤（null）；
         *   · 否则取并集。
         */
        const mergeMembers = (names) => {
          let sawNone = false
          let sawMembers = false
          const ids = new Set()
          for (const n of names) {
            const list = membersOf(n)
            if (list.length === 1 && list[0] === CC_NONE) { sawNone = true; continue }
            if (list.length === 0) continue
            sawMembers = true
            for (const id of list) ids.add(id)
          }
          if (sawNone) return { none: true, ids: [] }
          if (!sawMembers) return { none: false, ids: null }
          return { none: false, ids: [...ids] }
        }
        const effMerged = effectiveMissing.length > 0 ? { none: false, ids: null } : mergeMembers(effective.names)
        const effectiveNone = effMerged.none
        const effectiveMembers = effMerged.ids ?? []
        const visible = effectiveNone
          ? []
          : effMerged.ids === null
            ? universe
            : universe.filter((it) => effMerged.ids.includes(it.id))
        const patch = (fn) => {
          const next = clone(draft)
          fn(next)
          setDraft(next)
        }
        const setGlobal = (v) => patch((s) => { if (v === null) delete s.pinned[facet]['*']; else s.pinned[facet]['*'] = v })
        const setWs = (key, v) => patch((s) => { if (v === null) delete s.pinned[facet][key]; else s.pinned[facet][key] = v })
        const setSession = (key, v) => patch((s) => { if (v === null) delete s.session[facet][key]; else s.session[facet][key] = v })
        const setMembers = (name, list) => patch((s) => {
          const uniq = [...new Set(list)]
          // 「全勾上」语义上等于不过滤 —— 一律归一回空数组，别把 54 个 id 写进状态文件。
          // （universe 为空时不动，免得把「全不选」误归一成「不过滤」。）
          const live = uniq.filter((id) => universe.some((it) => it.id === id)).length
          s.compositions[facet][name][axis] = universe.length > 0 && live >= universe.length ? [] : uniq
        })

        const act = active !== null && comps[active] !== undefined ? active : compNames[0] ?? null
        const pickNext = (oldName, newName) => {
          const trimmed = String(newName ?? '').trim()
          patch((s) => {
            if (trimmed === '' || (trimmed !== oldName && s.compositions[facet][trimmed] !== undefined)) return
            s.compositions[facet][trimmed] = s.compositions[facet][oldName]
            delete s.compositions[facet][oldName]
            for (const ax of ['pinned', 'session']) {
              for (const k of Object.keys(s[ax][facet])) if (s[ax][facet][k] === oldName) s[ax][facet][k] = trimmed
            }
          })
        }
        /**
         * 新建时最终写进去的名字：`<系列>·<名字>`；系列留空 = 不分组，就叫名字本身。
         * 系列里的 `·` 会被剥掉，避免造出 `a·b·c` 这种两级系列（约定只有一级）。
         */
        const composedNewName = () => {
          const raw = String(newName ?? '').trim()
          const sn = (newSeries === CC_SERIES_NEW ? String(seriesDraft ?? '') : String(newSeries ?? ''))
            .replace(new RegExp(CC_SERIES_SEP, 'g'), '')
            .trim()
          return sn === '' ? raw : `${sn}${CC_SERIES_SEP}${raw}`
        }
        const closeNew = () => { setNewName(null); setNewSeries(''); setSeriesDraft('') }
        const createComp = () => {
          const name = composedNewName()
          if (name === '' || name === CC_SERIES_SEP || comps[name] !== undefined) return
          patch((s) => { s.compositions[facet][name] = isSkill ? { skills: [] } : { plugins: [] } })
          setActive(name)
          closeNew()
        }
        /** 已有系列名（给「新建」的系列下拉用）。 */
        const knownSeries = () => {
          const set = new Set()
          for (const n of compNames) { const s = seriesOf(n); if (s !== '') set.add(s) }
          return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
        }
        /**
         * **整组改系列名**：`开发·日常 / 开发·排障` → `研发·日常 / 研发·排障`。
         *
         * 三件事一起做，缺一个就会留下"孤儿引用"：
         *   ① 组里每个组合改名前缀；② `pinned` / `session` 里指向旧名的引用跟着改；
         *   ③ 当前选中的组合（act）也跟着切过去，否则面板会跳到列表第一个。
         *
         * 边界：
         *   · 新系列名留空 ⇒ 这一组**取消系列**（回到「不分组」，名字砍掉前缀）；
         *   · 目标名已存在（同组里已有同名组合）⇒ **跳过那一个**，其余照改，绝不覆盖别人；
         *   · 系列名里的 `·` 会被剥掉（约定只有一级系列）。
         */
        const renameSeries = (oldSeries, rawNext) => {
          const next = String(rawNext ?? '').split(CC_SERIES_SEP).join('').trim()
          if (oldSeries === '' || oldSeries === next) { setSeriesRenaming(null); setSeriesRenameDraft(''); return }
          const members = compNames.filter((n) => seriesOf(n) === oldSeries)
          // 留空 = 把整组**取消系列**（回到不分组）—— 这是"一次改一堆名字"，必须确认，
          // 否则手滑清空输入框再点「改好」，8 个组合的系列名就没了（确实发生过一次）。
          if (next === '' && members.length > 0) {
            const ok = window.confirm(t('confirm.cancelSeries', { name: oldSeries, n: members.length, list: members.join(t('sep.enum')) }))
            if (!ok) { setSeriesRenaming(null); setSeriesRenameDraft(''); return }
          }
          const map = []
          for (const name of members) {
            const leaf = name.slice(oldSeries.length + CC_SERIES_SEP.length)
            const renamed = next === '' ? leaf : `${next}${CC_SERIES_SEP}${leaf}`
            if (renamed !== name && comps[renamed] !== undefined) continue
            map.push([name, renamed])
          }
          if (map.length > 0) {
            patch((s) => {
              for (const [from, to] of map) {
                if (from === to) continue
                s.compositions[facet][to] = s.compositions[facet][from]
                delete s.compositions[facet][from]
                for (const ax of ['pinned', 'session']) {
                  for (const k of Object.keys(s[ax][facet])) if (s[ax][facet][k] === from) s[ax][facet][k] = to
                }
              }
            })
            const moved = map.find(([from]) => from === act)
            if (moved !== undefined) setActive(moved[1])
          }
          setSeriesRenaming(null)
          setSeriesRenameDraft('')
        }
        /**
         * **整组删除系列**：一次删掉这一组里的全部组合，并把引用一起清掉。
         * 调用前 UI 已经用红字摊开过"要删哪几个"，所以这里不再二次确认。
         */
        const deleteSeries = (series) => {
          const members = compNames.filter((n) => seriesOf(n) === series)
          if (members.length === 0) { setSeriesDeleting(null); return }
          patch((s) => {
            for (const name of members) {
              delete s.compositions[facet][name]
              for (const ax of ['pinned', 'session']) {
                for (const k of Object.keys(s[ax][facet])) if (s[ax][facet][k] === name) delete s[ax][facet][k]
              }
            }
          })
          // 被删的正好是当前选中项 ⇒ 让面板自然落到剩下的第一个（不然 act 会指向不存在的名字）
          if (members.includes(act)) setActive(null)
          setSeriesDeleting(null)
        }
        // 拖动排序：只动顺序，不动内容
        /**
         * 把 from 移到 to 那一格（**只在同一系列内**生效：跨系列拖动等于改名，不做）。
         *
         * `after` = 指针落在目标芯片的**下半部分** ⇒ 插到它后面。
         * 没有这个判断的话，"往后拖一格"会算成插到目标前面 = **顺序不变**（看着像拖不动）。
         */
        const reorderWithinSeries = (order, from, to, after) => {
          if (from === to || seriesOf(from) !== seriesOf(to)) return order
          const next = (order ?? []).filter((n) => n !== from)
          const i = next.indexOf(to)
          if (i < 0) return order
          next.splice(after ? i + 1 : i, 0, from)
          return next
        }
        /** 把整个系列块挪到另一个系列的位置（系列之间排序）。 */
        const reorderSeriesBlock = (order, fromSeries, toSeries) => {
          if (fromSeries === toSeries || fromSeries === '') return order
          const mine = order.filter((n) => seriesOf(n) === fromSeries)
          if (mine.length === 0) return order
          const rest = order.filter((n) => seriesOf(n) !== fromSeries)
          const anchor = rest.findIndex((n) => seriesOf(n) === toSeries)
          if (anchor < 0) return order
          const next = [...rest]
          next.splice(anchor, 0, ...mine)
          return next
        }
        /** 按新顺序重写 compositions 的键 ⇒ 落盘（键顺序就是显示顺序）。 */
        const commitOrder = (order) => {
          if (!Array.isArray(order)) return
          patch((s) => {
            const next = {}
            for (const n of order) if (s.compositions[facet][n] !== undefined) next[n] = s.compositions[facet][n]
            for (const n of Object.keys(s.compositions[facet])) if (next[n] === undefined) next[n] = s.compositions[facet][n]
            const cur = Object.keys(s.compositions[facet])
            const same = cur.length === Object.keys(next).length && cur.every((n, i) => n === Object.keys(next)[i])
            if (!same) s.compositions[facet] = next
          })
        }
        /** 长按开始：只有按住 ~180ms 没松手，这次手势才算"拖"。 */
        const beginDrag = (e, kind, name) => {
          if (e.button !== undefined && e.button !== 0) return
          const st = dragRef.current
          st.name = name; st.kind = kind; st.active = false
          st.x = e.clientX; st.y = e.clientY; st.preview = null
          clearTimeout(st.timer)
          const cleanup = () => {
            clearTimeout(st.timer)
            if (st.onMove !== null) window.removeEventListener('pointermove', st.onMove)
            if (st.onUp !== null) { window.removeEventListener('pointerup', st.onUp); window.removeEventListener('pointercancel', st.onUp) }
            st.onMove = null; st.onUp = null
            try { document.body.style.userSelect = '' } catch { /* 忽略 */ }
            st.name = null; st.kind = null; st.active = false
          }
          st.onMove = (ev) => {
            if (!st.active) {
              // 还没到长按时间就明显移动 ⇒ 只是想滚动/点，放弃这次拖
              if (Math.abs(ev.clientX - st.x) + Math.abs(ev.clientY - st.y) > 8) { cleanup() }
              return
            }
            if (typeof ev.preventDefault === 'function') ev.preventDefault()
            const el = document.elementFromPoint(ev.clientX, ev.clientY)
            const chipEl = el !== null && el !== undefined && typeof el.closest === 'function' ? el.closest('[data-comp-name]') : null
            const headEl = el !== null && el !== undefined && typeof el.closest === 'function' ? el.closest('[data-series-name]') : null
            const base = st.preview ?? compNames
            let next = base
            if (st.kind === 'series') {
              const toSeries = headEl?.getAttribute('data-series-name') ?? (chipEl === null ? null : seriesOf(chipEl.getAttribute('data-comp-name')))
              if (toSeries !== null && toSeries !== undefined) next = reorderSeriesBlock(base, st.name, toSeries)
            } else {
              const toName = chipEl?.getAttribute('data-comp-name') ?? null
              if (toName !== null) {
                // 指针在目标芯片下半部分 ⇒ 插到它后面（否则"往后拖一格"会变成 no-op）
                let after = false
                try {
                  const rc = chipEl.getBoundingClientRect()
                  after = ev.clientY > rc.top + rc.height / 2
                } catch { /* 拿不到 rect 就按"插前面" */ }
                next = reorderWithinSeries(base, st.name, toName, after)
              }
            }
            if (next !== st.preview) { st.preview = next; setPreviewOrder(next) }
          }
          st.onUp = () => {
            const wasActive = st.active
            const order = st.preview
            cleanup()
            setDragName(null); setDragSeries(null); setPreviewOrder(null)
            if (wasActive && Array.isArray(order)) commitOrder(order)
          }
          st.timer = setTimeout(() => {
            st.active = true
            setDragName(kind === 'chip' ? name : null)
            setDragSeries(kind === 'series' ? name : null)
            setPreviewOrder(compNames)
            try { document.body.style.userSelect = 'none' } catch { /* 忽略 */ }
          }, 180)
          window.addEventListener('pointermove', st.onMove, { passive: false })
          window.addEventListener('pointerup', st.onUp)
          window.addEventListener('pointercancel', st.onUp)
        }
        /** 一个组合的芯片按钮（按系列分组后仍逐个渲染）。 */
        const chipFor = (name) => {
          const list = membersOf(name)
          const none = list.length === 1 && list[0] === CC_NONE
          const live = list.filter((id) => id !== CC_NONE && universe.some((it) => it.id === id)).length
          const dead = list.length - (none ? 1 : 0) - live
          const dragging = dragName === name
          return jsxs('button', {
            key: name,
            'data-comp-name': name,
            onPointerDown: (e) => beginDrag(e, 'chip', name),
            style: {
              ...S.chip, ...(name === act ? S.chipOn : {}),
              cursor: 'grab', touchAction: 'none',
              ...(dragging ? { opacity: 0.45, outline: '2px dashed ' + C.accent, outlineOffset: '1px' } : {}),
            },
            title: (none ? t('btn.selectNone') : list.length === 0 ? t('compact.all') : (dead > 0 ? t('compact.picked', { live, dead }) : t('compact.live', { live })))
              + t('compact.dragHint'),
            onClick: () => { if (dragName === null) setActive(name) },
            children: [
              jsx('span', { children: name }),
              jsx('span', { style: { fontSize: '10px', opacity: 0.75 }, children: none
                ? t('btn.selectNone')
                : list.length === 0
                  ? t('scope.noFilter')
                  : (dead > 0 ? t('compact.countBoth', { live, dead }) : t('compact.count', { live })) }),
            ],
          })
        }
        const deleteComp = (name) => {
          if (!window.confirm(t('confirm.deleteComp', { name }))) return
          patch((s) => {
            delete s.compositions[facet][name]
            for (const ax of ['pinned', 'session']) {
              for (const k of Object.keys(s[ax][facet])) if (s[ax][facet][k] === name) delete s[ax][facet][k]
            }
          })
        }

        // 「现在」卡片里的快捷指定：写到最具体的那一级
        const quickTarget = derived.curSessionId !== null ? 'session'
          : derived.curWsPath !== null ? 'workspace'
            : 'global'
        const quickLabel = quickTarget === 'session' ? t('level.session') : quickTarget === 'workspace' ? t('level.workspace') : t('level.global')
        const quickValue = quickTarget === 'session' ? sNames : quickTarget === 'workspace' ? wNames : gNames
        const quickInherit = quickTarget === 'session'
          ? t('inherit.workspace.short')
          : quickTarget === 'workspace' ? t('inherit.global.short') : t('scope.allVisible')
        const setQuick = (v) => {
          if (quickTarget === 'session') setSession(derived.curSessionId, v)
          else if (quickTarget === 'workspace') setWs(derived.curWsPath, v)
          else setGlobal(v)
        }

        const statusText = status === 'saving' ? t('state.saving')
          : status === 'pending' ? t('state.pending')
            : status === 'error' ? ''
              : status === 'saved' ? t('state.saved') : t('state.synced')

        const openList = openWs === null ? [] : openWs
        const toggleOpen = (id) => setOpenWs(openList.includes(id) ? openList.filter((x) => x !== id) : [...openList, id])

        return jsxs('div', { style: S.page, children: [
          // 顶栏
          jsxs('div', { style: S.bar, children: [
            jsxs('div', { style: S.row, children: [
              jsx('span', { style: { fontSize: '13.5px', fontWeight: 600 }, children: t('common.compositionOf', { unit: unitCap }) }),
              status === 'error'
                ? null
                : jsx('span', { style: status === 'pending' || status === 'saving' ? S.meta : S.ok, children: statusText }),
              dirty && status !== 'error'
                ? jsx('span', { style: { ...S.meta, opacity: 0.45 }, children: t('state.autoSave') })
                : null,
            ] }),
            jsx('button', {
              style: S.btn,
              // 只丢草稿、重拉磁盘状态；**不动当前选中的组合**（否则"重新载入"会把
              // 界面上的组合悄悄切成列表第一个，接着点删除就删错了）。
              // 同时重拉技能/插件清单，并在下面写一行可见的回执 —— 否则点了像没反应。
              onClick: () => { PERSIST[K('draft')] = null; PERSIST[K('saved')] = null; setReloadedAt(Date.now()); setReloadAt((n) => n + 1) },
              children: t('btn.reload'),
            }),
          ] }),

          error !== '' ? jsx('div', { style: { ...S.err, marginBottom: '10px' }, children: error }) : null,
          saveError !== '' ? jsx('div', { style: { ...S.err, marginBottom: '10px' }, children: saveError }) : null,

          // 现在
          jsxs('div', { style: S.card, children: [
            jsx('div', { style: S.head, children: jsx('div', { style: S.title, children: t('level.now') }) }),
            jsxs('div', { style: S.kv, children: [
              jsx('span', { style: S.label, children: t('level.workspaceShort') }),
              derived.curWs !== null
                ? jsxs('div', { style: S.row, children: [
                    jsx('span', { style: { fontSize: '12.5px', fontWeight: 500 }, children: derived.curWs.title }),
                    jsx('span', { style: S.mono, children: derived.curWs.path }),
                  ] })
                : jsx('span', { style: derived.curWsPath === null ? S.meta : S.mono, children: derived.curWsPath ?? t('ws.unknown') }),

              jsx('span', { style: S.label, children: t('level.sessionShort') }),
              derived.curSession === null
                ? jsx('span', { style: S.meta, children: derived.curSessionId === null ? t('ws.unknownShort') : shortId(derived.curSessionId) })
                : jsxs('div', { style: S.row, children: [
                    jsx('span', { style: { fontSize: '12.5px', fontWeight: 500 }, children: derived.curSession.title ?? derived.curSession.displayTitle ?? t('session.untitled') }),
                    jsx('span', { style: S.mono, title: derived.curSessionId ?? '', children: shortId(derived.curSessionId) }),
                  ] }),

              jsx('span', { style: S.label, children: t('level.effective') }),
              jsxs('div', { style: S.row, children: [
                jsx('span', { style: { fontSize: '12.5px', fontWeight: 600 }, children: effectiveNone
                  ? t('scope.none')
                  : effectiveLabel === '' || effectiveMissing.length > 0 ? t('scope.allVisible')
                    : effectiveLabel + (effective.names.length > 1 ? t('scope.union', { n: effective.names.length }) : '') }),
                jsx('span', { style: S.tag, children: t('scope.from', { from: effective.from }) }),
                jsx('span', { style: S.meta, children: t('scope.count', { visible: visible.length, total: universe.length, unit: isSkill ? t('unit.skill') : t('unit.plugin') }) }),
              ] }),

              jsx('span', { style: S.label, children: t('level.list') }),
              jsxs('div', { style: S.row, children: [
                jsx('span', {
                  style: S.meta,
                  title: isSkill
                    ? t('note.skills')
                    : t('note.plugins'),
                  children: isSkill
                    ? t('skillStat.total', { n: universe.length })
                      + (notSelectable.length > 0 ? t('skillStat.disabledList', { n: notSelectable.length }) : '')
                    : (() => {
                        const real = universe.filter((it) => it.id !== 'unassigned').length
                        const hasBucket = universe.length !== real
                        return t('pluginStat.total', { n: real })
                          + (hasBucket ? t('pluginStat.bucket') : '')
                          + (notSelectable.length > 0 ? t('pluginStat.disabledList', { n: notSelectable.length }) : '')
                          + (scanReady ? '' : t('pluginStat.rescanHint'))
                      })(),
                }),
                reloadedAt > 0
                  ? jsx('span', { style: S.ok, children: t('state.reloaded', { time: new Date(reloadedAt).toLocaleTimeString() }) })
                  : null,
              ] }),
            ] }),

            effectiveMissing
              ? jsx('div', { style: { ...S.warnBox, marginTop: '8px', marginBottom: 0 }, children: t('warn.missingSelected', { n: effectiveMissing.length, list: effectiveMissing.join(t('sep.enum')) }) })
              : null,

            jsxs('div', { style: { ...S.row, marginTop: '10px', paddingTop: '10px', borderTop: '1px solid ' + C.borderSoft }, children: [
              jsx('span', { style: S.label, children: t('scope.usedHere') }),
              jsx(PickCompose, {
                popKey: 'quick:' + facet + ':' + quickLabel,
                values: quickValue,
                names: compNames,
                inheritLabel: quickInherit,
                onChange: setQuick,
                disabled: compNames.length === 0,
              }),
              jsx('span', { style: S.meta, children: t('scope.writeTo', { name: quickLabel }) }),
              compNames.length === 0
                ? jsx('span', { style: S.meta, children: t('scope.createFirst') })
                : null,
            ] }),
          ] }),

          // 组合
          jsxs('div', { style: S.card, children: [
            jsxs('div', { style: S.head, children: [
              jsx('div', { style: S.title, children: t('comp.header') }),
              jsx('button', {
                style: S.btn,
                // 已经开着就只是把光标送回输入框 —— **绝不第二次点击就把它关掉**
                // （以前是 新建/取消 一键切换：连点两下 = 输入框瞬间消失，看着就像"点了没反应"）。
                onClick: () => {
                  if (newName === null) setNewName('')
                  else if (newNameRef.current !== null && newNameRef.current !== undefined) newNameRef.current.focus()
                },
                children: t('btn.new'),
              }),
            ] }),
            jsx('div', { style: S.sub, children: t('comp.intro', { unit, sep: CC_SERIES_SEP }) }),

            newName !== null
              ? jsxs('div', { style: { ...S.row, marginBottom: '8px', flexWrap: 'wrap' }, children: [
                  // 系列下拉：不分组 / 已有系列 / ＋新系列…
                  jsx('select', {
                    style: S.select,
                    value: newSeries,
                    title: t('series.tip', { sep: CC_SERIES_SEP }),
                    onChange: (e) => { setNewSeries(e.target.value); if (e.target.value !== CC_SERIES_NEW) setSeriesDraft('') },
                    children: [
                      jsx('option', { value: '', children: t('series.ungrouped') }),
                      ...knownSeries().map((s) => jsx('option', { key: s, value: s, children: s })),
                      jsx('option', { value: CC_SERIES_NEW, children: t('series.new') }),
                    ],
                  }),
                  newSeries === CC_SERIES_NEW
                    ? jsx('input', {
                        style: { ...S.input, flex: '0 1 120px' },
                        placeholder: t('series.namePlaceholder'),
                        value: seriesDraft,
                        autoComplete: 'off',
                        spellCheck: false,
                        onChange: (e) => setSeriesDraft(e.target.value),
                        onKeyDown: (e) => { if (e.key === 'Enter') createComp() },
                      })
                    : null,
                  jsx('input', {
                    ref: newNameRef,
                    style: { ...S.input, flex: '1 1 140px' },
                    placeholder: t('comp.namePlaceholder'),
                    value: newName,
                    autoFocus: true,
                    autoComplete: 'off',
                    spellCheck: false,
                    onChange: (e) => setNewName(e.target.value),
                    onKeyDown: (e) => {
                      if (e.key === 'Enter') createComp()
                      if (e.key === 'Escape') { setNewName(null); setNewSeries(''); setSeriesDraft('') }
                    },
                  }),
                  jsx('button', { style: S.btnPrimary, onClick: createComp, children: t('btn.create') }),
                  jsx('button', { style: S.btn, onClick: closeNew, children: t('btn.cancel') }),
                  composedNewName() !== '' && comps[composedNewName()] !== undefined
                    ? jsx('span', { style: { ...S.meta, color: C.danger }, children: t('comp.duplicate') })
                    : null,
                  newSeries === CC_SERIES_NEW || newSeries !== ''
                    ? jsx('span', { style: S.meta, children: t('comp.willCreate', { name: composedNewName() }) })
                    : null,
                ] })
              : null,

            compNames.length === 0
              ? jsx(Empty, { text: t('comp.empty'), action: t('btn.createNew'), onAction: () => setNewName('') })
              : jsxs('div', { children: groupBySeries(previewOrder ?? compNames).map((g) => jsxs('div', {
                  key: 'ser:' + g.series,
                  style: { marginBottom: '5px', ...(dragSeries === g.series ? { opacity: 0.5 } : {}) },
                  children: [
                    jsxs('div', { style: { ...S.group, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }, children: [
                      jsx('span', {
                        'data-series-name': g.series,
                        onPointerDown: g.series === '' ? undefined : (e) => beginDrag(e, 'series', g.series),
                        style: { cursor: g.series === '' ? 'default' : 'grab', touchAction: 'none' },
                        title: g.series === '' ? undefined : t('series.dragHint'),
                        children: g.series === ''
                          ? t('series.ungrouped')
                          : t('series.label', { name: g.series, n: g.names.length }),
                      }),
                      g.series === '' ? null : (seriesDeleting === g.series
                        ? jsx('div', {
                            style: {
                              ...S.warnBox, marginBottom: 0, flex: '1 1 100%',
                              borderColor: C.danger, color: C.danger,
                            },
                            children: [
                              jsx('div', { children: t('series.deleteWarn', { name: g.series, n: g.names.length }) }),
                              jsx('div', { style: { ...S.mono, marginTop: '2px' }, children: g.names.join(t('sep.enum')) }),
                              jsxs('div', { style: { ...S.row, marginTop: '6px' }, children: [
                                jsx('button', {
                                  style: { ...S.btn, ...S.btnDanger, fontWeight: 600 },
                                  onClick: () => deleteSeries(g.series),
                                  children: t('series.confirmDelete', { n: g.names.length }),
                                }),
                                jsx('button', {
                                  style: S.btn,
                                  onClick: () => setSeriesDeleting(null),
                                  children: t('btn.cancel'),
                                }),
                              ] }),
                            ],
                          })
                        : (seriesRenaming === g.series
                          ? [
                              jsx('input', {
                                key: 'sr',
                                style: { ...S.input, width: '168px', fontSize: '11px', padding: '1px 6px' },
                                value: seriesRenameDraft,
                                autoFocus: true,
                                placeholder: t('series.renamePlaceholder'),
                                autoComplete: 'off',
                                spellCheck: false,
                                onChange: (e) => setSeriesRenameDraft(e.target.value),
                                onKeyDown: (e) => {
                                  if (e.key === 'Enter') renameSeries(g.series, seriesRenameDraft)
                                  if (e.key === 'Escape') { setSeriesRenaming(null); setSeriesRenameDraft('') }
                                },
                              }),
                              jsx('button', {
                                key: 'ok',
                                style: { ...S.btn, padding: '0 8px', fontSize: '10.5px' },
                                onClick: () => renameSeries(g.series, seriesRenameDraft),
                                children: t('btn.done'),
                              }),
                              jsx('button', {
                                key: 'no',
                                style: { ...S.btn, padding: '0 8px', fontSize: '10.5px' },
                                onClick: () => { setSeriesRenaming(null); setSeriesRenameDraft('') },
                                children: t('btn.cancel'),
                              }),
                            ]
                          : [
                              jsx('button', {
                                key: 'rn',
                                style: { ...S.btn, padding: '0 7px', fontSize: '10.5px' },
                                title: t('series.renameTip', { n: g.names.length }),
                                onClick: () => { setSeriesRenaming(g.series); setSeriesRenameDraft(g.series); setSeriesDeleting(null) },
                                children: t('btn.renameSeries'),
                              }),
                              jsx('button', {
                                key: 'del',
                                style: { ...S.btn, ...S.btnDanger, padding: '0 7px', fontSize: '10.5px' },
                                title: t('series.deleteTip', { n: g.names.length }),
                                onClick: () => { setSeriesDeleting(g.series); setSeriesRenaming(null); setSeriesRenameDraft('') },
                                children: t('btn.deleteSeries'),
                              }),
                            ])),
                    ] }),
                    jsxs('div', { style: { ...S.row, flexWrap: 'wrap' }, children: g.names.map(chipFor) }),
                  ],
                })) }),

            act === null ? null : jsxs('div', { children: [
              jsxs('div', { style: { ...S.row, justifyContent: 'space-between', marginTop: '12px', marginBottom: '6px' }, children: [
                renaming === null
                  ? jsxs('div', { style: S.row, children: [
                      jsx('span', { style: { fontSize: '12.5px', fontWeight: 600 }, children: t('comp.labelOf', { name: act, unit }) }),
                      jsx('span', { style: S.meta, children: (() => {
                        const list = membersOf(act)
                        if (list.length === 0) return t('compact.hint.all', { n: universe.length, unit })
                        if (list.length === 1 && list[0] === CC_NONE) return t('compact.hint.none')
                        const live = list.filter((id) => universe.some((it) => it.id === id)).length
                        const dead = list.length - live
                        return t('compact.hint.allow', { n: list.length })
                          + t('compact.hint.live', { n: live })
                          + (dead > 0 ? t('compact.hint.dead', { n: dead }) : '')
                      })() }),
                    ] })
                  : jsxs('div', { style: S.row, children: [
                      jsx('input', {
                        ref: renameRef,
                        style: { ...S.input, width: '200px' },
                        value: renaming,
                        autoFocus: true,
                        autoComplete: 'off',
                        spellCheck: false,
                        onChange: (e) => setRenaming(e.target.value),
                        onKeyDown: (e) => {
                          if (e.key === 'Enter') { pickNext(act, renaming); setRenaming(null); setActive(String(renaming).trim()) }
                          if (e.key === 'Escape') setRenaming(null)
                        },
                      }),
                      jsx('button', { style: S.btnPrimary, onClick: () => { pickNext(act, renaming); setActive(String(renaming).trim()); setRenaming(null) }, children: t('btn.done') }),
                      jsx('button', { style: S.btn, onClick: () => setRenaming(null), children: t('btn.cancel') }),
                    ] }),
                renaming === null
                  ? jsxs('div', { style: S.row, children: [
                      jsx('button', { style: S.btn, onClick: () => setRenaming(act), children: t('btn.rename') }),
                      jsx('button', { style: { ...S.btn, ...S.btnDanger }, onClick: () => deleteComp(act), children: t('btn.delete') }),
                    ] })
                  : null,
              ] }),
              jsx(MemberPicker, {
                universe,
                isSkill,
                notSelectable,
                members: membersOf(act),
                onSet: (list) => setMembers(act, list),
                query,
                setQuery,
                view,
                setView,
              }),
            ] }),
          ] }),

          // 用在哪
          jsxs('div', { style: S.card, children: [
            jsx('div', { style: S.head, children: jsx('div', { style: S.title, children: t('scope.header') }) }),
            jsx('div', { style: S.sub, children: t('scope.tip') }),

            jsx(LevelRow, {
              title: t('scope.globalTip'),
              detail: '',
              isCur: effective.from === t('level.global'),
              value: gNames,
              names: compNames,
              inheritLabel: t('scope.allVisible'),
              onPick: setGlobal,
            }),

            jsx('div', { style: S.group, children: t('level.workspaceShort') }),
            derived.wsItems.length === 0
              ? jsx(Empty, {
                  text: derived.workspacesOk ? t('ws.none') : t('ws.serviceMissing'),
                })
              : derived.wsItems.map((w) => {
                  const isCurWs = derived.curWs !== null && derived.curWs.workspaceId === w.workspaceId
                  const wsVal = pinNamesOf(pin[w.path])
                  const open = openList.includes(w.workspaceId)
                  const sessionIds = Array.isArray(w.sessionIds) ? w.sessionIds : []
                  const overridden = sessionIds.filter((sid) => pinNamesOf(ses[sid]).length > 0).length
                  return jsxs('div', { key: w.workspaceId, children: [
                    jsxs('div', {
                      style: { ...S.line, ...(isCurWs ? S.lineCur : {}), borderBottom: sessionIds.length === 0 ? '1px solid ' + C.borderSoft : 'none' },
                      children: [
                      jsx('div', { style: S.lineMain, children: jsxs('div', { style: S.row, gap: '6px', children: [
                        jsx('span', { style: { ...S.lineTitle, flex: '0 1 auto' }, title: w.path, children: w.title }),
                        isCurWs ? jsx('span', { style: S.badgeCur, children: t('badge.current') }) : null,
                        jsx('span', { style: S.mono, title: w.path, children: w.path }),
                        sessionIds.length === 0
                          ? null
                          : jsx('button', {
                              style: { ...S.btn, padding: '1px 7px', fontSize: '11px' },
                              onClick: () => toggleOpen(w.workspaceId),
                              children: open
                                ? t('session.collapse')
                                : t('session.header', { n: sessionIds.length }) + (overridden > 0 ? t('session.overridden', { n: overridden }) : ''),
                            }),
                      ] }) }),
                      jsx(PickCompose, {
                        popKey: 'ws:' + w.path,
                        values: wsVal,
                        names: compNames,
                        inheritLabel: t('inherit.global', { names: gNames.length === 0 ? t('scope.noFilter') : gNames.join(' + ') }),
                        onChange: (v) => setWs(w.path, v),
                      }),
                    ] }),
                    open
                      ? jsxs('div', { style: { borderBottom: '1px solid ' + C.borderSoft, paddingBottom: '2px' }, children: [
                          ...sessionIds.map((sid) => {
                            const row = derived.byId[sid] ?? null
                            const isCurSe = derived.curSessionId === sid
                            const seVal = pinNamesOf(ses[sid])
                            return jsx(LevelRow, {
                              key: sid,
                              title: row === null ? shortId(sid) : (row.title ?? row.displayTitle ?? t('session.untitled')),
                              detail: row === null ? sid : shortId(sid),
                              isCur: isCurSe,
                              indent: true,
                              value: seVal,
                              names: compNames,
                              inheritLabel: t('inherit.workspace', { names: wsVal.length === 0 ? (gNames.length === 0 ? t('scope.noFilter') : gNames.join(' + ')) : wsVal.join(' + ') }),
                              onPick: (v) => setSession(sid, v),
                            })
                          }),
                        ] })
                      : null,
                  ] })
                }),

            derived.curSessionId !== null && derived.curWs === null
              ? jsxs('div', { children: [
                  jsx('div', { style: S.group, children: t('session.orphan') }),
                  jsx(LevelRow, {
                    title: derived.curSession === null ? shortId(derived.curSessionId) : (derived.curSession.title ?? t('session.untitled')),
                    detail: shortId(derived.curSessionId),
                    isCur: true,
                    value: sNames,
                    names: compNames,
                    inheritLabel: t('inherit.global', { names: gNames.length === 0 ? t('scope.noFilter') : gNames.join(' + ') }),
                    onPick: (v) => setSession(derived.curSessionId, v),
                  }),
                ] })
              : null,

            derived.curWsPath !== null && !derived.wsItems.some((w) => w.path === derived.curWsPath)
              ? jsxs('div', { children: [
                  jsx('div', { style: S.group, children: t('ws.currentDir') }),
                  jsx(LevelRow, {
                    title: derived.curWsPath,
                    detail: t('ws.currentDirTip'),
                    value: pinNamesOf(pin[derived.curWsPath]),
                    names: compNames,
                    inheritLabel: t('inherit.global', { names: gNames.length === 0 ? t('scope.noFilter') : gNames.join(' + ') }),
                    onPick: (v) => setWs(derived.curWsPath, v),
                  }),
                ] })
              : null,
          ] }),

          // 说明
          jsxs('div', { style: S.hint, children: [
            jsx('div', { children: isSkill
              ? t('note.skillsTab')
              : t('note.pluginsTab') }),
            jsx('div', { children: t('note.mcp') }),
            jsx('div', { style: { ...S.mono, marginTop: '4px' }, children: data.statePath }),
          ] }),
        ] })
      } catch (e) {
        return jsx('div', { style: S.err, children: t('error.render', { unit, error: e?.message ?? e }) })
      }
    }

    function SkillsTab() {
      return jsx(Composer, { facet: 'skill' })
    }

    function PluginsTab() {
      return jsx(Composer, { facet: 'plugin' })
    }

    function slotsOf(ctx) {
      let svc
      try {
        const get = ctx?.get
        if (typeof get !== 'function') return null
        svc = get.call(ctx, 'slots')
      } catch {
        return null
      }
      if (svc && typeof svc.register === 'function' && typeof svc.inject === 'function') return svc
      return null
    }

    /**
     * 注册两个页签（**全部走官方 slot 机制，不再 patch 任何第三方插件**）。
     *
     * 为什么必须改
     *
     * 之前只有「插件组合」是这么注册的；「技能组合」走的是另一条路 ——
     * tests/patch_skills_manager.mjs 直接改 @michengai/dsh-skills-manager
     * 的 662KB bundle，把 SkillsTab 塞进"技能中心"的标签栏。
     *
     * 那条路在 **1.1.0 大版本重构时彻底断了**（三处变化）：
     *   · tab 数组去掉顿号后的空格并加了 repositories：
     *       ["user", "project", "trash"] → ["user","project","trash","repositories"]
     *   · i18n 键 scope.global → scope.user
     *   · 面板从 skillControls 变成三个函数按 scope 分支
     * 反馈的现象就是「技能插件更新后本插件的技能 UI 就没有了」。
     *
     * ⇒ 教训：**贴着别人的内部实现做字符串锚点，每次大版本必然失效**。
     *   现在改成用 DSH 官方的 settings.plugins.tab 扩展点 —— 这是
     *   skills-manager 自己挂进设置页用的同一套机制（它用 settings.section），
     *   上游重构内部代码时会保证扩展点不变。
     *
     *   设置 → 插件 → [已装插件] [插件组合] [技能组合]
     */
    function registerTab(slots) {
      slots.inject('settings.plugins.tab', () => slots.register({
        name: 'settings.plugins.tab',
        id: CC_TAB_ID,
        order: CC_TAB_ORDER,
        label: () => t('tab.plugins'),
      }, PluginsTab))
      /* 技能组合 —— 与插件组合对称，同一个 slot，靠 order 排在它后面。
       *
       * 置 __skillsTabRegistered 标志：`tests/patch_skills_manager.mjs` 会在
       *    skills-manager 里注入一个 ComposerHost（A 方案，兜底）。它读这个标志
       *    来决定"让位"—— **A/B 两套只显示一个页签，绝不重复**。
       *    互斥规则：**B（官方 slot）成功 ⇒ A 让位；B 不可用 ⇒ A 顶上**。 */
      slots.inject('settings.plugins.tab', () => slots.register({
        name: 'settings.plugins.tab',
        id: CC_SKILLS_TAB_ID,
        order: CC_SKILLS_TAB_ORDER,
        label: () => t('tab.skills'),
      }, SkillsTab))
      try { exports.__skillsTabRegistered = true } catch { /* 只读 exports 也不致命 */ }
    }

    /**
     * 通用「toolview 代理」—— 让**经中转（invoke_tool）调用**的工具
     *    也能渲染出它自己注册的卡片，**不用再逐个插件打补丁**。
     *
     * 问题
     * 卡片是按**工具调用名**注册的：
     *     ctx.slots.register({ name:'tool.call.toolview', key: <工具名> }, Card)
     * 而模型走中转时，会话流里记录的调用名是 `invoke_tool` ⇒ key 匹配不上 ⇒ 卡片静默不见
     * （实测：`@dsh-trading/client-chart` 的 K 线卡就是这么丢的）。
     *
     * 解法（读 dsh-client-ui-slots 的实现后确定的）
     * `slots.entries(slotName)` 能列出该槽**全部**注册（L172：`records.get(key)?.entries`），
     * 每条 entry 都带 `component` 与 `options.key`。于是注册一个 key = `invoke_tool` 的
     * **兜底组件**：它从本次调用的参数里取出真实工具名，再去 entries 里找那个名字的组件，
     * 找到就渲染它，找不到就返回 null（回落成普通文本块）。
     *
     * 为什么安全
     *   · key 不同（`invoke_tool` vs `market_snapshot`）⇒ 与既有注册**不冲突**
     *   · priority = -999（最低）⇒ 即便有人也想接管 `invoke_tool`，它优先
     *   · 找不到对应组件 ⇒ 返回 null ⇒ 渲染与现在**完全一致**
     *   · 整个函数 try/catch 且任何异常都只 warn ⇒ 绝不影响其它 UI
     */
    const TOOLVIEW_SLOT = 'tool.call.toolview'
    const INVOKE_TOOL_KEY = 'invoke_tool'

    /** 从组件的 props 里尽量稳地取出「本次调用传了什么参数」。 */
    function callArgsOf(props) {
      const candidates = [
        props?.args,
        props?.arguments,
        props?.call?.arguments,
        props?.call?.args,
        props?.block?.arguments,
        props?.meta?.arguments,
      ]
      for (const c of candidates) {
        if (c !== null && c !== undefined && typeof c === 'object') return c
      }
      /* 有些实现把参数放在 JSON 字符串里。 */
      return null
    }

    function InvokeToolViewProxy(props) {
      try {
        const slots = props?.__ccSlots
        if (slots === null || slots === undefined || typeof slots.entries !== 'function') return null
        const args = callArgsOf(props)
        const real = typeof args?.tool === 'string' ? args.tool.trim() : ''
        if (real === '' || real === INVOKE_TOOL_KEY) return null
        const list = slots.entries(TOOLVIEW_SLOT)
        if (!Array.isArray(list) || list.length === 0) return null
        const hit = list.find((e) => e?.options?.key === real && typeof e?.component === 'function')
        if (hit === undefined || hit === null) {
          /* 该工具没有专用卡片（绝大多数 MCP / CTP 工具都是这样）⇒ 回落成文本。 */
          return null
        }
        /* 用它自己的组件渲染，并把 toolName 换成真实名（卡片标题才对得上）。 */
        return jsx(hit.component, { ...props, toolName: real })
      } catch (error) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[capability-composer] toolview 代理渲染失败（已忽略）：' + String(error?.message ?? error))
        }
        return null
      }
    }

    /* 「通用 toolview 代理」——**已撤销**（当天 16:33）。
     *
     * 为什么撤销（本插件的设计错误，留证）：
     *   `tool.call.toolview` 是 **keyed 槽**，规则是「同一个 key 只渲染 priority 最低的那个」
     *   （`dsh-client-ui-slots` L130：按 priority 升序排；官方提示原文 "lowest renders"）。
     *   这里注册了 `key: 'invoke_tool', priority: -999` ⇒ **最低** ⇒
     *   **把 `@dsh-trading/client-chart` 那个 `key: 'invoke_tool'`（priority 0）遮蔽掉了**。
     *   而该代理本身又依赖 `inject: () => ({ __ccSlots: slots })` 能把 slots 注入 props
     *   那是**照 dsh-vision-router 猜的、没验证**。拿不到 slots ⇒ 返回 null
     *   ⇒ **卡片从此彻底不渲染**（实测：加代理前有卡片，加代理后没有）。
     *
     * ⇒ 教训：**别用"抢最低 priority"去接管一个别人已经在用的 key**；
     *   第三方卡片插件要支持中转，就让它在自己的注册里多认一个 `invoke_tool`
     *   （`client-chart` 就是这么修的，见它的 `CHART_TOOLS`）。
     */
    /* 结论：**本插件不再注册 `invoke_tool` 的 toolview。**
     *
     * 上面那条「通用代理」撤销之后，黑框的真正原因在**别处**，已在源头修掉：
     *   · `@dsh-trading/client-chart` 的 `CHART_TOOLS` 里加了 `invoke_tool`
     *     （它自己那处补丁），于是它用 `ChartCard` 接管了**所有**中转调用；
     *   · 而它的 `SHELL` 被 blackshell 补丁写死成纯黑底 ⇒ 非图表工具
     *     （pilot_act 之类）经中转也变成「黑纸白字」的原始 JSON 块。
     *   ⇒ 修法落在 client-chart 侧：图表卡继续黑底，非图表的 `Fallback`
     *     与 running 分支改用 `FALLBACK_SHELL`（跟随宿主 `--dsw-alias-*` 令牌）。
     *
     * 所以本插件**绝不能**再注册 `key: 'invoke_tool'`：keyed 槽一个 key 只有一个
     *   cell（"lowest renders"），这里一注册就会把 client-chart 的图表卡遮蔽掉，
     *   让「经中转的 K 线卡」彻底不渲染 —— 那正是撤销代理时踩过的坑。
     *   本函数保留为空，只为不改变调用点结构。 */
    function registerToolViewProxy(_slots) {
      return
    }

    /* 探针·第①步（**纯读，零副作用**）：
       列出 `tool.call.toolview` 槽上**实际注册**的全部 key，挂到已有的 `/state` 请求
       query 上带给宿主（宿主只打一行日志）。
       为什么不在宿主侧静态扫源码：`client-chart` 写的是 `CHART_TOOLS.map(key => …)`，
       工具名来自变量 ⇒ 扫不到。**只有客户端运行时的注册表是真相。**
       **本函数不写文件、不改注册、不影响任何渲染。** */
    function probeToolViewKeysOnce() {
      try {
        const slots = slotsOf(HOST)
        if (slots === null || typeof slots.entries !== 'function') return
        const list = slots.entries(TOOLVIEW_SLOT)
        if (!Array.isArray(list) || list.length === 0) return
        const keys = list
          .map((entry) => entry?.options?.key)
          .filter((key) => typeof key === 'string' && key.length > 0)
        if (keys.length === 0) return
        try {
          fetch(CC_API + '/state?_probeKeys=' + encodeURIComponent(keys.join(','))).catch(() => {})
        } catch { /* ignore */ }
      } catch { /* 探针绝不抛 */ }
    }

    function apply(ctx) {
      try {
        HOST = ctx
        /* Copy follows the interface language; the returned disposer is the
           MutationObserver path, so cordis tears it down with the plugin. */
        ctx.effect(() => languageWatcher(ctx), 'dsh-capability-composer: interface language')
        /* 预热：客户端半边一挂上就先把 `/state` 取回来（不碰 UI）。
           以前只有面板挂载才发这次请求，于是"点开的那一刻"永远正好是宿主最忙的
           那一刻；预热把这段等待挪到界面看不见的地方。失败无所谓（面板自己会重试）。 */
        try { prefetchStateOnce() } catch { /* 预热失败绝不影响注册 */ }
        const attempt = (triesLeft) => {
          const slots = slotsOf(ctx)
          if (slots !== null) {
            try {
              registerTab(slots)
            } catch (error) {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('[capability-composer] 注册页签失败（已忽略）：' + String(error?.message ?? error))
              }
            }
            /* 顺带挂上「toolview 通用代理」——
               让经中转（invoke_tool）调用、且自己注册了卡片的工具也能渲染出卡片，
               不必再逐个插件打补丁。失败不影响页签，也不影响任何既有渲染。 */
            try {
              registerToolViewProxy(slots)
            } catch (error) {
              if (typeof console !== 'undefined' && console.warn) {
                console.warn('[capability-composer] toolview 代理挂载失败（已忽略）：' + String(error?.message ?? error))
              }
            }
            return
          }
          if (triesLeft <= 0) return
          setTimeout(() => { try { attempt(triesLeft - 1) } catch { /* 放弃 */ } }, 400)
        }
        attempt(15)
        /* 探针·第①步：等其它插件（如 client-chart）把 toolview 槽注册完，
           再读一次注册表并上报（只打日志）。延迟 4s 是给"晚挂载的插件"留时间。 */
        try {
          setTimeout(() => { try { probeToolViewKeysOnce() } catch { /* ignore */ } }, 4000)
        } catch { /* ignore */ }
      } catch (error) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[capability-composer] apply 异常已吞掉：' + String(error?.message ?? error))
        }
      }
    }

    exports.apply = apply
    exports.inject = composerInject
    /* 立即把组件挂到 window —— 跨插件取组件的唯一可靠方式（见 publishGlobal 注释）。 */
    exports.__global = publishGlobal()
    /**
     * 关键：**跨 bundle 不能用别人的 createElement**。
     *
     * tests/patch_skills_manager.mjs 会把「组合技能」页塞进技能中心的页签栏，
     * 原先它写的是 `se(Tab, null)` —— `se` 是 **skills-manager bundle 自己的**
     * createElement（`se = po.createElement`，po 是它那份 react）。
     * 而 SkillsTab 用的是**本 bundle 的 react**。
     * 两个 React 实例不共享 ⇒ React 认不出元素类型 ⇒ 页面**一片空白**
     * （反馈的正是这个：点「组合技能」进去什么都不显示）。
     *
     * ⇒ 正确做法：由**元素所属的那个 bundle**（就是这里）用**自己的**
     *   createElement 把 React 元素造好，再把工厂函数交出去。
     *   对方的 `se(mod.SkillsTabHost(), null)` 只负责"调用"，不碰元素构造。
     */
    exports.SkillsTabHost = function SkillsTabHost() {
      /* **props 不能传 null**。
         react/jsx-runtime 的 jsx(type, props) 内部会立刻读 props.key / props.ref，
         传 null 就抛 `TypeError: Cannot read properties of null (reading 'key')`。
         空对象才是"无 props"的正确写法。 */
      return jsx(SkillsTab, {})
    }

    /**
     * 全局挂载点—— **跨插件取组件的唯一可靠方式**。
     *
     * 为什么需要：tests/patch_skills_manager.mjs 注入的 ComposerHost 原本用
     * `require("dsh-capability-composer")` 取本插件，但 skills-manager 那个 bundle
     * 的 require **只认识它自己声明的依赖**（实测返回空），于是页面上打出：
     *     【诊断】require(dsh-capability-composer) 返回空 —— …
     *
     * ⇒ 改成走 window：本插件主动把组件挂到全局，对方的插件 bundle 直接读，
     *   完全不经过任何模块加载器。这是插件间通信最稳的一条路。
     *
     * 只挂**纯函数**（组件本身 / 元素工厂），不挂状态、不挂 ctx，
     * 避免两个 bundle 之间产生生命周期耦合。
     */
    function publishGlobal() {
      const bag = {
        version: '0.3.0',
        SkillsTab,
        PluginsTab,
        ComposerTab: SkillsTab,
        SkillsTabHost: function SkillsTabHost() {
          return jsx(SkillsTab, {})
        },
        PluginsTabHost: function PluginsTabHost() {
          return jsx(PluginsTab, {})
        },
      }
      try {
        if (typeof window !== 'undefined') {
          window.__DSH_CAPABILITY_COMPOSER__ = bag
        }
        if (typeof globalThis !== 'undefined') {
          globalThis.__DSH_CAPABILITY_COMPOSER__ = bag
        }
      } catch { /* 无 window 环境（离线测试）不影响插件本身 */ }
      return bag
    }
    /**
     * 「技能组合」页是否已由**官方 slot**（B 方案）注册成功。
     *
     * tests/patch_skills_manager.mjs 注入的 ComposerHost（A 方案）读这个值：
     *   true  ⇒ B 已生效 ⇒ A **不渲染**（否则设置页会出现两个"技能组合"）；
     *   false ⇒ B 不可用（slot 服务拿不到 / 注册失败）⇒ A 顶上。
     */
    exports.__skillsTabRegistered = false
    exports.SkillsTab = SkillsTab
    exports.PluginsTab = PluginsTab
    /** 兼容别名 —— **等于 `SkillsTab`，不是插件页**（技能中心那个旧补丁取的就是它）。 */
    exports.ComposerTab = SkillsTab
    /**
     * 离线测试钩子。
     *
     * `tests/test_composer_loading_cache.mjs` 按 `dsh-client-modules` 的装载约定在 Node 里
     * 用一个假 `window` / 假 `require` 把这个 bundle 跑起来，直接测"跨重启缓存"和
     * "带超时重试的 GET"这两条 —— 它们正是「面板永远停在正在读取…」的修复本体。
     * 只暴露纯函数与两个状态袋，不涉及 React 渲染。
     */
    exports.__debug = {
      lsRead,
      lsWrite,
      stateCacheKey,
      fetchJsonWithRetry,
      prefetchStateOnce,
      PERSIST,
      STATE_FETCH_STAMP,
      SKILL_CACHE_KEY,
      LS_PREFIX,
    }
    return module.exports
  },
})
