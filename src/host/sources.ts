/**
 * Executes panel data sources on the Host: shell commands and HTTP requests.
 * Secrets are written as `{{env:NAME}}` in a source and resolved here, per
 * run; their values never reach the browser and are redacted from errors.
 */
import { spawn } from 'node:child_process'
import type { HttpSource, Json, PanelSource, SourceParse, SourceReading } from '../shared/types.ts'

/** Resolves a secret reference name to its value, or undefined when unset. */
export type SecretResolver = (name: string) => Promise<string | undefined>

export const MAX_OUTPUT_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const SECRET_REF = /\{\{\s*env:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/**
 * Turn raw output into the value the panel script receives.
 * @param raw - command stdout or response body.
 * @param parse - requested presentation.
 * @returns the parsed value.
 * @throws when `json` output does not parse.
 */
export function parseOutput(raw: string, parse: SourceParse): Json {
  if (parse === 'json') {
    try {
      return JSON.parse(raw) as Json
    } catch {
      throw new Error(`输出不是合法 JSON（开头：${raw.slice(0, 120)}）`)
    }
  }
  if (parse === 'lines') return raw.split(/\r?\n/).filter(line => line.trim() !== '')
  return raw.replace(/\s+$/, '')
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
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('***')
  return out
}

function runCommand(command: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (error: Error | undefined, value?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(value!)
    }
    const kill = (): void => {
      if (child.exitCode === null) child.kill('SIGKILL')
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
      size += chunk.length
      if (size > MAX_OUTPUT_BYTES) {
        kill()
        finish(new Error(`输出超过 ${MAX_OUTPUT_BYTES / 1024}KB，请用 head / grep / jq 等先筛一下`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.concat(stderr).length < 8192) stderr.push(chunk)
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

async function runHttp(source: HttpSource, timeoutMs: number, resolve: SecretResolver, used: Set<string>, signal?: AbortSignal): Promise<string> {
  const url = await fillSecrets(source.url, resolve, used)
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(source.headers ?? {})) headers[key] = await fillSecrets(value, resolve, used)
  const body = source.body === undefined ? undefined : await fillSecrets(source.body, resolve, used)
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, {
    method: source.method ?? 'GET',
    headers: { 'user-agent': 'dsh-pad', ...headers },
    ...(body === undefined ? {} : { body }),
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
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
  if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`)
  return text
}

/**
 * Run one source once.
 * @param source - the source to run.
 * @param resolve - secret resolver for `{{env:NAME}}` references.
 * @param signal - optional cancellation.
 * @returns the reading; failures are readings with `ok: false`, never throws.
 */
export async function runSource(source: PanelSource, resolve: SecretResolver, signal?: AbortSignal): Promise<SourceReading> {
  const started = Date.now()
  const timeoutMs = source.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const used = new Set<string>()
  try {
    const raw = source.kind === 'command'
      ? await runCommand(source.command, timeoutMs, signal)
      : await runHttp(source, timeoutMs, resolve, used, signal)
    return { ok: true, value: parseOutput(raw, source.parse), at: new Date().toISOString(), durationMs: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error
      ? (error.name === 'TimeoutError' ? `请求超时（${timeoutMs}ms）` : error.message)
      : String(error)
    return { ok: false, error: redact(message, used), at: new Date().toISOString(), durationMs: Date.now() - started }
  }
}
