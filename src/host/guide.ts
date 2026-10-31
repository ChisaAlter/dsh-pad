/**
 * Authoring guidance for the model: when to make a panel, how a panel is laid
 * out, the `pad-*` kit, complete recipes, the `dsh` runtime API inside the
 * panel iframe, and how data gets in.
 *
 * `PANEL_GUIDE` rides in the `pad_create` tool description, so it stays short
 * and spends its words on the decisions that go wrong. The rest is served by
 * the `pad_guide` tool, on demand.
 *
 * The design contract here is deliberately strict. A panel lives in a 200–400px
 * card that the user glances at, and the failure mode this file exists to stop
 * is the model pasting prose or raw JSON into it.
 */

const F = '```'

/** Short form, embedded in the pad_create / pad_update tool description. */
export const PANEL_GUIDE = `## 悬浮面板（dsh-pad）

用户想长期盯着某个会变的东西（服务器性能、套餐余额、价格、构建状态、倒计时……），或者说「做个面板 / 看板 / 小组件」时，用 pad_* 工具在悬浮面板里做一张面板，不要只在对话里回答。

写之前先调 pad_guide，拿版式手册（topic: layout / recipes / kit / api / data / check，默认全部）。面板是 200–400px 的窄卡片，用户是「扫一眼」不是「读一段」：一张面板只回答一个问题，主数字或主状态占最大字号，其余用行、条、点表示。

### 硬规则（lint 会退回）
- 静态可见文字 > 150 字、单段 > 90 字、把 JSON / 代码块贴到卡片上、只有文字没有任何可视元素——直接退回重写。
- 写死颜色、全大写 + 加字距的标签、脚本不处理取数失败、emoji 当图标、一屏超过 4 个数字——警告。
- 用户明确只要一张文字卡片（便签、引用、说明）时才传 plain: true 跳过检查。

### 设计目标（比 lint 更严，做到才好看）
- 可见文案 ≤ 40 字，任何一段文字 ≤ 24 字。不要把解释、步骤、结论、报告写进面板。
- 最多 4 个数字，只有一个主数字（≥ 24px）；标签 11px 次要色、句子大小写、不加字距、不全大写。
- 颜色只用 --pad-* 令牌；强调色只有一个；状态用圆点 + 词（.pad-status），不用 emoji 当图标。
- 不要卡片套卡片、不要紫蓝渐变、不要居中大段文字。
- 空数据、加载中、数据源失败三种状态都要处理。
- 优先用 kit 的 pad-* 类（.pad-metric / .pad-item / .pad-list / .pad-meter / .pad-status / .pad-spark / .pad-stack）和 dsh.ui.* 生成器，不要自己发明一套间距、字号和颜色。

### 数据
- **直接数据源**（首选，秒级刷新，不耗 token）：command 在本机跑命令，http 从本机请求接口。先用 pad_test_source 试跑看清真实输出，parse 选 json / lines / text；能让命令自己整理好的（jq、--json）就别在脚本里解析。密钥写 {{env:NAME}}，不要写进面板。建好就自动开始跑，不需要用户点任何按钮。
- **AI 刷新**（数据只能靠搜索 / 读网页 / 多步推理时）：给 agent: { instruction, everyMinutes }。后台按间隔跑一轮无人值守的 agent，它只看得到 instruction 和上一次的数据，所以 instruction 里写清楚：取什么、去哪里取、提交的数据结构。顶层 model 是这张面板自己的模型，先调 pad_models 看可选值。创建时自己先取一次真实数据，用 data 交第一版。
- 两种可以并存：接口给数字，AI 补一句解读。

### 流程
1. pad_guide 选版式 → 2. pad_test_source 试数据 → 3. pad_create（html / css / script）→ 4. 看返回的排版检查（lint）和首次读数，有问题 pad_update 改到通过 → 5. 对话里一句话说做好了、多久刷新一次。
要改已有面板先 pad_list 找到它再 pad_update。同名面板不会重复创建；确实想要并排两张时给新面板换个标题。`

const LAYOUT = `# 版式：先选一个，再写 HTML

先回答「这张面板回答哪一个问题」，再从下面挑一个版式。挑不出来说明需求还太散，先收窄。
五个版式覆盖了绝大多数面板；不要发明第六个。

## 1. 单值 + 趋势（最常用）
一个数字就是面板的全部。适合 CPU、内存、余额、价格、延时、倒计时。
骨架：label（是什么）→ 主数字 + 单位（多大）→ foot（什么时候/相比什么）→ spark（怎么变过来的）。
不要给它加标题、说明段落或「概览」二字。

## 2. 排行 / 分布
4–7 行，每行 name 在左、数字在右、细条在下。适合 top N、磁盘、队列、按服务分组、按模型分账。
超过 6 行就截断，末尾写「其余 N 项」；不要塞滚动条。

## 3. 状态板
3–6 个 dot + 词 + 一个次要数值，两列排。适合服务健康、构建、任务、备份。
只有真实状态才配圆点；不要用装饰性的小绿点。

## 4. 额度 / 配额
剩余或已用一个主数字 + 一个环/条 + 一句「什么时候用完」。适合余额、配额、存储、试用期。
环比数字更大时把环放在右侧，不要上下堆两张卡。

## 5. 动态
3–5 条，每条一行标题 + 一行时间或来源。适合 release、提交、告警、工单。
纯列表要有信息差（版本号、时间、状态），不要做成「日志墙」。

## 文案纪律
- 标题已经是这张面板的名字，面板里不要再写一遍。
- 标签是「还剩」「在线」「本月」，不是「当前账户余额百分比」。
- 不要 eyebrow：不要在标题上面再放一行小字。
- 不要句尾的总结、建议、下一步——那些放在对话里说。
- 一个面板里相同的句式只出现一次。`

const KIT = `# kit：每个面板自带的设计原语

面板 iframe 里已经注入了下面这些类，直接用，不要再写一套。所有颜色都来自 --pad-* 令牌，亮色/暗色自动跟随。

## 排版
- .pad-stack 竖向堆叠（间距 14px）；加 .is-tight 变 7px
- .pad-split 左右两端对齐的一行
- .pad-grid 自适应两列/多列（用于 3–4 个并排指标）
- .pad-sep 一条分隔线
- .pad-label 11px 次要色标签
- .pad-title 12px 半粗小标题
- .pad-text 12.5px 正文（最多两句）
- .pad-figure 15px 数字
- .pad-num 等宽数字（tabular）

## 数字
- .pad-metric 一组指标（label + 值 + foot）；.pad-hero 只要一个数、放到最大（倒计时、余额、价格）
- .pad-metric-value 主数字 24px 起（.is-sm / .is-lg 调档）
- .pad-unit 单位（12px 次要色）
- .pad-foot 11px 脚注
- .pad-delta + .is-up / .is-down / .is-flat 涨跌

## 行与条
- .pad-list / .pad-item / .pad-item-name / .pad-item-value / .pad-item-foot
- .pad-meter（3px 细条）/ .pad-bar（7px），里面放 <i style="width:40%"></i>
- .pad-meter.is-ok / .is-warn / .is-danger 按阈值换色
- .pad-spark / .pad-chart 包住 svg，自动铺满宽度

## 状态
- .pad-status + .is-ok / .is-warn / .is-danger / .is-live（圆点 + 词）
- .pad-chip 小胶囊标签
- .pad-action 小按钮（记得 :focus-visible 已经处理好）
- .pad-empty 空态/等待
- .pad-alert 失败状态（左侧红条）

## 颜色令牌
--pad-fg（主文字）--pad-fg-2（次要）--pad-fg-3（标签）--pad-bg-2（淡底）--pad-border（发丝线）--pad-accent（强调，只有一个）--pad-ok / --pad-warn / --pad-danger（状态）--pad-font --pad-mono --pad-radius

## 尺寸
label 11px · 正文 12.5px · 数字 15px · 主数字 24–34px · 块间距 14px · 行内边距 8px。
写死别的数值之前先问：这一屏真的需要它吗。`

const RECIPES = `# 配方：整套可直接改的 html + script

每个配方都是完整可跑的。把数据源的 id 换掉、字段名换成你试跑看到的真实字段，就能用。
脚本统一用 var，兼容性最好；` + F + ` 里的注释不用抄。

## 1 单值 + 趋势
${F}html
<div class="pad-stack">
  <div class="pad-metric">
    <span class="pad-label">CPU</span>
    <span class="pad-metric-value" id="value">—</span>
    <span class="pad-foot" id="foot"></span>
  </div>
  <div class="pad-spark" id="spark"></div>
</div>
${F}
${F}js
var el = function (id) { return document.getElementById(id) }
dsh.onData(function (data) {
  var r = data.sources.usage
  if (!r || !r.ok) {
    el('value').textContent = '—'
    el('value').style.color = ''
    el('foot').textContent = r && r.error ? r.error : '等待数据'
    el('spark').innerHTML = ''
    return
  }
  var frac = r.value.percent / 100
  el('value').innerHTML = dsh.fmt.number(frac * 100, 1) + '<span class="pad-unit">%</span>'
  el('value').style.color = dsh.tone(frac)
  el('foot').textContent = '更新于 ' + dsh.fmt.ago(r.at)
  el('spark').innerHTML = dsh.chart.sparkline(dsh.history('usage').map(function (p) {
    return p.value.percent
  }), { width: 260, height: 28, min: 0, max: 100 })
})
${F}

## 2 排行 / 分布
${F}html
<div class="pad-stack is-tight">
  <div class="pad-split">
    <span class="pad-title">磁盘占用</span>
    <span class="pad-foot" id="total"></span>
  </div>
  <div class="pad-list" id="rows"></div>
</div>
${F}
${F}js
var rows = document.getElementById('rows')
dsh.onData(function (data) {
  var r = data.sources.disks
  if (!r || !r.ok) {
    rows.innerHTML = '<p class="pad-empty">' + dsh.escape(r && r.error || '等待数据') + '</p>'
    return
  }
  var list = r.value.slice().sort(function (a, b) { return b.used - a.used })
  var shown = list.slice(0, 5)
  rows.innerHTML = shown.map(function (d) {
    var f = d.total ? d.used / d.total : 0
    var tone = f > 0.9 ? 'is-danger' : f > 0.75 ? 'is-warn' : 'is-ok'
    return '<div class="pad-item">' +
      '<span class="pad-item-name">' + dsh.escape(d.mount) + '</span>' +
      '<span class="pad-item-value">' + dsh.fmt.bytes(d.used) + '</span>' +
      '<span class="pad-meter ' + tone + '"><i style="width:' + (f * 100).toFixed(1) + '%"></i></span>' +
    '</div>'
  }).join('')
  document.getElementById('total').textContent = list.length > shown.length ? '其余 ' + (list.length - shown.length) + ' 项' : ''
})
${F}

## 3 状态板
${F}html
<div class="pad-stack is-tight">
  <div class="pad-grid" id="grid"></div>
  <p class="pad-foot" id="note"></p>
</div>
${F}
${F}js
dsh.onData(function (data) {
  var r = data.sources.services
  var grid = document.getElementById('grid')
  if (!r || !r.ok) {
    grid.innerHTML = '<p class="pad-empty">' + dsh.escape(r && r.error || '等待数据') + '</p>'
    return
  }
  var down = 0
  grid.innerHTML = r.value.map(function (s) {
    if (!s.up) down += 1
    var tone = s.up ? (s.latency > 800 ? 'is-warn' : 'is-ok') : 'is-danger'
    return '<div class="pad-metric">' +
      '<span class="pad-status ' + tone + '">' + dsh.escape(s.name) + '</span>' +
      '<span class="pad-figure">' + (s.up ? s.latency + ' ms' : '不可用') + '</span>' +
    '</div>'
  }).join('')
  document.getElementById('note').textContent = down === 0 ? '全部在线' : down + ' 个不可用'
})
${F}

## 4 额度 / 配额
${F}html
<div class="pad-stack">
  <div class="pad-split">
    <div class="pad-metric">
      <span class="pad-label">剩余额度</span>
      <span class="pad-metric-value" id="left">—</span>
      <span class="pad-foot" id="used"></span>
    </div>
    <div id="ring"></div>
  </div>
  <p class="pad-foot" id="note"></p>
</div>
${F}
${F}js
var el = function (id) { return document.getElementById(id) }
dsh.onData(function (data) {
  var r = data.sources.balance
  if (!r || !r.ok) {
    el('left').textContent = '—'
    el('used').textContent = r && r.error ? r.error : '等待数据'
    el('note').textContent = ''
    el('ring').innerHTML = ''
    return
  }
  var used = r.value.total ? r.value.spent / r.value.total : 0
  el('left').innerHTML = '¥' + (r.value.total - r.value.spent).toFixed(2)
  el('used').textContent = '已用 ' + dsh.fmt.percent(used)
  el('ring').innerHTML = dsh.chart.ring(used, { size: 56, stroke: 5 })
  el('note').textContent = '更新于 ' + dsh.fmt.ago(r.at)
})
${F}

## 共同点
- 每个分支都处理了 r.ok === false。
- 每张面板只有一个主数字或一个主视图。
- 数据是 map 出来的行，不是拼好的一段话。
- 外部文本一律 dsh.escape。`

const DATA = `# 数据：两种来源

## 直接数据源（首选）
秒级刷新，不耗 token，读数在宿主侧执行。

- command：在本机跑 shell 命令。让命令自己把输出整理好（jq、awk、--json、--format json），面板脚本只负责取字段。
- http：从本机请求接口。headers 里可以放 {{env:NAME}}，值由宿主凭据或环境变量提供，浏览器拿不到。
- parse：json 解析 / lines 按行拆成数组 / text 原文。
- intervalSec：面板打开时的刷新间隔。耗资源的命令不要低于 10 秒。
- 写脚本之前一定先 pad_test_source 跑一次，看清真实结构、字段名和量级。别照着文档猜。

## AI 刷新
数据只能靠搜索、读网页或多步推理才能拿到时用。

- agent: { instruction, everyMinutes }。instruction 写清楚：取什么、去哪里取（具体网址或接口）、提交什么结构的 JSON。
- 后台刷新看不到这次对话，只看得到 instruction 和上一次的数据，所以别在 instruction 里写「按刚才说的」。
- 创建时先自己取一次真实数据，用 data 交第一版，结构和以后刷新的一致，面板渲染逻辑就不用改。
- model: { provider, model, reasoningEffort? } 是这张面板自己的模型，AI 刷新和面板里的 dsh.run 都用它；不传跟随全局默认。
- 两种可以并存：接口给数字，AI 补一句两行的解读。

## 不需要用户点任何按钮
数据源建好就自动开始跑，用户不需要点任何按钮，也不需要手动刷新；面板每轮取数后自己重画。
需要一次强制刷新时才调用 dsh.refresh()。`

const API = `# 面板运行环境

- 沙箱 iframe：无网络、无同源权限，不能 fetch、不能加载外部脚本/字体/图片（只能 data: 图片或内联 SVG）。数据只从 dsh 来。
- 宽度 200–400px（用户可以拖卡片分栏，别假设固定列数），默认高度跟随内容；自动高度建议控制在 320px 内。
- html 在 css 之后、script 之前渲染；脚本拿到数据就能画。
- 用 textContent 或先 dsh.escape 再拼 innerHTML；不要把外部字符串直接塞进 innerHTML。

## dsh 对象
- dsh.data 当前数据快照。
- dsh.onData(fn) 有数据立刻调一次，之后每次更新再调；返回取消订阅函数。
  data = { sources: { [id]: { ok, value, error, at } }, agent: { value, at } | null }
- dsh.history(id) 该数据源最近 120 次成功读数 [{ value, at }]，画趋势用（dsh 重启后先带上缓存点）。
- dsh.refresh() 立即刷新。dsh.openUrl(url) 新标签打开链接。
- dsh.state.get(key) / dsh.state.set(key, value) 面板自己的小量 UI 状态（例如选中的时间范围）。
- dsh.ask(text) 把一句话填进对话输入框。
- dsh.run(prompt, { system }) 用这张面板的模型跑一次，返回 { ok, text, error }。只做纯文本生成，没有工具、没有网络。按钮里用：禁用按钮、显示「分析中…」、拿到结果再显示。
- dsh.tone(fraction, warnAt = 0.7, dangerAt = 0.9) 按占用返回 --pad-ok / --pad-warn / --pad-danger。
- dsh.escape(text) HTML 转义。

## dsh.fmt
bytes(n) · percent(x, digits)（x 是 0–1）· number(n, digits) · ago(iso) · time(iso) · duration(seconds)

## dsh.ui（返回 HTML 字符串，配 innerHTML 用）
- dsh.ui.metric({ label, value, unit, foot, tone }) 一条指标
- dsh.ui.item({ name, value, foot, meter, tone }) 一行（meter 传 0–1 会画细条）
- dsh.ui.list(items) 一叠行，items 是上面的对象数组
- dsh.ui.status(label, tone) 圆点 + 词，tone 是 ok / warn / danger / live
- dsh.ui.chip(text, tone) 小胶囊标签，tone 同上
- dsh.ui.empty(text) 空态；dsh.ui.alert(text) 失败状态
例：el.innerHTML = dsh.ui.metric({ label: '在线', value: '12', unit: '台', foot: '3 分钟前' })

## dsh.chart（返回 SVG 字符串）
- sparkline(values, { width, height, color, fill, min, max })
- bar(fraction, { color, height })
- ring(fraction, { size, stroke, color, label })`

const CHECK = `# 提交前的自检

pad_create / pad_update 会返回「排版检查」。error 直接退回，必须改；warn 建议改。

- 文字墙：静态可见文字超过 150 字，或者一段文字超过 90 字 → 删掉解释，改成数字、行或图。
- 数据倾倒：面板里出现 pre / code，或者三处以上 JSON 的键值引号 → 只留决策需要的那几个字段。
- 没有视觉锚点：静态文字超过 60 字，却没有 pad-* 数字/列表/状态、SVG、表格或 dsh.chart / dsh.ui → 补一个主数字或一行数据。
- 写死颜色：css 里出现 #hex 或 rgb() → 换成 --pad-* 令牌，否则暗色模式下会糊。
- 全大写 / 加字距的标签（eyebrow）→ 去掉 text-transform 和 letter-spacing。
- 没处理失败：脚本里没有 .ok / error / catch → 失败时会白屏或报错。
- 开头的 emoji 图标 → 换成 .pad-status 状态点或 .pad-chip 文字。
- 一屏超过 4 个 pad-metric → 只留 1–2 个，其余收进 pad-item 行。

检查只看 html 里的静态文字，但脚本拼出来的句子一样占位置：一句 40 字以上的说明写进 innerHTML，卡片一样没法扫。别靠「放在脚本里」绕过去。

最后问自己一句：用户扫一眼，能不能拿到那个数？不能就重做，别加字。`

/** One manual section per topic key. */
const SECTIONS: Readonly<Record<string, string>> = {
  layout: LAYOUT,
  kit: KIT,
  recipes: RECIPES,
  data: DATA,
  api: API,
  check: CHECK,
}

/** Topics `pad_guide` accepts. */
export const PANEL_TOPICS = ['layout', 'kit', 'recipes', 'data', 'api', 'check'] as const
export type PanelTopic = typeof PANEL_TOPICS[number] | 'all'

const ORDER: readonly string[] = ['layout', 'kit', 'recipes', 'data', 'api', 'check']

/**
 * The full authoring manual, or one section of it.
 * @param topic - a section key, or `all` (the default) for the whole manual.
 * @returns markdown text, ready to hand back as a tool result.
 */
export function panelManual(topic: PanelTopic = 'all'): string {
  if (topic === 'all') return ORDER.map(key => SECTIONS[key]).join('\n\n')
  const section = SECTIONS[topic]
  return section ?? ORDER.map(key => SECTIONS[key]).join('\n\n')
}
