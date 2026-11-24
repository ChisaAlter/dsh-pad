/**
 * The update journal is also bundled into the small host entry point. Recovery
 * must run there, before the plugin body (or its imports) can be initialized.
 * Once a journal is published we always finish its complete staged release.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { connect, createServer } from 'node:net'
import type { ListenOptions, Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const UPDATE_FILES = ['lib/index.js', 'lib/client.js', 'package.json', 'cordis.patch.yml'] as const
export const UPDATE_JOURNAL = '.dsh-pad-update.json'
const BACKUP_DIRECTORY = '.dsh-pad-update-backup'
const STALE_SOURCE_MAPS = ['lib/index.js.map', 'lib/client.js.map'] as const
const MAX_BACKUPS_TO_KEEP = 2
const JOURNAL_LIMIT = 8192
const LOCK_TIMEOUT_MS = 5000
const UNIX_SOCKET_MAX_BYTES = 100
const RETRYABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY'])
const NON_HARDLINK_ERRORS = new Set(['ENOTSUP', 'EPERM', 'EXDEV'])
const RENAME_BACKOFF_MS = [15, 30, 60, 120, 240]
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function unixLockPath(hash: string): string {
  const filename = `dshpad-${hash.slice(0, 24)}.sock`
  const candidate = join(tmpdir(), filename)
  if (Buffer.byteLength(candidate, 'utf8') < UNIX_SOCKET_MAX_BYTES) return candidate
  return join('/tmp', filename)
}

/** Stable across processes, symlink aliases and Windows path case. */
export function updateLockEndpoint(root: string, platform: NodeJS.Platform = process.platform): ListenOptions {
  let path = realpathSync.native(root)
  if (platform === 'win32') path = path.toLowerCase()
  const hash = createHash('sha256').update(path).digest('hex')
  // Kernel-owned IPC names disappear when their process exits. Full hashes avoid
  // the small TCP port namespace and conflicts with ephemeral HTTP connections.
  if (platform === 'win32') return { path: `\\\\.\\pipe\\dsh-pad-update-${hash}`, exclusive: true }
  if (platform === 'linux') return { path: `\0dsh-pad-update-${hash}`, exclusive: true }
  // macOS/BSD lack Linux abstract sockets; use a hashed Unix domain socket in
  // tmpdir instead of binding into the IANA ephemeral TCP port range.
  return { path: unixLockPath(hash), exclusive: true }
}

async function listen(endpoint: ListenOptions): Promise<Server> {
  const server = createServer(socket => { socket.destroy() })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

async function isStaleUnixSocket(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const done = (stale: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(stale)
    }
    const socket = connect(socketPath, () => done(false))
    socket.setTimeout(250, () => done(false))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      done(error.code === 'ECONNREFUSED' || error.code === 'ENOENT')
    })
  })
}

/** The kernel releases this mutex even if a process dies during replacement. */
async function withUpdateLock<T>(root: string, operation: () => T): Promise<T> {
  const endpoint = updateLockEndpoint(root)
  const unixSocketPath = process.platform !== 'win32' && process.platform !== 'linux' && typeof endpoint.path === 'string'
    ? endpoint.path
    : undefined
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let server: Server
  for (;;) {
    try {
      server = await listen(endpoint)
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EADDRINUSE' || (process.platform === 'win32' && code === 'EACCES')
      if (!retryable) throw error
      if (unixSocketPath !== undefined && code === 'EADDRINUSE' && await isStaleUnixSocket(unixSocketPath)) {
        try {
          rmSync(unixSocketPath, { force: true })
        } catch {
          // Another process may have already unlinked or replaced it.
        }
        continue
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the dsh-pad update lock')
      await delay(25)
    }
  }
  try {
    return operation()
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
    if (unixSocketPath !== undefined) {
      try { rmSync(unixSocketPath, { force: true }) } catch { /* best-effort cleanup */ }
    }
  }
}

type UpdateFile = typeof UPDATE_FILES[number]
interface StagedFile {
  readonly path: UpdateFile
  readonly size: number
  readonly sha256: string
}
interface UpdateJournal {
  readonly format: 1
  readonly id: string
  readonly files: readonly StagedFile[]
}

function digest(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * POSIX requires directory fsync as well as file fsync for rename durability.
 * Windows' Node fs API cannot open/fsync directories on all filesystems; file
 * contents are still flushed and each replacement uses a single rename there.
 */
function syncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (process.platform !== 'win32' || !['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(code ?? '')) throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function writeDurable(path: string, content: string | Buffer, mode = 0o600): void {
  const fd = openSync(path, 'wx', mode)
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function ensureWritable(path: string, mode: number): void {
  try {
    if (existsSync(path)) chmodSync(path, mode)
  } catch {
    // Best-effort clearing of read-only bits before atomic replacement.
  }
}

function replaceFile(target: string, content: Buffer): void {
  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const temp = `${target}.update-${process.pid}`
  // Reuse no partially written file, including one left by an earlier crash.
  // rm without recursive refuses directories, rather than deleting user data.
  rmSync(temp, { force: true })
  let mode = 0o644
  if (existsSync(target)) {
    const existingMode = statSync(target).mode & 0o777
    mode = existingMode | 0o200
    if ((existingMode & 0o200) === 0) ensureWritable(target, mode)
  }
  let renamed = false
  try {
    writeDurable(temp, content, mode)
    for (let attempt = 0; ; attempt += 1) {
      try {
        renameSync(temp, target)
        renamed = true
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (process.platform !== 'win32' || !RETRYABLE_RENAME_ERRORS.has(code ?? '') || attempt >= RENAME_BACKOFF_MS.length) {
          throw error
        }
        ensureWritable(target, mode)
        sleepSync(RENAME_BACKOFF_MS[attempt]!)
      }
    }
    syncDirectory(parent)
  } finally {
    if (!renamed) {
      try { rmSync(temp, { force: true }) } catch { /* best-effort cleanup */ }
    }
  }
}

function removeIfRegularFile(path: string): void {
  try {
    if (lstatSync(path).isFile()) rmSync(path, { force: true })
  } catch {
    // Ignore missing files or transient cleanup errors.
  }
}

function cleanupUpdateArtifacts(root: string): void {
  try {
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(`${UPDATE_JOURNAL}.prepare-`) || /^(?:package\.json|cordis\.patch\.yml)\.update-/.test(entry)) {
        removeIfRegularFile(join(root, entry))
      }
    }
  } catch {
    // Best-effort cleanup.
  }
  const libDir = join(root, 'lib')
  try {
    if (existsSync(libDir) && lstatSync(libDir).isDirectory()) {
      for (const entry of readdirSync(libDir)) {
        if (/^(?:index\.js|client\.js)\.update-/.test(entry)) {
          removeIfRegularFile(join(libDir, entry))
        }
      }
    }
  } catch {
    // Best-effort cleanup.
  }
}

function pruneBackups(root: string, keepId: string): void {
  const backupsDir = join(root, BACKUP_DIRECTORY)
  let resolvedBackups: string
  try {
    if (!lstatSync(backupsDir).isDirectory()) return
    resolvedBackups = realpathSync.native(backupsDir)
  } catch {
    return
  }
  let names: string[]
  try {
    names = readdirSync(backupsDir)
  } catch {
    return
  }
  const candidates: Array<{ name: string, path: string, mtimeMs: number, birthtimeMs: number }> = []
  for (const name of names) {
    if (!UUID_PATTERN.test(name)) continue
    const candidatePath = join(resolvedBackups, name)
    try {
      const info = lstatSync(candidatePath)
      if (!info.isDirectory()) continue
      candidates.push({ name, path: candidatePath, mtimeMs: info.mtimeMs, birthtimeMs: info.birthtimeMs })
    } catch {
      // Skip disappeared or unreadable entries.
    }
  }
  if (candidates.length <= MAX_BACKUPS_TO_KEEP) return
  candidates.sort((left, right) => {
    if (left.name === keepId) return -1
    if (right.name === keepId) return 1
    if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs
    return right.birthtimeMs - left.birthtimeMs
  })
  const prefix = resolvedBackups.endsWith('\\') || resolvedBackups.endsWith('/') ? resolvedBackups : `${resolvedBackups}${process.platform === 'win32' ? '\\' : '/'}`
  for (const stale of candidates.slice(MAX_BACKUPS_TO_KEEP)) {
    try {
      const resolved = resolve(stale.path)
      if (!resolved.startsWith(prefix)) continue
      if (lstatSync(resolved).isSymbolicLink()) continue
      rmSync(resolved, { recursive: true, force: true })
    } catch {
      // Best-effort backup pruning.
    }
  }
}

function parseJournal(root: string): UpdateJournal | undefined {
  const path = join(root, UPDATE_JOURNAL)
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.size > JOURNAL_LIMIT) throw new Error('Invalid dsh-pad update journal')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object') throw new Error('Invalid dsh-pad update journal')
  const journal = value as Partial<UpdateJournal>
  if (journal.format !== 1 || typeof journal.id !== 'string' || !UUID_PATTERN.test(journal.id) ||
      !Array.isArray(journal.files) || journal.files.length !== UPDATE_FILES.length) {
    throw new Error('Invalid dsh-pad update journal')
  }
  for (const [index, file] of journal.files.entries()) {
    if (file === null || typeof file !== 'object' || file.path !== UPDATE_FILES[index] ||
        !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error('Invalid dsh-pad update journal file')
    }
  }
  return journal as UpdateJournal
}

/**
 * Finish a previously prepared update under the kernel mutex. All four staged files are
 * verified before touching any installed file, so a corrupt/incomplete journal
 * fails closed. A crash during recovery simply leaves the same journal to replay
 * next time. On success the bootstrap must re-import the entry from disk: the
 * module that called us may already contain a different version of the body.
 *
 * @returns true when an update was recovered and the entry must be reloaded.
 * @throws when recovery cannot complete; do not initialize the plugin body.
 */
export async function recoverUpdate(root: string): Promise<boolean> {
  // A normal startup with no pending transaction needs no local socket. The
  // bootstrap still checks the disk bundle identity before evaluating its body.
  if (!existsSync(join(root, UPDATE_JOURNAL))) return false
  return withUpdateLock(root, () => recoverLocked(root))
}

/**
 * Run recovery when a journal exists, keeping recovery, disk identity checks
 * and synchronous body initialization under one lock. Normal startups with no
 * pending journal take a lock-free fast path.
 */
export async function withRecoveredUpdate<T>(root: string, initialize: (recovered: boolean) => T): Promise<T> {
  if (!existsSync(join(root, UPDATE_JOURNAL))) return initialize(false)
  return withUpdateLock(root, () => initialize(recoverLocked(root)))
}

function recoverLocked(root: string): boolean {
  const journal = parseJournal(root)
  if (journal === undefined) return false
  const staged = join(root, BACKUP_DIRECTORY, journal.id, 'staged')
  const contents = journal.files.map(file => {
    const path = join(staged, file.path)
    if (!lstatSync(path).isFile()) throw new Error(`Invalid staged update file: ${file.path}`)
    const content = readFileSync(path)
    if (content.length !== file.size || digest(content) !== file.sha256) {
      throw new Error(`Staged update checksum mismatch: ${file.path}`)
    }
    return { file: file.path, content }
  })

  for (const { file, content } of contents) {
    replaceFile(join(root, file), content)
  }
  for (const mapFile of STALE_SOURCE_MAPS) {
    removeIfRegularFile(join(root, mapFile))
  }
  syncDirectory(root)
  unlinkSync(join(root, UPDATE_JOURNAL))
  syncDirectory(root)
  cleanupUpdateArtifacts(root)
  pruneBackups(root, journal.id)
  return true
}

/**
 * Stage and back up the complete release before publishing an atomic, durable
 * journal. Before that publication an error leaves every installed file alone;
 * afterwards an error deliberately leaves the journal for startup recovery.
 * The mutex covers staging, publication and recovery across every Host process;
 * the filesystem core is synchronous so local request handlers cannot interleave.
 */
export async function replaceUpdateFiles(root: string, contents: ReadonlyMap<string, string>): Promise<void> {
  return withUpdateLock(root, () => replaceLocked(root, contents))
}

function replaceLocked(root: string, contents: ReadonlyMap<string, string>): void {
  const journalPath = join(root, UPDATE_JOURNAL)
  if (existsSync(journalPath)) throw new Error('An unfinished dsh-pad update must be recovered before updating again')
  const id = randomUUID()
  const backups = join(root, BACKUP_DIRECTORY)
  const transaction = join(backups, id)
  const staged = join(transaction, 'staged')
  const original = join(transaction, 'original')
  mkdirSync(join(staged, 'lib'), { recursive: true })
  mkdirSync(join(original, 'lib'), { recursive: true })
  const files: StagedFile[] = []
  for (const file of UPDATE_FILES) {
    const text = contents.get(file)
    if (typeof text !== 'string') throw new Error(`Missing update file: ${file}`)
    const content = Buffer.from(text, 'utf8')
    writeDurable(join(staged, file), content)
    files.push({ path: file, size: content.length, sha256: digest(content) })
    const target = join(root, file)
    if (existsSync(target)) writeDurable(join(original, file), readFileSync(target))
  }
  for (const directory of [join(staged, 'lib'), staged, join(original, 'lib'), original, transaction, backups, root]) {
    syncDirectory(directory)
  }

  const journal: UpdateJournal = { format: 1, id, files }
  const journalPayload = JSON.stringify(journal)
  const temporary = join(root, `${UPDATE_JOURNAL}.prepare-${id}`)
  try {
    writeDurable(temporary, journalPayload)
    // An atomic, exclusive hard-link publishes already-flushed bytes. Unlike a
    // normal rename it cannot overwrite a journal from another update process.
    try {
      linkSync(temporary, journalPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!NON_HARDLINK_ERRORS.has(code ?? '')) throw error
      if (existsSync(journalPath)) throw error
      // Fallback for exFAT/SMB volumes that do not support hard links: still
      // serialized under the cross-process lock and opened exclusively (`wx`).
      writeDurable(journalPath, journalPayload)
    }
    syncDirectory(root)
  } finally {
    try {
      unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Best-effort cleanup without masking the primary error.
      }
    }
    syncDirectory(root)
  }
  recoverLocked(root)
}
