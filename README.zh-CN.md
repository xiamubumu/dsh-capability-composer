# dsh-capability-composer

**把常驻工具面收成几个组合，系统提示按需缩小。**

> ⚠️ **只支持 DSH 1.5**（`>=0.1.5-rc.2 <0.2.0`）。DSH 出新版本会跟进更新。

[English](README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-1.5-4c6ef5.svg)](#兼容性)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#兼容性)

**缩小模型看到的东西，而不是缩小正在跑的东西。**

---

## 目录

- [这是什么](#这是什么)
- [它做什么（四个机制）](#它做什么四个机制)
- [组合怎么解析（三级）](#组合怎么解析三级)
- [界面](#界面)
- [截图](#截图)
- [配置](#配置)
- [HTTP 接口](#http-接口)
- [🔗 联动](#-联动)
- [已知局限（如实说）](#已知局限如实说)
- [安装](#安装)
- [兼容性](#兼容性)
- [常见问题](#常见问题)
- [仓库结构](#仓库结构)
- [自检](#自检)
- [License](#license)

---

## 这是什么

DSH 默认把下面这些东西**全量塞进每一次请求**：

| 塞进去的东西 | 实测规模 |
|---|---|
| 所有已装插件注册的**工具 schema** | 414 个工具定义 / 约 65.6K tokens |
| 所有**技能的目录** | 约 76K tokens 打底 |
| 每个插件注册的**系统提示段** | `agent-teams:usage` ≈1296 tok + `plugin:dsh-docker` ≈579 tok + `plugin:api-client` ≈254 tok |

每一次请求都在为「你可能用到的东西」付钱，而这一轮真正用得上的可能只有其中几个。

`dsh-capability-composer` 把这几样按**「组合」**编组，**只让当前组合进上下文**。

### 它做什么 / 它不做什么

先把边界说清楚，因为这里最容易误会：

| ✅ 它做 | ❌ 它不做 |
|---|---|
| 收窄**模型看到的插件目录** | 不关闭任何插件 —— 插件进程照常跑、界面照常显示 |
| 遮蔽不在名单里的**技能目录项** | 不移除技能 —— `/技能名` 仍可手动调用 |
| 让工具**默认不常驻**（只留核心 + 元工具） | 不限制执行 —— `invoke_tool` 默认什么都能调 |
| 按组合裁掉插件注册的**系统提示段** | 不动已提交的历史 |
| 按会话 / 工作区 / 全局三级解析组合 | 不改磁盘上任何第三方插件的文件 |

一句话：**它缩小的是「模型看得见的目录」，不是「正在运行的东西」。** 插件照常运行、技能照常可用、工具照常能调 —— 变的只是每次请求里塞了多少东西。

---

## 它做什么（四个机制）

### ① 工具默认不常驻

**常驻的只有 31 个**：28 个官方核心工具，加 3 个元工具 —— `search_plugins` / `load_plugin` / `invoke_tool`。

其余工具**一律不进 tools 列表**。模型在系统提示的目录段里看到它们（段标题 `# 可用插件与 MCP 工具`），需要时直接调用：

```js
invoke_tool({ tool: "mcp__vnpy__run_backtest", args: { ... } })
```

需要整组加载时用 `load_plugin`：

```js
load_plugin({ ids: ["mcp:vnpy"] })
```

**粒度是「插件」，不是「工具名」。** 这是有意的：更细的粒度试过 —— 417 / 211 个工具名压没之后，模型根本不知道该搜什么，反而更难用。现在的粒度是插件。

挂载时会打一行日志说明：

```
工具按需加载已挂载：常驻白名单 28 个 + 元工具 3 个（其余全部按需；组合只决定可见范围）
```

### ② 技能遮蔽（不是禁用）

不在当前技能组合里的技能，会被注册一份**同名遮蔽项**：

- `invocation.modelInvocable: false` —— 不进模型能看到、能自动调用的技能目录
- `rank: 0` —— 最低 rank 者胜出，遮蔽掉原技能

**`/技能名` 仍然可以手动调用。**

全局层挂一份遮蔽项，每个 agent 再挂一份**「就近层」**，保证会话级的组合在 agent 维度也生效。

### ③ 插件组合收窄「模型的插件目录」

收窄发生在**生成目录段的时候**，不是卸载插件。

有**两条永远不会被收窄**的行：

- **MCP 服务器行** —— 每个 MCP 服务器一行，服务器里的工具不归组合管
- **「未归属工具」兜底行** —— 认不出属于哪个插件的工具，永远保留

### ④ 插件注册的系统提示段也按组合裁

插件组合**控制不了**「插件自己注册的系统提示段」—— 那是插件在 `system-prompt/assemble` 里自己塞进去的，跟目录段是两回事。

本插件的 `prunePluginSections()` 是唯一能按当前插件组合裁掉它们的地方。

实测省 **≈2129 tokens / 请求**：

| 段 | 规模 |
|---|---|
| `agent-teams:usage` | ≈1296 tok |
| `plugin:dsh-docker` | ≈579 tok |
| `plugin:api-client` | ≈254 tok |

**Fail-open 设计** —— 宁可少裁，不可误裁：

- 认不出归属的段，一律保留
- 不含命名空间的段，一律保留
- 可见插件列表为空时**不裁**，并在日志里写「没有『不在组合里』的依据，宁可留着」
- 拿不到插件列表时同样不裁

每次丢弃都会打一行证据到日志。

可用 `DSH_COMPOSER_PRUNE_PLUGIN_SECTIONS=0` 关掉。

---

## 组合怎么解析（三级）

**规则是「最近一级有指定，就用它」——不是严格覆盖。**

| 层级 | 说明 |
|---|---|
| 1. **会话级** | 当前会话单独指定 |
| 2. **工作区级** | 当前工作目录（`cwd`）指定 |
| 3. **全局** | `pinned[轴]['*']` |

几个容易踩的点：

- **空串 / 空数组 / `null` 都算「没指定」**，会继续往上继承 —— 不是「指定为空」
- **同一级可以多选**，取并集
- **空名单 = 不过滤**（不是「全不选」）。要全不选请用 `__none__`

界面里会显示当前这一级是从哪来的：『当前会话』/『当前工作区』/『全局』。

---

## 界面

装在 DSH 的 **设置 → 插件** 里，多出两个页签：

### 插件组合

决定**模型的插件目录**里出现哪些插件。

### 技能组合

决定**模型的技能目录**里出现哪些技能。可以新建组合、改名、删除（二次确认）、改系列名、删系列、全选 / 全不选、搜索技能。

### 改完立刻生效，不用重启

- 界面改动经 **400 ms 防抖**后 `POST /dsh-capability-composer/state`
- 宿主写盘后立刻刷新状态

### 保存是「按组合名逐项合并」，不是整体覆盖

以服务器状态为底，只覆盖本地草稿里**确实有的**组合名。所以别处新建的组合不会被这个界面误删。

代价是：在这里删掉的组合，如果服务器上还有，会被「复活」。**这是刻意选的保守方向** —— 丢组合比留一个多余组合代价大得多。

---

## 截图

### 技能组合页

在设置 → 插件 → 技能组合 里管理每个组合包含哪些技能，以及「这里用」作用于哪一级。

![技能组合](screenshots/01-skill-compositions.png)

### 技能作用范围

按系列组织技能组合，下拉选择当前会话 / 当前工作区 / 全局各自用哪套。

![技能作用范围](screenshots/02-skill-scope.png)

---

## 9. 官方补丁：本插件不需要打

本插件只占 `system-prompt/assemble` 与 skills 服务，**不需要给 DSH 打任何官方补丁**，所以它也不弹补丁窗 —— 补丁提示归需要补丁的那两个插件（`dsh-context-reclaim`、`dsh-aux-degrade`）。

如果你想了解那 10 条官方补丁各自做什么、要不要打，见：

- 教程《安装与官方补丁》→ `tutorial-install-and-official-patches.zh-CN.md`（本插件自带）；
- 补丁库 → <https://github.com/xiamubumu/dsh-patch-library>（10 条自包含补丁 + 自适应应用器 + 五种打法 + 现成提示词）。

## 配置

### 状态文件

**只有一个**：

```
<DSH_HOME>/capability-composer/compositions.json
```

`<DSH_HOME>` 的解析顺序：

| 平台 | 路径 |
|---|---|
| 全部 | `DSH_HOME` 环境变量（优先） |
| Windows | `%APPDATA%\dsh-desktop\harness` |
| macOS | `~/Library/Application Support/dsh-desktop/harness` |
| Linux | `$XDG_CONFIG_HOME/dsh-desktop/harness` 或 `~/.config/dsh-desktop/harness` |

**都没有就报错退出，绝不猜一个写死的路径然后静默写进去。**

每次写入前会自动备份一份 `compositions.json.bak`。

另外两个运行时文件（都是缓存，删掉会自动重建）：

| 文件 | 作用 |
|---|---|
| `capability-composer/entry-id-map.json` | 包名 → 条目 id 的缓存 |
| `.composer-resident-tools` | 常驻工具清单的自动区 |

### 首次安装是空的

新装的机器拿到的是 `defaultState()` —— 四个空档位，没有组合、没有 pin。**不随包发任何 seed，
也没有"新手包"**：那种文件里的每个组合都是别人的，新用户打开组合器不该看到自己从没建过的组合。

**用户已有的 `compositions.json` 绝不覆盖、绝不清空** —— 只有在文件不存在或读不出来时才会写一份空状态。

### 环境变量

**本插件没有 cordis config，全部通过环境变量调。**

| 变量 | 默认 | 作用 |
|---|---|---|
| `DSH_COMPOSER_MIDDLEWARE_FULL` | **开** | 执行侧完整放行（`invoke_tool` 能调到 MCP 与依赖 agent 的工具） |
| `DSH_COMPOSER_TOOL_SEARCH` | **开** | 注册 `search_plugins` 搜索器 |
| `DSH_COMPOSER_PRUNE_PLUGIN_SECTIONS` | **开** | 按组合裁插件注册的系统提示段 |
| `DSH_COMPOSER_CATALOG_FALLBACK` | **开** | 目录数据兜底来源 |
| `DSH_COMPOSER_CACHE_SAFE` | **开** | 缓存安全模式 |
| `DSH_COMPOSER_GUARD` | **开** | 防护检查 |
| `DSH_COMPOSER_DIAG` | **开** | 诊断日志 |
| `DSH_COMPOSER_AUTOLOAD_MAX` | `0` | 自动加载上限 |
| `DSH_COMPOSER_SHRINK_ENTRIES` | 关 | 目录条目瘦身 |
| `DSH_COMPOSER_HISTORY_REWRITE` | 关 | 历史重写 |
| `DSH_COMPOSER_RESIDENT_BUDGET` | — | 常驻预算 |
| `DSH_COMPOSER_RESIDENT_FILE` | — | 常驻工具清单文件 |
| `DSH_COMPOSER_EXTRA_TOOLS` | — | 额外常驻的工具 |
| `DSH_COMPOSER_RESIDENT_EXCLUDE` | — | 常驻排除名单 |
| `DSH_SEMGREP_SHORT_PATH` | `C:\dshse` | semgrep 短路径 junction（见下） |

**关于 `DSH_SEMGREP_SHORT_PATH`**：这是本插件运行时代码里**唯一一处**带默认值的绝对路径。它必须匹配市场里 semgrep 插件补丁写死的 junction 路径，否则那个补丁自愈不了。用环境变量可以覆盖；没装 semgrep 时相关函数直接返回 `not-installed`，是一段不执行的代码。

---

## HTTP 接口

前缀 `/dsh-capability-composer`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/state` | 读快照 |
| `GET` | `/skills` | 列技能 |
| `GET` | `/effective?sessionId=&cwd=` | 三级解析之后的生效名单 |
| `GET` | `/catalog` | 插件目录（给组合选择器用） |
| `POST` | `/state` | 写入状态 |

### 安全

- **非 loopback 一律 403**（`loopback only`）
- **Origin 校验不过一律 403**（`origin not allowed`）—— 不给 Origin 的本地工具放行

### `POST /state` 有一道硬闸

body 必须带 `compositions` 或 `pinned` 之一，否则 400 拒绝：

> 拒绝写入：body 必须是状态对象（或 `{state: ...}`），且至少带 compositions / pinned —— 免得一个空 body 把组合清空

**这道闸是踩坑之后加的**：曾经误 POST 一个 `{state: {…}}` 外壳，把 **9 套插件组合 + 21 套技能组合**全清了。

---

## 🔗 联动

### 与 dsh-composer-launcher

**缺了本插件，启动器不会坏。**

启动器里有一张联动表，会去探测 `GET /dsh-capability-composer/state`：

| 情况 | 启动器表现 |
|---|---|
| 探测通了 | 显示「按组合收窄 N / 共 M 已装插件」，选择器能读出组合内容 |
| 探测不通 | **静默跳过** —— 只是联动列表显示 `HTTP xxx`、插件名退回包名渲染 |

代码注释原文：「有就连，没有就静默跳过（不存在是正常状态）」。

**反过来，缺了启动器本插件也照常工作** —— 本插件完全不探测对方，是对方来探测它。

### 与 dsh-mcp-manager-ui

**本插件不管理 MCP，也不读 MCP 面板的数据。**

只有两件与 MCP 有关的事：

1. **把 MCP 面板从自己的插件目录里排除** —— `dsh-mcp-panel` / `dsh-mcp-connector` / `dsh-mcp-manager-ui` / `dshmarket` / `dsh-client-ui-settings-plugins` 以及本插件自己，都不进「受组合管理的插件」名单
2. **给每个 MCP 服务器在目录段里生成一行**（id 形如 `mcp:<server>`），模型需要时 `load_plugin({ ids: ["mcp:<server>"] })` 整组加载

**这一行永远不受组合收窄。**

界面里那句提示的原文：

> MCP 工具完全不受这里影响，归 MCP 面板自己管。

**缺了 MCP 面板什么都不发生** —— 它不在依赖里。

### 与 dsh-context-reclaim

**两个插件不互相依赖，但职责互补。**

`prunePluginSections()` 这个能力放在本插件里，是因为**插件组合控制不了插件自己注册的系统提示段** —— 那需要在一个能同时看到「当前组合」和「完整提示装配结果」的地方做，本插件正好是那个地方。

**单装本插件、不装 reclaim：一切正常**，只是工具结果不会被净化 / 有界化。

---

## 已知局限（如实说）

1. **工具归属是「扫源码字符串字面量猜」的，不是权威映射。** 所以 `/state` 里带三个诚实标注字段：`exact`（精确确定）、`uiOnly`（只在界面用到）、`scanCertain`（扫描确信度）。
2. **插件目录第一次扫描约 5 秒**，之后走 `entry-id-map.json` 缓存。
3. **不传 `purpose` 的辅助调用**会被判成 main 路由，不受降级影响。
4. **`/state` 的 `GET` 有副作用**：带 `?_probeKeys=` 时会把上报的真实 key 写进 `.composer-resident-tools` 的自动区（只写文件，重启生效）。

---

## 📚 教程

| 文档 | 讲什么 |
|---|---|
| [安装与官方补丁（中文）](tutorial-install-and-official-patches.zh-CN.md) | 四个插件怎么一起装（两条实测路线），官方补丁要不要打、怎么让**你自己的 agent** 去打 补丁本体已开源成补丁库：<https://github.com/xiamubumu/dsh-patch-library>  |
| [Install & official patches (English)](tutorial-install-and-official-patches.md) | the same, in English the patches themselves ship as a library: <https://github.com/xiamubumu/dsh-patch-library>  |

---

## 🔗 同系列

四个插件各自独立、可单装，但配在一起最省。另外三个：

- [`dsh-context-reclaim`](https://github.com/xiamubumu/dsh-context-reclaim) — 上下文回收：工具结果有界化、工具面折叠、前缀稳定化，长会话不越聊越贵
- [`dsh-aux-degrade`](https://github.com/xiamubumu/dsh-aux-degrade) — 辅助调用降级：压缩摘要 / 会话标题不再被高思考档烧光预算
- [`dsh-composer-launcher`](https://github.com/xiamubumu/dsh-composer-launcher) — 「+」启动器：一个面板统管组合 / 插件 / MCP，并引导装扩展

> 全部**只支持 DSH 1.5**，DSH 出新版本会跟进更新。需要打官方补丁的插件装好后会自己弹窗说清楚，一条不漏。

## 安装

### 从 GitHub（推荐，已在全新 `DSH_HOME` 上实测）

```bash
dsh plugin --profile web add github:xiamubumu/dsh-capability-composer
```

### 从本地 tarball（离线机器）

去 [Releases](https://github.com/xiamubumu/dsh-capability-composer/releases) 下载 `dsh-capability-composer-1.0.0.tgz`，然后：

```bash
dsh plugin --profile web add /path/to/dsh-capability-composer-1.0.0.tgz
```

### 从 DSH 插件市场 / npm（暂时还不行）

市场投稿（`awesome-dsh-plugin` 的 PR）还没提交，npm 上也还没发布 ⇒ **现在这两种方式都装不到**。

> ⚠️ **已知问题：不要拿 Release 资产的 tarball URL 直接装。**
> `dsh plugin --profile web add https://github.com/.../releases/download/v1.0.0/....tgz` 在 DSH 自带的 pnpm 10.34.5 上会失败：
> `ERR_PNPM_MISSING_TARBALL_INTEGRITY`（[pnpm#14351](https://github.com/pnpm/pnpm/issues/14351)，上游在 pnpm ≥ 12.5.1 才修好）。
> 连装第二个插件时**必然**失败 —— 请用上面的 `github:` 简写或本地 tarball 路径。

### 从本地目录

```bash
dsh plugin --profile web add /path/to/dsh-capability-composer
```

### ⚠️ 不要用 `npm install` / junction / link

本插件随包带 `install.mjs` 与 `install.ps1`，里面的注释写明了原因：

> 不走 Junction —— Junction 会被 DSH 的 `projectGenerations()` 静默丢掉字段，重启后 link 与依赖项一起消失，插件整个不可见，日志里一行都没有。

正确做法是复制成 generation 实体 + 写 `generation.json` / `desired.json` + 调官方 `projectGenerations()`。

### 装完请重启 DSH

宿主插件与补丁只在**启动时**装载。

### 装完之后，工作区里的改动不会自动生效

`install.mjs` 里写得很清楚：「从此**工作区里的改动不会自动生效**，改完要重跑一次本脚本」。

---

## 兼容性

| 项目 | 要求 |
|---|---|
| **DSH** | **1.5 系列**（`>=0.1.5-rc.2 <0.2.0`）。后续 DSH 版本会跟进更新 |
| DSH Desktop（桌面版） | ✅ |
| DSH Web（网页版） | ✅ |
| **只要是 DSH** | ✅ 都能用 |
| Windows / macOS / Linux | ✅ |
| Node | 语法层面需要 20+；**但你不需要自己装** —— DSH Desktop 自带运行时，插件加载进那个运行时 |
| 运行时依赖 | **零** |

---

## 常见问题

<details>
<summary>组合能不能「关掉」某个插件，省内存或者省 CPU？</summary>

不能。**没有任何关插件的动作。**

插件照常加载、照常运行、界面照常显示。省下的只有**上下文** —— 目录段与系统提示段变短了，每次请求少付这些 token。

</details>

<details>
<summary>组合里没选的插件，它的工具还能调吗？</summary>

能。**组合收窄的是「模型能看见的目录」，不是执行权限。**

默认 `DSH_COMPOSER_MIDDLEWARE_FULL` 是开的，执行侧不设限 —— `invoke_tool` 能调到 MCP 工具，也能调到依赖 agent 的工具。

</details>

<details>
<summary>技能没进组合，是不是就被禁用了？</summary>

不是。技能仍然注册着，只是**不进模型能自动发现的技能目录**（`modelInvocable: false`）。

**斜杠命令 `/技能名` 仍然可以手动调用。**

</details>

<details>
<summary>改了界面上的组合，要重启 DSH 吗？</summary>

不用。400 ms 防抖后自动存盘，立刻生效。

</details>

<details>
<summary>有没有配置文件可以调参数？</summary>

**没有。** 本插件不读任何 cordis config（`cordis.patch.yml` 里只有一条 5 行的 `insert`）。

所有可调项都是**环境变量**，见上面的表。

</details>

<details>
<summary>这个插件支持 MCP 管理吗？它带 MCP 面板吗？</summary>

**都不。MCP 面板不是它的。**

你在「能力 → MCP」看到的面板是**另一个插件**的界面。本插件只做两件与 MCP 有关的事：把 MCP 面板从自己的插件目录里排除、给每个 MCP 服务器在目录段里生成一行。

</details>

<details>
<summary>界面能跟着 DSH 的语言设置变吗？</summary>

**可以。** 文案放在两张表里（各 140 条），插件读宿主的 `locale` 服务，所以切换 DSH 语言界面会立刻跟着切。加第三种语言只需一次 `registerLanguage(id, table)` 调用 —— 注册表并没有写死成这两种。

</details>

<details>
<summary>工具和插件的对应关系准吗？</summary>

**是扫描猜出来的，不是权威映射。** 所以接口里带 `exact` / `uiOnly` / `scanCertain` 三个诚实标注字段。

绝大多数情况下是准的，但别把它当权威数据用。

</details>

---

## 仓库结构

```
dsh-capability-composer/
├── cordis.patch.yml        插件挂载入口（5 行）
├── package.json
├── lib/
│   ├── index.js            宿主半边：状态、HTTP 接口、目录生成、段裁剪
│   └── client.js           客户端半边：设置里那两个页签
├── install.mjs             安装脚本（不走 Junction）
├── install.ps1             Windows 用
├── screenshots/
├── verify.mjs              自检
├── README.md               英文
└── README.zh-CN.md         简体中文（本文件）
```

---

## 自检

```bash
node verify.mjs
```

零依赖、离线、不写盘。检查清单字段、入口语法、密钥残留、以及写死的绝对路径。

---

## License

MIT © 夏目 ([xiamubumu](https://github.com/xiamubumu))
