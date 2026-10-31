/**
 * The update journal is also bundled into the small host entry point. Recovery
 * must run there, before the plugin body (or its imports) can be initialized.
 * Once a journal is published we always finish its complete staged release.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import type { ListenOptions, Server } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const UPDATE_FILES = ['lib/index.js', 'lib/client.js', 'package.json', 'cordis.patch.yml'] as const
export const UPDATE_JOURNAL = '.dsh-pad-update.json'
const BACKUP_DIRECTORY = '.dsh-pad-update-backup'
const JOURNAL_LIMIT = 8192
const LOCK_TIMEOUT_MS = 5000

/** Stable across processes, symlink aliases and Windows path case. */
export function updateLockEndpoint(root: string): ListenOptions {
  let path = realpathSync.native(root)
  if (process.platform === 'win32') path = path.toLowerCase()
  const hash = createHash('sha256').update(path).digest('hex')
  // Kernel-owned IPC names disappear when their process exits. Full hashes avoid
  // the small TCP port namespace and conflicts with ephemeral HTTP connections.
  if (process.platform === 'win32') return { path: `\\\\.\\pipe\\dsh-pad-update-${hash}`, exclusive: true }
  if (process.platform === 'linux') return { path: `\0dsh-pad-update-${hash}`, exclusive: true }
  // Other platforms lack Linux abstract sockets. A fixed loopback port still
  // fails closed on conflict; never switch endpoints to bypass another owner.
  return { host: '127.0.0.1', port: 49152 + Number.parseInt(hash.slice(0, 4), 16) % 16384, exclusive: true }
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

/** The kernel releases this mutex even if a process dies during replacement. */
async function withUpdateLock<T>(root: string, operation: () => T): Promise<T> {
  const endpoint = updateLockEndpoint(root)
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let server: Server
  for (;;) {
    try {
      server = await listen(endpoint)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the dsh-pad update lock')
      await delay(25)
    }
  }
  try {
    return operation()
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
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
  if (journal.format !== 1 || typeof journal.id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(journal.id) ||
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

/** Keep recovery, disk identity checks and synchronous body initialization under one lock. */
export async function withRecoveredUpdate<T>(root: string, initialize: (recovered: boolean) => T): Promise<T> {
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
    const target = join(root, file)
    const parent = dirname(target)
    mkdirSync(parent, { recursive: true })
    const temp = `${target}.update-${process.pid}`
    // Reuse no partially written file, including one left by an earlier crash.
    // rm without recursive refuses directories, rather than deleting user data.
    rmSync(temp, { force: true })
    const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644
    writeDurable(temp, content, mode)
    renameSync(temp, target)
    syncDirectory(parent)
  }
  syncDirectory(root)
  unlinkSync(join(root, UPDATE_JOURNAL))
  syncDirectory(root)
  // Keep both original and staged releases for diagnosis. No recovery needs the
  // originals, and removing a staging file before the journal is gone is unsafe.
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
  if (existsSync(join(root, UPDATE_JOURNAL))) throw new Error('An unfinished dsh-pad update must be recovered before updating again')
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
  const temporary = join(root, `${UPDATE_JOURNAL}.prepare-${id}`)
  writeDurable(temporary, JSON.stringify(journal))
  // An atomic, exclusive hard-link publishes already-flushed bytes. Unlike a
  // normal rename it cannot overwrite a journal from another update process.
  linkSync(temporary, join(root, UPDATE_JOURNAL))
  syncDirectory(root)
  unlinkSync(temporary)
  syncDirectory(root)
  recoverLocked(root)
}
