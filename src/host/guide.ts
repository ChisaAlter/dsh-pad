/**
 * Authoring guidance for the model: when to make a panel, how the sandbox
 * works, and the `dsh` runtime API inside the panel iframe.
 */

export const PANEL_GUIDE = `## 悬浮面板（dsh-pad）

用户想长期盯着某个会变的东西（服务器性能、套餐余额、价格、构建状态、倒计时……），或者说「做个面板 / 看板 / 小组件」时，用 pad_* 工具在悬浮面板里做一张面板，不要只在对话里回答。

### 流程
1. 先想清楚这张面板回答哪一个问题，只放回答它需要的数据。
2. 选数据怎么来：
   - **直接数据源**（首选，秒级刷新，不耗 token）：\`command\` 在用户本机跑 shell 命令；\`http\` 从本机请求接口。
     先用 pad_test_source 试跑，看清真实输出格式再写脚本。输出尽量让命令本身整理好（jq、awk、--json 参数），parse 选 json / lines / text。
     密钥不要写进面板：写成 \`{{env:变量名}}\`（可用在 url、headers、body），值由宿主从凭据或环境变量里取，浏览器拿不到。没配置时告诉用户要设置哪个变量。
   - **AI 刷新**（数据只能靠搜索 / 读网页 / 多步推理得到时）：给 \`agent: { instruction, everyMinutes }\`。后台会按间隔跑一轮无人值守的 agent，它只看得到 instruction 和上一次的数据，所以 instruction 里写清楚：取什么、去哪里取（具体网址或接口）、提交的数据结构。
     顶层 \`model\`（\`{ provider, model, reasoningEffort? }\`）是这张面板自己的模型：AI 刷新和面板里的 \`dsh.run\` 都用它；不传则跟随全局默认。先调 \`pad_models\` 看当前可用的 provider/model。用户想用便宜/快的模型盯简单数据、或指定强模型做复杂整理时用它。
     创建时你自己先取一次真实数据，用 \`data\` 参数交上第一版，结构要和以后刷新一致。
3. 写 html / css / script（见下方运行环境），pad_create。结果里有每个数据源的首次读数，检查有没有报错；有问题用 pad_update 修。
4. 对话里一句话说做好了、多久刷新一次。要改已有面板先 pad_list 找到它再 pad_update，不要新建重复的。

### 运行环境（沙箱 iframe）
- 宽约 200–400px 的窄卡片（用户可以拖卡片到别的卡片的上/下/左/右边缘分出嵌套区域、拖分隔条调比例；不要假设固定列数），按窄卡设计：一屏看完，少字多数字，不放大标题（卡片头已经有标题和图标）。
- 无网络、无同源权限：不能 fetch、不能加载外部脚本 / 字体 / 图片（只能 data: 图片 / 内联 SVG）。数据只从 \`dsh\` 来。
- 可用 CSS 变量（自动跟随亮 / 暗主题）：--pad-fg, --pad-fg-2, --pad-fg-3, --pad-bg, --pad-bg-2, --pad-border, --pad-accent, --pad-ok, --pad-warn, --pad-danger, --pad-font, --pad-mono, --pad-radius。不要写死颜色。
- 全局对象 \`dsh\`：
  - \`dsh.onData(fn)\`：fn(data) 在有数据时立即调用，之后每次更新再调用。data = \`{ sources: { [id]: { ok, value, error, at } }, agent: { value, at } | null }\`。
  - \`dsh.history(sourceId)\`：该数据源最近 120 次成功读数 \`[{ value, at }]\`（面板打开期间累积），画趋势用。
  - \`dsh.refresh()\`：立即刷新。\`dsh.openUrl(url)\`：在新标签打开链接（iframe 里普通链接打不开）。
  - \`dsh.state.get(key)\` / \`dsh.state.set(key, value)\`：按面板保存的小量 UI 状态（例如选中的标签页）。
  - \`dsh.ask(text)\`：把一句话填进对话输入框（例如「帮我分析一下这台机器为什么负载高」）。
  - \`dsh.run(prompt, { system? })\`：用**这张面板的模型**跑一次、返回 \`{ ok, text?, error? }\`。适合在面板里放一个按钮，让模型处理当前数据并显示结果。一次调用只做纯文本生成，没有工具、没有网络；需要网页数据先用直接数据源或 AI 刷新型面板把数据拿进来。prompt 建议不超过 2 万字，调用时禁用按钮、显示「分析中…」，拿到结果再用 \`textContent\` 显示。\`dsh.ask\` 仍然是把话交给主对话，不是面板模型。
    \`\`\`js
    var btn = document.getElementById('go'), out = document.getElementById('out');
    btn.onclick = async function () {
      btn.disabled = true; out.textContent = '分析中…';
      var r = await dsh.run('把下面的数据总结成三行：\\n' + JSON.stringify(dsh.data.sources.metric.value));
      out.textContent = r.ok ? r.text : r.error;
      btn.disabled = false;
    };
    \`\`\`
  - 工具函数：\`dsh.fmt.bytes(n)\`、\`dsh.fmt.percent(x, digits)\`（x 是 0–1）、\`dsh.fmt.number(n, digits)\`、\`dsh.fmt.ago(isoTime)\`、\`dsh.fmt.time(isoTime)\`、\`dsh.fmt.duration(seconds)\`、\`dsh.escape(text)\`（HTML 转义）、\`dsh.tone(fraction, warnAt=0.7, dangerAt=0.9)\`（返回 ok / warn / danger 颜色变量）。
  - 画图：\`dsh.chart.sparkline(numbers, { width, height, color, fill, min, max })\`、\`dsh.chart.bar(fraction, { color, height })\`、\`dsh.chart.ring(fraction, { size, stroke, color, label })\`，都返回 SVG / HTML 字符串，配合 innerHTML 使用；不传 color 时按 dsh.tone 自动着色。
- 脚本在 html 之后执行；渲染要能处理「还没有数据」「数据源报错」两种情况（显示 — 和错误原因）。
- 用 \`textContent\` 或自己转义后再拼 HTML，不要把外部字符串直接塞进 innerHTML。
`
