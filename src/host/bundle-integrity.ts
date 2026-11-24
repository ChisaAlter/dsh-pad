/**
 * Self-check of the host bundle's trailing build markers, shared by the entry
 * bootstrap, the update accept path, and doctor checks. host-build.mjs appends
 * a `dsh-pad-body` marker and a `dsh-pad-build` marker jointly anchored to EOF;
 * the build marker's sha256 commits to every byte before it, so a truncated or
 * hand-edited bundle fails closed.
 */
import { createHash } from 'node:crypto'

const BUILD_MARKER = /\n\/\/ dsh-pad-build:([a-f0-9]{64})\n?$/
const TRAILING_MARKERS = /\n\/\/ dsh-pad-body:([a-f0-9]{64})\n?(\n\/\/ dsh-pad-build:([a-f0-9]{64})\n?)$/
const EMBEDDED_BODY_ASSIGNMENTS = [
  /\b(?:var|const|let)\s+__dshPadHostBody\s*=\s*(?=['"])/,
  /\b(?:var|const|let)\s+root\s*=\s*fileURLToPath\([^\n]+\);?\s*\r?\n\s*(?:var|const|let)\s+body\s*=\s*(?=['"])/,
]
const HOST_ENTRY_EVALUATOR = /new Function\(\s*['"]require['"]\s*,\s*['"]module['"]\s*,\s*['"]exports['"]\s*,\s*['"]__dshPadModuleUrl['"]/

export interface HostBundleMarkers {
  readonly bodyDigest: string
  readonly buildDigest: string
  /** Byte offset in the string where `\n// dsh-pad-build:...` begins. */
  readonly buildPayloadEnd: number
  /** Offset in the string where `\n// dsh-pad-body:...` begins. */
  readonly bodyMarkerStart: number
}

/** Parse jointly EOF-anchored `dsh-pad-body` and `dsh-pad-build` markers. */
export function parseHostBundleMarkers(text: string): HostBundleMarkers | undefined {
  const match = TRAILING_MARKERS.exec(text)
  if (match === null) return undefined
  const bodyDigest = match[1]!
  const buildTail = match[2]!
  const buildDigest = match[3]!
  return {
    bodyDigest,
    buildDigest,
    buildPayloadEnd: text.length - buildTail.length,
    bodyMarkerStart: match.index,
  }
}

/** The build id recorded by the trailing marker, or undefined without one. */
export function hostBundleMarker(text: string): string | undefined {
  return BUILD_MARKER.exec(text)?.[1]
}

/** Decode a single- or double-quoted JS string literal without executing code. */
function decodeJsStringLiteral(source: string, start: number): { value: string, end: number } | undefined {
  const quote = source[start]
  if (quote !== '"' && quote !== "'") return undefined
  const parts: string[] = []
  let segmentStart = start + 1
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i]!
    if (ch === quote) {
      if (i > segmentStart) parts.push(source.slice(segmentStart, i))
      return { value: parts.join(''), end: i + 1 }
    }
    if (ch === '\n' || ch === '\r') return undefined
    if (ch !== '\\') continue
    if (i > segmentStart) parts.push(source.slice(segmentStart, i))
    i += 1
    if (i >= source.length) return undefined
    const esc = source[i]!
    switch (esc) {
      case 'n': parts.push('\n'); break
      case 'r': parts.push('\r'); break
      case 't': parts.push('\t'); break
      case 'b': parts.push('\b'); break
      case 'f': parts.push('\f'); break
      case 'v': parts.push('\v'); break
      case '0': parts.push('\0'); break
      case "'": parts.push("'"); break
      case '"': parts.push('"'); break
      case '\\': parts.push('\\'); break
      case '\r':
        if (source[i + 1] === '\n') i += 1
        break
      case '\n':
      case '\u2028':
      case '\u2029':
        break
      case 'x': {
        const hex = source.slice(i + 1, i + 3)
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined
        parts.push(String.fromCharCode(Number.parseInt(hex, 16)))
        i += 2
        break
      }
      case 'u': {
        if (source[i + 1] === '{') {
          const close = source.indexOf('}', i + 2)
          if (close < 0) return undefined
          const hex = source.slice(i + 2, close)
          if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined
          const codePoint = Number.parseInt(hex, 16)
          if (codePoint > 0x10ffff) return undefined
          parts.push(String.fromCodePoint(codePoint))
          i = close
        } else {
          const hex = source.slice(i + 1, i + 5)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined
          parts.push(String.fromCharCode(Number.parseInt(hex, 16)))
          i += 4
        }
        break
      }
      default:
        parts.push(esc)
        break
    }
    segmentStart = i + 1
  }
  return undefined
}

/** Extract the embedded CJS body literal from a host-entry wrapper, if present. */
export function extractEmbeddedHostBody(text: string): string | undefined {
  for (const pattern of EMBEDDED_BODY_ASSIGNMENTS) {
    const match = pattern.exec(text)
    if (match === null) continue
    const decoded = decodeJsStringLiteral(text, match.index + match[0].length)
    if (decoded !== undefined) return decoded.value
  }
  return undefined
}

/**
 * Reject a bundle that is not exactly what host-build produced: both markers
 * jointly anchored to EOF, the recorded sha256 covering everything before the
 * build marker, and (when an embedded host body or expected digest is present)
 * a matching `dsh-pad-body` sha256.
 * @throws {Error} with a user-facing message when the bundle fails the check.
 */
export function verifyHostBundle(text: string, expectedBodyDigest?: string): HostBundleMarkers {
  if (!BUILD_MARKER.test(text)) {
    throw new Error('宿主 bundle 缺少构建标记（dsh-pad-build），可能是不完整的 release')
  }
  const markers = parseHostBundleMarkers(text)
  if (markers === undefined) {
    throw new Error('宿主 bundle 缺少正文标记（dsh-pad-body），可能是不完整的 release')
  }
  if (createHash('sha256').update(text.slice(0, markers.buildPayloadEnd)).digest('hex') !== markers.buildDigest) {
    throw new Error('宿主 bundle 的自校验哈希不匹配，可能被截断或篡改')
  }
  if (expectedBodyDigest !== undefined && markers.bodyDigest !== expectedBodyDigest) {
    throw new Error('宿主 bundle 的正文标记（dsh-pad-body）不匹配')
  }
  const embedded = extractEmbeddedHostBody(text)
  if (embedded !== undefined) {
    const actualBodyDigest = createHash('sha256').update(embedded).digest('hex')
    if (actualBodyDigest !== markers.bodyDigest) {
      throw new Error('宿主 bundle 的正文标记（dsh-pad-body）与内嵌正文哈希不匹配')
    }
  } else if (HOST_ENTRY_EVALUATOR.test(text)) {
    throw new Error('宿主 bundle 缺少合法的内嵌正文（__DSH_PAD_HOST_BODY__）')
  }
  return markers
}
