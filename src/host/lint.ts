/**
 * Deterministic authoring lint: does a generated panel read as a card at a
 * glance, or is it text dumped into a box?
 *
 * Pure and synchronous — no I/O, no configuration, no network. The Host half
 * prints these issues next to `pad_create` / `pad_update` output: an `error`
 * means the panel should be rewritten, a `warn` is advice. Messages are Chinese
 * and always name the concrete fix; rule ids are stable API.
 */

import { PANEL_KIT_VISUALS } from '../shared/kit.ts'
import type { PanelDefinition } from '../shared/types.ts'

export type LintSeverity = 'error' | 'warn'

/** One rule violation, addressed to the model that wrote the panel. */
export interface LintIssue {
  readonly rule: string
  readonly severity: LintSeverity
  readonly message: string
}

/** The part of a panel definition the lint reads. */
export type LintTarget = Pick<PanelDefinition, 'html' | 'css' | 'script'>

/** Static copy above this many characters cannot be read in one glance. */
const TEXT_WALL = 150
/** A single text run above this is a paragraph, not a card line. */
const PROSE = 90
/** Shorter text-only panels still fit on one card. */
const ANCHOR_TEXT = 60
/** More numbers than this and none of them stands out. */
const MAX_METRICS = 4
/** Letter spacing (in em) that reads as tracked caps. */
const TRACKED_CAPS = 0.04

/** Tags that split text into separate runs; inline tags (b, span, …) do not. */
const BLOCK_TAGS = 'address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul'

const BLOCK_BREAK = new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi')
/** Comments and blocks whose body is never visible in the card. */
const HIDDEN = /<!--[\s\S]*?-->|<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi
const INLINE_TAG = /<[^>]*>/g

/** SVG, media and form elements that show something on their own. */
const ANCHOR_MARKUP = /<(?:svg|canvas|table|ul|ol|meter|progress|input|button|img)(?=[\s/>])/
/** Kit helpers for charts and small UI pieces. */
const ANCHOR_API = /dsh\.(?:chart|ui)\./

/**
 * An emoji glyph: default-presentation emoji, or a pictograph with the emoji
 * variation selector. Plain arrows and ©/™ stay text.
 */
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u

/** A hex colour, or the name of a functional colour, written into CSS. */
const HEX_COLOUR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/i
const FUNCTIONAL_COLOUR = /\b(?:rgba?|hsla?)\(/i

/**
 * The visible text of `html` split into runs: comments and script/style bodies
 * dropped, block tags break a run, inline tags vanish, whitespace collapses.
 */
function splitTextRuns(html: string): string[] {
  return html
    .replace(HIDDEN, ' ')
    .replace(BLOCK_BREAK, '\u0000')
    .split('\u0000')
    .map((run) => run.replace(INLINE_TAG, '').replace(/\s+/g, ' ').trim())
    .filter((run) => run !== '')
}

/** The longest single run, in characters — a dumped paragraph is one run. */
function longestRun(runs: readonly string[]): number {
  return runs.reduce((longest, run) => Math.max(longest, [...run].length), 0)
}

/**
 * Whether the panel shows anything besides text: a kit visual class, an SVG or
 * table, or a chart/UI helper. A class with a `-value` suffix still counts, so
 * one big figure is enough.
 */
function hasAnchor(html: string, script: string): boolean {
  return PANEL_KIT_VISUALS.some((name) => html.includes(name))
    || ANCHOR_MARKUP.test(html.toLowerCase())
    || ANCHOR_API.test(`${html}\n${script}`.toLowerCase())
}

/** How often `name` appears as a class token, so `pad-metric` ignores `pad-metric-value`. */
function countClass(html: string, name: string): number {
  return html.match(new RegExp(`${name}(?![\\w-])`, 'g'))?.length ?? 0
}

/** CSS with every whole `var(…)` removed, so a token fallback is not a hardcoded colour. */
function stripVarFallbacks(css: string): string {
  let bare = css
  let previous: string
  do {
    previous = bare
    bare = previous.replace(/var\([^()]*\)/gi, '')
  } while (bare !== previous)
  return bare
}

/** The first colour literal in `css`, or null when every colour is a token. */
function hardcodedColour(css: string): string | null {
  const bare = stripVarFallbacks(css)
  const hex = HEX_COLOUR.exec(bare)?.[0]
  if (hex !== undefined) return hex
  const functional = FUNCTIONAL_COLOUR.exec(bare)?.[0]
  return functional === undefined ? null : `${functional.replace(/\($/, '')}()`
}

/** The tracked-caps tells in `css`: uppercase labels, or letter spacing above .04em. */
function trackedCaps(css: string): string[] {
  const tells: string[] = []
  if (/text-transform\s*:\s*uppercase\b/i.test(css)) tells.push('text-transform:uppercase')
  const spacing = /\bletter-spacing\s*:\s*(-?[\d.]+)\s*(?:em|rem)\b/gi
  for (const match of css.matchAll(spacing)) {
    if (Math.abs(Number(match[1] ?? 0)) > TRACKED_CAPS) {
      tells.push(match[0].replace(/\s+/g, ''))
      break
    }
  }
  return tells
}

/** Whether the script could show a failed source instead of throwing or blanking. */
function mentionsFailure(script: string): boolean {
  return /\.ok\b/.test(script) || /\berror\b/i.test(script) || /\bcatch\b/.test(script)
}

/** The emoji the card opens with, if any; only the first 40 characters are scanned. */
function leadingEmoji(text: string): string | null {
  return [...text].slice(0, 40).join('').match(EMOJI)?.[0] ?? null
}

/** Whether the card carries a code block: a `pre`, or a `code` holding a payload. */
function hasCodeBlock(html: string): boolean {
  if (/<pre(?=[\s/>])/i.test(html)) return true
  for (const match of html.matchAll(/<code(?=[\s>])[^>]*>([\s\S]*?)<\/code>/gi)) {
    const text = (match[1] ?? '').replace(/<[^>]*>/g, '')
    // A version number or a command name in an inline code is fine; a blob is not.
    if (text.length > 80 || text.includes('\n')) return true
  }
  return false
}

/**
 * Lint one panel definition. Pure and synchronous: the same definition always
 * yields the same issues, errors first. Errors make the card unreadable at a
 * glance; warnings are reported but do not block.
 */
export function lintPanel(panel: LintTarget): LintIssue[] {
  const { html, css, script } = panel
  const runs = splitTextRuns(html)
  const text = runs.join(' ')
  const length = [...text].length
  const longest = longestRun(runs)
  const issues: LintIssue[] = []

  if (length > TEXT_WALL) {
    issues.push({
      rule: 'text-wall',
      severity: 'error',
      message: `静态文字 ${length} 字，卡片一屏放不下：留下 2–3 个数字/状态，其余改写成 pad-item 列表或直接删掉`,
    })
  }

  if (longest > PROSE) {
    issues.push({
      rule: 'prose',
      severity: 'error',
      message: `有一段 ${longest} 字的长段落：压到 ${PROSE} 字以内，或拆成 pad-label 短句加 pad-item 行`,
    })
  }

  const pairs = html.split('":').length - 1
  if (hasCodeBlock(html) || pairs >= 3) {
    issues.push({
      rule: 'data-dump',
      severity: 'error',
      message: '卡片里贴了 JSON 或代码块：让脚本把字段拆进 pad-metric 和 pad-item，原始数据不要上屏',
    })
  }

  if (length > ANCHOR_TEXT && !hasAnchor(html, script)) {
    issues.push({
      rule: 'no-anchor',
      severity: 'error',
      message: `静态文字 ${length} 字，却没有数字、列表或进度：用 pad-metric 放主数字、pad-item 排行、pad-meter 表达进度`,
    })
  }

  const colour = hardcodedColour(css)
  if (colour !== null) {
    issues.push({
      rule: 'hardcoded-color',
      severity: 'warn',
      message: `样式里写死了颜色 ${colour}：改用 var(--pad-fg-2)、var(--pad-accent) 等 --pad-* 变量，深色模式才跟得上`,
    })
  }

  const caps = trackedCaps(css)
  if (caps.length > 0) {
    issues.push({
      rule: 'tracked-caps',
      severity: 'warn',
      message: `标签用了 ${caps.join(' 和 ')}：换成 pad-label 的常规大小写、默认字距，层级交给字重和颜色`,
    })
  }

  if (script.trim() !== '' && !mentionsFailure(script)) {
    issues.push({
      rule: 'no-error-state',
      severity: 'warn',
      message: '脚本没有失败分支：先判断 sources[id].ok，失败就把 error 放进一张 pad-alert，别让面板空着或直接抛错',
    })
  }

  const glyph = leadingEmoji(text)
  if (glyph !== null) {
    issues.push({
      rule: 'emoji-icon',
      severity: 'warn',
      message: `卡片开头用 ${glyph} 当图标：换成 pad-status 状态点或 pad-chip 文字，emoji 只留在面板标题里`,
    })
  }

  const metrics = countClass(html, 'pad-metric')
  if (metrics > MAX_METRICS) {
    issues.push({
      rule: 'many-metrics',
      severity: 'warn',
      message: `卡片里有 ${metrics} 个 pad-metric 数字：只留 1–2 个最重要的，其余收进 pad-item 名值对`,
    })
  }

  return issues
}

/**
 * Render issues for tool output: one `- [error] …` / `- [warn] …` line each,
 * errors first. Returns `''` for a clean panel.
 */
export function formatLint(issues: readonly LintIssue[]): string {
  const errors = issues.filter((issue) => issue.severity === 'error')
  const warnings = issues.filter((issue) => issue.severity === 'warn')
  return [...errors, ...warnings].map((issue) => `- [${issue.severity}] ${issue.message}`).join('\n')
}
