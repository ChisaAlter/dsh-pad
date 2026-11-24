/**
 * Executes panel data sources on the Host: shell commands and HTTP requests.
 * Secrets are written as `{{env:NAME}}` in a source and resolved here, per
 * run; their values never reach the browser and are redacted from errors.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { HttpSource, Json, PanelSource, SourceParse, SourceReading } from '../shared/types.ts'
import { assertSourceJson } from './source-json.ts'

/** Resolves a secret reference name to its value, or undefined when unset. */
export type SecretResolver = (name: string) => Promise<string | undefined>

export interface RunSourceOptions {
  /** Allow loopback / private / link-local HTTP targets (explicit test opt-in). Defaults to false. */
  readonly allowPrivateHttp?: boolean
}

export const MAX_OUTPUT_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const SECRET_REF = /\{\{\s*env:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
const MAX_HTTP_REDIRECTS = 10
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// Custom headers and request bodies may hold credentials even without env refs.
const PUBLIC_REDIRECT_HEADERS = new Set(['accept', 'accept-language', 'content-type', 'user-agent'])
const SENSITIVE_ENV_KEY = /^(?:DSHD?_|DEEPSEEK_|OPENAI_|ANTHROPIC_|AWS_SECRET|GH_TOKEN$|GITHUB_TOKEN$|NPM_TOKEN$)|_(?:API_KEY$|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)/i

/** Strip host/harness internal variables and common credential env keys before spawning a shell command. */
export function sanitizedCommandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SENSITIVE_ENV_KEY.test(key)) continue
    clean[key] = value
  }
  return clean
}

function isBlockedIpv4Octets(a: number, b: number, c: number): boolean {
  if (a === 0) return true // 0.0.0.0/8 unspecified / this-network
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 shared/CGNAT
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 0 && c === 0) return true // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a >= 224) return true // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false
}

function parseIpv4(ip: string): [number, number, number, number] | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  const nums = parts.map(part => Number(part))
  if (nums.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return undefined
  return nums as [number, number, number, number]
}

function parseIpv6(raw: string): number[] | undefined {
  let ip = raw.toLowerCase()
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1)
  if (isIP(ip) !== 6) return undefined
  // Expand embedded IPv4 tail (e.g. ::ffff:127.0.0.1) into two 16-bit groups.
  const lastColon = ip.lastIndexOf(':')
  if (lastColon >= 0 && ip.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4(ip.slice(lastColon + 1))
    if (v4 === undefined) return undefined
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    ip = `${ip.slice(0, lastColon)}:${hi}:${lo}`
  }
  const halves = ip.split('::')
  if (halves.length > 2) return undefined
  const left = halves[0] === '' ? [] : halves[0]!.split(':')
  const right = halves.length === 2 && halves[1] !== '' ? halves[1]!.split(':') : []
  const missing = 8 - (left.length + right.length)
  if (halves.length === 1 && missing !== 0) return undefined
  if (halves.length === 2 && missing < 1) return undefined
  const groups = [
    ...left.map(g => Number.parseInt(g, 16)),
    ...Array.from({ length: Math.max(0, missing) }, () => 0),
    ...right.map(g => Number.parseInt(g, 16)),
  ]
  if (groups.length !== 8 || groups.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff)) return undefined
  return groups
}

/** Whether an IPv4 or IPv6 address belongs to loopback, private, link-local, unspecified or IPv4-mapped ranges. */
export function isBlockedIp(raw: string): boolean {
  const cleaned = raw.trim().replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  const family = isIP(cleaned)
  if (family === 4) {
    const v4 = parseIpv4(cleaned)
    return v4 === undefined ? true : isBlockedIpv4Octets(v4[0], v4[1], v4[2])
  }
  if (family === 6) {
    const g = parseIpv6(cleaned)
    if (g === undefined) return true
    const allZeroPrefix = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0
    // :: unspecified, ::1 loopback, ::/96 IPv4-compatible, ::ffff:0:0/96 IPv4-mapped
    if (allZeroPrefix && g[5] === 0) {
      if (g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true
      return isBlockedIpv4Octets((g[6]! >> 8) & 0xff, g[6]! & 0xff, (g[7]! >> 8) & 0xff)
    }
    if (allZeroPrefix && g[5] === 0xffff) return true
    // 64:ff9b::/96 NAT64 well-known prefix embedding IPv4
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isBlockedIpv4Octets((g[6]! >> 8) & 0xff, g[6]! & 0xff, (g[7]! >> 8) & 0xff)
    }
    // 2002::/16 6to4 embedding IPv4 in groups 1 and 2
    if (g[0] === 0x2002) {
      return isBlockedIpv4Octets((g[1]! >> 8) & 0xff, g[1]! & 0xff, (g[2]! >> 8) & 0xff)
    }
    if ((g[0]! & 0xfe00) === 0xfc00) return true // fc00::/7 unique local (private)
    if ((g[0]! & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((g[0]! & 0xffc0) === 0xfec0) return true // fec0::/10 deprecated site-local
    if ((g[0]! & 0xff00) === 0xff00) return true // ff00::/8 multicast
    return false
  }
  return true
}

async function assertSafeHttpTarget(url: URL, allowPrivateHttp: boolean): Promise<void> {
  if (allowPrivateHttp) return
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('HTTP 目标必须是 http(s) 网址')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase()
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('不允许访问本机或内网地址')
  }
  if (isIP(host) !== 0) {
    if (isBlockedIp(host)) throw new Error('不允许访问本机或内网地址')
    return
  }
  const resolved = await lookup(host, { all: true, verbatim: true })
  if (resolved.length === 0) throw new Error('无法解析目标主机地址')
  for (const entry of resolved) {
    if (isBlockedIp(entry.address)) {
      throw new Error('不允许访问本机或内网地址')
    }
  }
}

/**
 * Turn raw output into the value the panel script receives.
 * @param raw - command stdout or response body.
 * @param parse - requested presentation.
 * @returns the parsed value.
 * @throws when `json` output does not parse.
 */
export function parseOutput(raw: string, parse: SourceParse, secrets: ReadonlySet<string> = new Set()): Json {
  if (parse === 'json') {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error(`输出不是合法 JSON（开头：${redact(raw, secrets).slice(0, 120)}）`)
    }
    assertSourceJson(value)
    return redactValue(value, secrets)
  }
  const safe = redact(raw, secrets)
  if (parse === 'lines') return safe.split(/\r?\n/).filter(line => line.trim() !== '')
  return safe.replace(/\s+$/, '')
}

/** Names of every secret a source references. */
export function secretNames(source: PanelSource): string[] {
  if (source.kind !== 'http') return []
  const text = [source.url, source.body ?? '', ...Object.values(source.headers ?? {})].join('\n')
  return [...new Set([...text.matchAll(SECRET_REF)].map(match => match[1]!))]
}

async function fillSecrets(text: string, resolve: SecretResolver, used: Set<string>): Promise<string> {
  const names = [...new Set([...text.matchAll(SECRET_REF)].map(match => match[1]!))]
  const values = new Map<string, string>()
  for (const name of names) {
    const value = await resolve(name)
    if (value === undefined || value === '') throw new Error(`密钥 ${name} 没有配置：请在 dsh 的凭据设置或环境变量里设置 ${name}`)
    values.set(name, value)
    used.add(value)
  }
  return text.replace(SECRET_REF, (_match, name: string) => values.get(name)!)
}

function redact(message: string, secrets: ReadonlySet<string>): string {
  let out = message
  const variants = new Set<string>()
  for (const secret of secrets) {
    if (secret === '') continue
    variants.add(secret)
    variants.add(JSON.stringify(secret).slice(1, -1))
    try {
      variants.add(encodeURIComponent(secret))
    } catch {
      // A credential with an unpaired surrogate still has a literal form.
    }
  }
  // Hide longer values first so overlapping credentials cannot expose a suffix.
  for (const secret of [...variants].sort((a, b) => b.length - a.length)) out = out.split(secret).join('***')
  return out
}

/** Redact parsed JSON strings and keys, including values escaped in the wire JSON. */
function redactValue(value: Json, secrets: ReadonlySet<string>): Json {
  if (secrets.size === 0) return value
  if (typeof value === 'string') return redact(value, secrets)
  if (typeof value === 'number' && secrets.has(String(value))) return '***'
  if (value === null || typeof value !== 'object') return value
  const pending: Array<Json[] | { [key: string]: Json }> = [value]
  while (pending.length > 0) {
    const object = pending.pop()!
    for (const [key, child] of Object.entries(object)) {
      const safeKey = Array.isArray(object) ? key : redact(key, secrets)
      const safeValue = typeof child === 'string' ? redact(child, secrets)
        : typeof child === 'number' && secrets.has(String(child)) ? '***' : child
      if (key !== safeKey) delete (object as { [key: string]: Json })[key]
      Object.defineProperty(object, safeKey, { value: safeValue, enumerable: true, configurable: true, writable: true })
      if (child !== null && typeof child === 'object') pending.push(child)
    }
  }
  return value
}

function killCommandTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // child.kill() only stops the shell (`cmd.exe`); taskkill /T stops the
    // command it started as well.
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => {
        try {
          child.kill()
        } catch {
          // Already gone.
        }
      })
    } catch {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    return
  }
  // On POSIX the shell is the leader of its own process group (see detached
  // below), so a negative pid reaches the whole pipeline.
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function runCommand(command: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'))
      return
    }
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedCommandEnv(),
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stderrSize = 0
    let size = 0
    let settled = false
    let killed = false
    const finish = (error: Error | undefined, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value!)
    }
    const kill = (): void => {
      if (killed) return
      killed = true
      if (child.exitCode === null) killCommandTree(child)
    }
    const timer = setTimeout(() => {
      kill()
      finish(new Error(`命令超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const onAbort = (): void => {
      kill()
      finish(new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        child.stdout.destroy()
        kill()
        finish(new Error(`输出超过 ${MAX_OUTPUT_BYTES / 1024}KB，请用 head / grep / jq 等先筛一下`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return
      if (stderrSize >= 8192) return
      const part = chunk.subarray(0, 8192 - stderrSize)
      stderr.push(part)
      stderrSize += part.length
    })
    child.on('error', error => finish(error))
    child.on('close', code => {
      const out = Buffer.concat(stdout).toString('utf8')
      if (code === 0) {
        finish(undefined, out)
        return
      }
      const err = Buffer.concat(stderr).toString('utf8').trim()
      finish(new Error(`命令退出码 ${code ?? 'null'}${err ? `：${err.slice(-500)}` : ''}`))
    })
  })
}

async function runHttp(
  source: HttpSource,
  timeoutMs: number,
  resolve: SecretResolver,
  used: Set<string>,
  signal?: AbortSignal,
  allowPrivateHttp = false,
): Promise<string> {
  let url = new URL(await fillSecrets(source.url, resolve, used))
  const headers = new Headers({ 'user-agent': 'dsh-pad' })
  for (const [key, value] of Object.entries(source.headers ?? {})) headers.set(key, await fillSecrets(value, resolve, used))
  let body = source.body === undefined ? undefined : await fillSecrets(source.body, resolve, used)
  let method = source.method ?? 'GET'
  const carriesCredentials = used.size > 0 || body !== undefined
    || [...headers.keys()].some(key => !PUBLIC_REDIRECT_HEADERS.has(key))
  if (signal?.aborted) throw new Error('已取消')
  await assertSafeHttpTarget(url, allowPrivateHttp)
  if (signal?.aborted) throw new Error('已取消')
  const timeout = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  for (let redirects = 0; ; redirects += 1) {
    response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      signal: requestSignal,
    })
    const location = response.headers.get('location')
    const isRedirect = REDIRECT_STATUSES.has(response.status)
      || (response.status >= 300 && response.status < 400 && response.status !== 304 && location !== null)
    if (used.size > 0 && isRedirect) {
      await response.body?.cancel()
      throw new Error('含密钥引用的 HTTP 请求不允许重定向，请直接配置最终目标网址')
    }
    if (!REDIRECT_STATUSES.has(response.status) || location === null) break
    // Intermediate bodies must not retain sockets while we reject or follow.
    await response.body?.cancel()
    if (redirects >= MAX_HTTP_REDIRECTS) throw new Error(`HTTP 重定向超过 ${MAX_HTTP_REDIRECTS} 次`)
    const target = new URL(location, url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('HTTP 重定向目标必须是 http(s) 网址')
    if (carriesCredentials && target.origin !== url.origin) throw new Error('含凭据的 HTTP 请求不能跨 origin 重定向，请直接配置可信目标网址')
    await assertSafeHttpTarget(target, allowPrivateHttp)
    if (signal?.aborted) throw new Error('已取消')
    if ((response.status === 303 && method !== 'GET') || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET'
      body = undefined
      for (const key of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(key)
    }
    url = target
  }
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_OUTPUT_BYTES) {
        await reader.cancel()
        throw new Error(`响应超过 ${MAX_OUTPUT_BYTES / 1024}KB`)
      }
      chunks.push(value)
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `：${redact(text, used).slice(0, 300)}` : ''}`)
  return text
}

/**
 * Run one source once.
 * @param source - the source to run.
 * @param resolve - secret resolver for `{{env:NAME}}` references.
 * @param signal - optional cancellation.
 * @param options - optional execution controls (e.g. `allowPrivateHttp` for tests).
 * @returns the reading; failures are readings with `ok: false`, never throws.
 */
export async function runSource(
  source: PanelSource,
  resolve: SecretResolver,
  signal?: AbortSignal,
  options?: RunSourceOptions,
): Promise<SourceReading> {
  const started = Date.now()
  const timeoutMs = source.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const used = new Set<string>()
  try {
    if (signal?.aborted) throw new Error('已取消')
    const raw = source.kind === 'command'
      ? await runCommand(source.command, timeoutMs, signal)
      : await runHttp(source, timeoutMs, resolve, used, signal, options?.allowPrivateHttp === true)
    if (signal?.aborted) throw new Error('已取消')
    return { ok: true, value: parseOutput(raw, source.parse, used), at: new Date().toISOString(), durationMs: Date.now() - started }
  } catch (error) {
    const message = signal?.aborted ? '已取消' : error instanceof Error
      ? (error.name === 'TimeoutError' ? `请求超时（${timeoutMs}ms）` : error.message)
      : String(error)
    return { ok: false, error: redact(message, used), at: new Date().toISOString(), durationMs: Date.now() - started }
  }
}
