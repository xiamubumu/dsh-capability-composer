/**
 * 把 dsh-capability-composer 按 **DSH Desktop 自己的方式**装进 web profile。
 *
 * 为什么不再用 Junction（`link:` 指向源码目录）
 * ---------------------------------------------------------------
 * Junction + package.json 里那行 `link:` 只是"看起来装上了"：DSH 每次启动都会用
 * **自己的注册表**（`profiles/.generations/desired.json`）重写 profile 清单
 * （`projectGenerations()`），凡是它不认识的字段都会被**静默丢掉**。实测过一次：
 * 重启后 link 与依赖项一起消失，插件整个不可见，日志里一行都没有。
 * 而且 Junction 指向工作区 ⇒ 换电脑/移动目录就断，DSH 的备份/sweep/更新也管不到它。
 *
 * 正确做法（与 dsh-composer-launcher 完全一致，已在真机跑通并跨重启验证）：
 *   1. 把插件文件**复制**成一份 generation 实体：
 *        profiles/.generations/live/<插件>+<版本>+<内容哈希>/node_modules/<插件>/
 *   2. 写 `generation.json`（注册表靠它认领这代是谁的）+ generation 自己的 package.json；
 *   3. 把这一代的 id 写进 `desired.json`（**权威指针**，不是 package.json）；
 *   4. 调用 DSH 官方的 `projectGenerations()` 去写 profile 清单的四个字段：
 *        dependencies / dsh.profile.bundles / pnpm.overrides / dsh.desktop.generationProjection
 *      —— 官方代码写的字段，重启才不会被覆盖。
 *
 * 代价（必须知道）：从此**工作区里的改动不会自动生效**，改完要重跑一次本脚本
 * （`node install.mjs`，或 `install.ps1`）。
 *
 * 用法：node install.mjs
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/* 位置无关：HERE 由文件自身推出。 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * DSH 主目录 —— 自适应：`DSH_HOME` → 各平台约定位置。
 *
 * 换机器纪律：这个文件里**不允许**出现任何盘符、用户名或
 * 固定安装位置。原来写的是 `join(process.env.APPDATA, ...)`，在 macOS / Linux 上
 * 会算出一个不存在的目录，然后 install 会去那里建 generation —— 报错还很难懂。
 * @returns {string}
 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = homedir()
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'dsh-desktop', 'harness')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'dsh-desktop', 'harness')
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'dsh-desktop', 'harness')
}

/**
 * DSH Desktop 的 app 根（那个含 `node_modules\dsh-desktop-market-installer` 的目录）。
 *
 * 换机器纪律：**不允许写死安装位置**。顺序：
 *   ① `DSH_APP_ROOT`（`install.ps1` 会先解析好并导出，最可靠）
 *   ② 从当前 node 可执行文件 / 脚本位置逐级上溯（在 app 内部运行时命中）
 *   ③ 各平台常见安装位置
 *   ④ Windows：按盘符扫 `<盘>:\DSH Desktop\resources\app`（26 次 stat，代价可忽略）
 * @returns {string|undefined}
 */
function resolveAppRoot() {
  const seen = new Set()
  const probe = (dir) => {
    if (typeof dir !== 'string' || dir === '' || seen.has(dir)) return undefined
    seen.add(dir)
    return existsSync(join(dir, 'node_modules', 'dsh-desktop-market-installer')) ? dir : undefined
  }

  const fromEnv = probe(process.env.DSH_APP_ROOT)
  if (fromEnv !== undefined) return fromEnv

  for (const start of [process.execPath, process.argv[1]]) {
    if (typeof start !== 'string' || start === '') continue
    let dir = dirname(start)
    for (let depth = 0; depth < 8; depth += 1) {
      const hit = probe(dir) ?? probe(join(dir, 'resources', 'app'))
      if (hit !== undefined) return hit
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  const home = homedir()
  const roots = [
    join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs'),
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    '/Applications',
    join(home, 'Applications'),
    join(home, '.local', 'share'),
  ].filter((root) => typeof root === 'string' && root !== '')
  for (const root of roots) {
    const hit = probe(join(root, 'DSH Desktop', 'resources', 'app'))
      ?? probe(join(root, 'dsh-desktop', 'resources', 'app'))
      ?? probe(join(root, 'DSH Desktop'))
    if (hit !== undefined) return hit
  }

  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const hit = probe(join(String.fromCharCode(code) + ':\\', 'DSH Desktop', 'resources', 'app'))
      if (hit !== undefined) return hit
    }
  }
  return undefined
}

const HARNESS = resolveDshHome()
const APP_ROOT = resolveAppRoot()
if (APP_ROOT === undefined) {
  console.error('FAILED: 找不到 DSH Desktop 安装目录（含 node_modules\\dsh-desktop-market-installer 的那层）。')
  console.error('        手工指定：先设 DSH_APP_ROOT=<安装目录>\\resources\\app，再重跑本脚本。')
  process.exit(2)
}
const LIVE = join(HARNESS, 'profiles', '.generations', 'live')
const DESIRED = join(HARNESS, 'profiles', '.generations', 'desired.json')
const PROFILE = join(HARNESS, 'profiles', 'web')
const INSTALLER = join(APP_ROOT, 'node_modules', 'dsh-desktop-market-installer', 'generations', 'projection.mjs')

const PLUGIN = 'dsh-capability-composer'
const VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail === undefined ? '' : '  -> ' + detail))
}

/* ---- 0. 前置检查 -------------------------------------------------------- */
if (!existsSync(HARNESS)) {
  console.error('FAILED: DSH_HOME not found: ' + HARNESS)
  process.exit(2)
}
check('源码在工作区', existsSync(join(HERE, 'lib', 'index.js')) && existsSync(join(HERE, 'lib', 'client.js')))

/* ---- 1. 复制成 generation 实体 ------------------------------------------ */
/* 内容哈希：插件任何一半变了就换一代（旧的留在 live/ 里，DSH 自己清理）。 */
const digest = createHash('sha256')
for (const rel of ['package.json', 'cordis.patch.yml', join('lib', 'index.js'), join('lib', 'client.js')]) {
  digest.update(readFileSync(join(HERE, rel)))
}
const hash = digest.digest('hex').slice(0, 12)
const generationId = PLUGIN + '+' + VERSION + '+' + hash
const genDir = join(LIVE, generationId)
const pkgDir = join(genDir, 'node_modules', PLUGIN)

mkdirSync(join(pkgDir, 'lib'), { recursive: true })
mkdirSync(join(pkgDir, 'seed'), { recursive: true })
copyFileSync(join(HERE, 'package.json'), join(pkgDir, 'package.json'))
copyFileSync(join(HERE, 'cordis.patch.yml'), join(pkgDir, 'cordis.patch.yml'))
for (const rel of ['index.js', 'client.js']) {
  copyFileSync(join(HERE, 'lib', rel), join(pkgDir, 'lib', rel))
}
for (const name of readdirSync(join(HERE, 'seed'))) {
  if (!statSync(join(HERE, 'seed', name)).isFile()) continue
  copyFileSync(join(HERE, 'seed', name), join(pkgDir, 'seed', name))
}

/* 注册表读这个文件来认领这一代；pluginName / version 的格式校验不过会让
   resolveEnabledGenerations() 抛错 —— 那是会直接把 DSH 启动搞挂的。 */
writeFileSync(join(genDir, 'generation.json'),
  JSON.stringify({ pluginName: PLUGIN, version: VERSION }, undefined, 2) + '\n', 'utf8')
writeFileSync(join(genDir, 'package.json'),
  JSON.stringify({ name: 'dsh-generation', private: true, version: '0.0.0', dependencies: { [PLUGIN]: VERSION } }, undefined, 2) + '\n',
  'utf8')

console.log('stage : ' + generationId)
check('generation.json written', existsSync(join(genDir, 'generation.json')))
check('两半代码都复制进去了',
  existsSync(join(pkgDir, 'lib', 'index.js')) && existsSync(join(pkgDir, 'lib', 'client.js')),
  'index.js + client.js')

/* ---- 2. 写 desired.json（权威指针） ------------------------------------- */
if (!existsSync(DESIRED)) {
  console.error('FAILED: ' + DESIRED + ' not found — refusing to create it from scratch')
  process.exit(1)
}
copyFileSync(DESIRED, DESIRED + '.bak-before-capability-composer')

const desired = JSON.parse(readFileSync(DESIRED, 'utf8'))
const before = desired.length
const next = desired.filter((id) => !String(id).startsWith(PLUGIN + '+'))
next.push(generationId)
writeFileSync(DESIRED, JSON.stringify(next, undefined, 2) + '\n', 'utf8')

const reread = JSON.parse(readFileSync(DESIRED, 'utf8'))
check('desired.json 里只有这一代', reread.filter((id) => String(id).startsWith(PLUGIN + '+')).length === 1,
  before + ' -> ' + reread.length + ' entries')

/* ---- 3. 让 DSH 官方 projector 写 profile 清单 --------------------------- */
const { projectGenerations } = await import(pathToFileURL(INSTALLER).href)
const result = await projectGenerations(HARNESS, 'web')

check('projector 认领了这个插件', result.linked.includes(PLUGIN),
  'linked=' + result.linked.length + ' unlinked=' + JSON.stringify(result.unlinked))

/* ---- 4. 核对官方写出来的四个字段 + 链接 --------------------------------- */
const manifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
const projection = manifest.dsh?.desktop?.generationProjection?.plugins ?? {}
check('dependencies', manifest.dependencies[PLUGIN] !== undefined, String(manifest.dependencies[PLUGIN]))
check('dsh.profile.bundles', manifest.dsh.profile.bundles.includes(PLUGIN))
check('pnpm.overrides', manifest.pnpm?.overrides?.[PLUGIN] !== undefined, String(manifest.pnpm?.overrides?.[PLUGIN]))
check('generationProjection', projection[PLUGIN] !== undefined, JSON.stringify(projection[PLUGIN] ?? null))
check('projection.generationId 与刚建的这一代一致', projection[PLUGIN]?.generationId === generationId,
  String(projection[PLUGIN]?.generationId))

const link = join(PROFILE, 'node_modules', PLUGIN)
check('node_modules 里的链接存在', existsSync(link))

/* ---- 5. 从 profile 里真 import 一次宿主半边（装歪了这里就会炸） --------- */
try {
  const mod = await import(pathToFileURL(join(link, 'lib', 'index.js')).href + '?v=' + Date.now())
  check('宿主半边能从 profile 里 import', mod.name === PLUGIN && typeof mod.apply === 'function',
    'name=' + mod.name + ' inject=' + JSON.stringify(mod.inject))
} catch (error) {
  check('宿主半边能从 profile 里 import', false, String(error?.message ?? error))
}

console.log('')
console.log(failures === 0
  ? 'ALL CHECKS PASSED — 重启 DSH 后生效（工作区改动以后都要重跑本脚本）'
  : failures + ' CHECK(S) FAILED — 先别重启')
process.exit(failures === 0 ? 0 : 1)
