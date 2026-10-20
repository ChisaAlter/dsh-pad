# dsh-pad

[![GitHub release](https://img.shields.io/github/v/release/ChisaAlter/dsh-pad?display_name=tag&sort=semver)](https://github.com/ChisaAlter/dsh-pad/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的右侧悬浮面板插件。面板由 AI 在对话里生成：比如「做一个观察这台服务器性能的面板」「做一个面板显示我的 DeepSeek API 余额」。

- **悬浮坞**：右侧一个可拖动的胶囊，点开是面板列表。宽屏下展开时会给对话区让出位置，不会挡住输入框；可以拖左边缘调宽度，拖标题栏整体上下移动，拖上、下边缘调整整体高度（收起后胶囊停在同一个高度，位置记在浏览器里）。
- **AI 生成**：模型通过 `pad_*` 工具创建和修改面板。面板是跑在沙箱 iframe 里的 HTML / CSS / JS，颜色跟随 dsh 的亮色 / 暗色主题。
- **自由平铺**：把一张卡片拖到另一张上，两张自动并排、默认各占一半；中间分隔条拖动调比例，一行最多 3 张。不会再出现自由定位的重叠和大段空隙。
- **自动检查更新**：启动后在后台查 GitHub 最新 Release（默认每 6 小时）；有新版本时坞顶下载图标出现圆点，点开即可更新，重启 dsh 生效。开发目录安装只提示、不覆盖源码。
- **两种取数方式**
  - **直接数据源**：在本机跑 shell 命令，或者从本机请求 HTTP 接口，按秒级间隔刷新，不消耗 token。适合服务器性能、套餐余额这类接口数据。
  - **AI 刷新**：按间隔在后台跑一轮 agent，让它重新取数后提交。适合只能靠搜索、读网页、多步推理才拿得到的数据。
- **面板内模型**：面板里的按钮可以调用 `dsh.run(prompt)`，用这张面板自己的模型跑一次并把结果显示在卡片里；也支持 AI 刷新用同一模型。
- **安全**：新建或修改数据源时，会弹 dsh 自带的审批（「允许一次 / 拒绝」）。拒绝后，面板上会留一个「允许运行」按钮。密钥用 `{{env:NAME}}` 引用，只在宿主侧解析，不会发到浏览器。

面板模型参考了 [ChisaBot](https://github.com/ChisaAlter/ChisaBot) 的两种面板：沙箱 HTML 自定义面板，以及机器人定时刷新的实时面板。

## 安装

需要 dsh ≥ 0.2.1-rc.2，用 Web 界面（`dsh web`）或鲸屿桌面端。

插件以 **bundle** 方式登记（写进 profile 的 `dsh.profile.bundles`）。**不要**把本仓库 `cordis.patch.yml` 的内容手抄进 profile 的 `cordis.patch.yml`：那里没有对应的模块解析，启动时整个应用会起不来。

```sh
# 先自检：lib/ 是否齐全、profile 里有没有残留
node scripts/doctor.mjs

# 从本地目录（开发时）
dsh plugin --profile web add /path/to/dsh-pad

# 从 GitHub（仓库里带着构建好的 lib/，不需要跑构建脚本）
dsh plugin --profile web add github:ChisaAlter/dsh-pad#4f7515b18eb0263db4eeb83928ea02a7a0fa5fdb
```

`lib/index.js` 与 `lib/client.js` 是唯一的运行入口，本仓库把它们提交进 git，就是为了让 GitHub 安装不依赖构建脚本（pnpm 会默认拒绝执行依赖的构建脚本）。改了源码就先在插件目录跑 `npm install && npm run build`，再安装。

装好后重启 `dsh web` / 鲸屿。卸载：`dsh plugin --profile web remove dsh-pad`。

## 更新

插件启动后会在后台检查 [GitHub Release](https://github.com/ChisaAlter/dsh-pad/releases)（默认每 6 小时，启动约 7 秒后第一次）。有新版本时：

1. 面板坞顶部的下载图标出现圆点；
2. 点开，看到当前版本和新版本，点「更新」；
3. 插件从 Release 下载构建好的 `lib/index.js`、`lib/client.js`、`package.json` 和 `cordis.patch.yml`，先备份到 `.dsh-pad-update-backup/`；
4. 重启 `dsh web` / 鲸屿后生效。

如果当前是**开发目录链接**安装（插件目录里有 `.git/`），自动更新只提示新版本，不会覆盖源码；请在插件目录执行 `git pull && npm run build`。更新面板里的「重新检查」可以立即查一次；关闭后台检查设 `updateCheck: false`。

### 装坏了怎么恢复

装上之后如果鲸屿或 `dsh web` 起不来：

1. 打开 `$DSH_HOME/profiles/web/package.json`，从 `dsh.profile.bundles` 里删掉 `"dsh-pad"`，并从 `dependencies` 里删掉 `"dsh-pad"`。
2. 打开 `$DSH_HOME/profiles/web/cordis.patch.yml`，删掉任何 `insert` 了 `dsh-pad` 的条目（正常情况下这里不该出现它）。
3. 删掉 `$DSH_HOME/profiles/web/node_modules/dsh-pad`（它只是一个链接）。
4. 重新启动。
5. 再装之前先跑 `node scripts/doctor.mjs`，它会直接指出是 `lib/` 缺失、链接缺失，还是 profile 补丁被手写了。

## 使用

直接在对话里说想要什么面板：

> 做一个观察这台服务器性能的面板：CPU、内存、磁盘、负载，每 3 秒刷新
>
> 做一个面板显示我的 DeepSeek API 余额，key 在环境变量 DEEPSEEK_API_KEY 里
>
> 做一个面板盯着 deepseek-ai/deepseek-harness 的最新 release，每 6 小时让 AI 更新一次

面板坞顶部的 **＋** 会把一段「用 `pad_create` 创建自定义面板」的提示词插入当前对话输入框（不会自动发送），接着写你的需求再发送即可。新面板出现时，面板坞会自动展开并高亮这张卡片。

每张卡片的 **⋯** 菜单里有：「让 AI 修改…」（把修改请求填进输入框）、撤销上次修改、面板模型、删除。点卡片标题可以折叠；折叠后的面板不再轮询。

每张卡片左上角的 **六点握把** 可以拖到另一张卡片上：放下后两张卡片变成同一行、默认各占一半；一行最多 3 张。把卡片拖到同一行的另一张卡片上可以换位置；拖到面板坞空白处可以拆回单独一行。行里的竖分隔条可以拖动，调整相邻两张卡片的宽度比例；新面板单独成行，排在底部。

每张卡片底部有一条细横条：上下拖动可以调整面板高度，双击恢复自动高度；高度按面板记在浏览器里（localStorage），重启后仍然有效。

面板坞本身：拖标题栏整体上下移动，拖上边缘或下边缘调整整体高度（面板列表在内部滚动，双击边缘恢复自动高度，高度也记在浏览器里），拖左边缘调宽度。顶部的 **＋** 用来创建新面板。

`examples/` 下有三份完整的面板定义（服务器性能、DeepSeek 余额、GitHub release），可以当作模型输出的参考。

## 面板是怎么工作的

一张面板的定义：

```jsonc
{
  "title": "服务器性能",
  "icon": "🖥️",
  "html": "…", "css": "…", "script": "…",
  "height": "auto",                    // 或固定像素
  "sources": [                         // 直接数据源，可以为空
    { "id": "host", "kind": "command", "command": "…", "parse": "json", "intervalSec": 3 },
    { "id": "bal", "kind": "http", "url": "https://api.deepseek.com/user/balance",
      "headers": { "Authorization": "Bearer {{env:DEEPSEEK_API_KEY}}" }, "parse": "json", "intervalSec": 600 }
  ],
  "model": { "provider": "magpie", "model": "codex/gpt-6.1-sol" },  // 可选：这张面板用的模型
  "agent": { "instruction": "…", "everyMinutes": 360 }   // 可选：AI 刷新
}
```

- **直接数据源**只在面板坞展开、卡片没折叠时才轮询；关掉浏览器或收起成胶囊后宿主上就不再跑。命令输出上限 512KB，默认超时 10 秒。
- **密钥**：`{{env:NAME}}` 先从 dsh 凭据服务里解析，没有再读宿主进程的环境变量。错误信息里出现的密钥值会被替换成 `***`。
- **AI 刷新**：后台 agent 默认使用 dsh 的默认模型和默认 agent 预设（有 web_fetch / web_search 等工具），另外只多两个工具：`pad_submit_data` 和 `pad_report_failure`。面板可以带顶层 `model`（`{ provider, model, reasoningEffort? }`）单独指定模型；不写就跟随全局默认。这个模型同时用于面板里的 `dsh.run`。卡片 ⋯ 菜单里的「面板模型」可以直接切换。它只看得到 `instruction` 和上一次提交的数据。单轮最长 5 分钟（可配置），失败后过一段时间重试，原因会显示在卡片上。
- **面板脚本**在 `sandbox="allow-scripts"` 的 iframe 里运行：不和 dsh 同源，CSP 是 `default-src 'none'`，没有网络，拿不到 cookie 和存储，也访问不到父页面。唯一的出口是 `window.dsh`：

| API | 说明 |
|---|---|
| `dsh.onData(fn)` | 有数据时立即调用，之后每次更新再调用。`data = { sources: { [id]: { ok, value, error, at } }, agent: { value, at } \| null }` |
| `dsh.history(id)` | 该数据源最近 120 次成功读数（页面打开期间累积），画趋势用 |
| `dsh.refresh()` / `dsh.openUrl(url)` / `dsh.ask(text)` | 立即刷新 / 新标签打开链接 / 把一句话填进对话输入框 |
| `dsh.run(prompt, { system? })` | 用这张面板的模型跑一次，返回 `{ ok, text?, error? }`；纯文本生成，没有工具和网络，适合按钮处理当前数据 |
| `dsh.state.get(k)` / `dsh.state.set(k, v)` | 按面板保存的小量 UI 状态 |
| `dsh.fmt.*` | `bytes` `percent` `number` `ago` `time` `duration` |
| `dsh.chart.*` | `sparkline` `bar` `ring`，返回 SVG / HTML 字符串 |
| `dsh.tone(x)` / `dsh.escape(s)` | 按阈值给出 ok / warn / danger 颜色 / HTML 转义 |

`dsh.run` 只做一次纯文本生成：prompt 最长 2.4 万字，结果最多 3.2 万字，默认 120 秒超时、2048 输出 token；模型来自面板顶层 `model`，没有就跟随全局默认。它不会调用工具；要联网取数，先用直接数据源或 AI 刷新把数据放进面板，再交给 `dsh.run` 处理。`dsh.ask` 仍然是把话交给主对话，不是面板模型。

主题变量：`--pad-fg` `--pad-fg-2` `--pad-fg-3` `--pad-bg` `--pad-bg-2` `--pad-border` `--pad-accent` `--pad-ok` `--pad-warn` `--pad-danger` `--pad-font` `--pad-mono` `--pad-radius`。

给模型的完整编写指南在 `src/host/guide.ts`，作为 `pad_create` 工具说明的一部分发给模型。

## 模型可用的工具

| 工具 | 作用 |
|---|---|
| `pad_list` / `pad_get` | 列出面板 / 读完整定义和最新数据 |
| `pad_test_source` | 试跑一个数据源（需要审批），先看清输出格式再写脚本 |
| `pad_create` / `pad_update` | 新建 / 修改（只传要改的字段）；数据源变了才重新审批 |
| `pad_models` | 列出可用于面板的 provider / 模型 / 推理强度，以及全局默认模型 |
| `pad_refresh` | 立即刷新，并返回读数，修好面板后用来验证 |
| `pad_delete` | 删除 |

## 配置

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里覆盖（patch 会替换整个 `config`，写全需要的键）：

```yaml
- id: dsh-pad
  name: dsh-pad
  config:
    autoApprove: false
    minIntervalSec: 2
```

| 键 | 默认 | 说明 |
|---|---|---|
| `dataFile` | `$DSH_HOME/dsh-pad/panels.json` | 面板存储位置 |
| `autoApprove` | `false` | 新建 / 修改数据源时不再询问 |
| `minIntervalSec` | `2` | 直接数据源最短刷新间隔（秒） |
| `agentRefresh` | `true` | 是否允许 AI 刷新的面板 |
| `minAgentMinutes` | `15` | AI 刷新最短间隔（分钟） |
| `agentTimeoutSec` | `300` | 单轮 AI 刷新的最长时间 |
| `agentConcurrency` | `1` | 同时进行的 AI 刷新数量 |
| `agentRetryMinutes` | `15` | AI 刷新失败后的重试间隔 |
| `interactiveModel` | `true` | 是否允许面板按钮通过 `dsh.run` 调用面板模型 |
| `runTimeoutSec` | `120` | 一次 `dsh.run` 的最长时间（秒） |
| `runMaxTokens` | `2048` | 一次 `dsh.run` 最多生成多少 token |
| `runConcurrency` | `2` | 同一张面板同时进行的 `dsh.run` 数量 |
| `updateCheck` | `true` | 后台检查 GitHub 最新 Release |
| `updateCheckHours` | `6` | 自动检查间隔（小时，1–168） |

## 数据与已知限制

- 面板存在 `$DSH_HOME/dsh-pad/panels.json`；面板坞的宽度、位置、行分组/分隔比例和展开状态按浏览器存在 localStorage。
- 每次 AI 刷新都是一个独立的 dsh 会话，工作目录是 `$DSH_HOME/dsh-pad/refresh`。dsh 目前不提供删除会话的接口，所以这些会话日志会留在 `$DSH_HOME/sessions/` 下对应这个目录的子目录里（每轮大约十几 KB）。它们不会出现在侧栏，需要清理时手动删除即可。
- 后台刷新的 agent 没有人在线审批，所以需要审批的工具调用（比如 workspace-write 模式下的 shell 命令）会被拒绝。AI 刷新适合用 web_fetch / web_search 取数；本机命令请用直接数据源。
- 在 dsh 0.2.1-rc.2 的 Web 界面（`dsh web`）与鲸屿桌面端上验证过：安装后宿主半激活、8 个 `pad_*` 工具注册、六个 `/api/dsh-pad.*` 路由可用，客户端面板坞在无头 Chrome 中渲染无异常。dsh 的插件 API 还在快速变化。悬浮坞挂在 dsh 的 `shell.overlay` 槽位；宽屏让位依赖外框上的 `data-rightbar-collapsed` 属性，dsh 以后改了这个属性也只是退化成纯悬浮，不会坏。

## 开发

```sh
npm install
npm run build      # lib/index.js（宿主半）+ lib/client.js（浏览器半，dsh 的闭包模块格式）
npm run watch
npm run typecheck
npm test
npm run doctor     # 安装前后自检：lib/、exports、profile 登记与残留补丁
```

```
src/
  index.ts            宿主插件入口：配置、存储、调度、路由、工具
  host/
    store.ts          面板存储（JSON 文件、撤销、审批指纹）
    sources.ts        命令 / HTTP 数据源执行、密钥填充与脱敏
    hub.ts            按订阅轮询，向浏览器推送 SSE
    agent-refresh.ts  后台 AI 刷新
    models.ts         模型目录与选择校验
    run.ts            面板内 dsh.run 的一次性模型调用
    update.ts         检查 GitHub Release，按点击下载替换 lib/
    tools.ts          pad_* 工具
    guide.ts          给模型的编写指南
    routes.ts         /api/dsh-pad.{panels,stream,action,models,run,update}（经 dsh Connection 认证）
  client/
    index.ts          浏览器插件入口：shell.overlay 悬浮坞 + 输入框桥接
    Dock.tsx          胶囊 / 面板坞
    PanelCard.tsx     卡片
    PanelFrame.tsx    沙箱 iframe
    frame-runtime.ts  iframe 内的 window.dsh
    pad-client.ts     SSE 连接、历史、布局
  shared/             两半共用的类型与校验
examples/             面板定义示例
tests/                单元测试（vitest）
```

## 致谢

感谢 [Linux.do](https://linux.do)（L 站）社区的支持、讨论和反馈，也感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 [ChisaBot](https://github.com/ChisaAlter/ChisaBot) 在面板形态上的启发。

## 许可

MIT
