/**
 * Pre-flight and post-install check for dsh-pad.
 *
 * Run it in the plugin checkout before installing, and again after:
 *
 *   node scripts/doctor.mjs
 *
 * It answers the two questions that decide whether the plugin can load at all:
 * does `lib/` exist, and did the profile record the plugin as a *bundle* (the
 * supported path) instead of a hand-written entry in `cordis.patch.yml`?
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const problems = []
const notes = []

const UPDATE_FILES = ['lib/index.js', 'lib/client.js', 'package.json', 'cordis.patch.yml']
const UPDATE_JOURNAL = '.dsh-pad-update.json'
const BACKUP_DIRECTORY = '.dsh-pad-update-backup'
const JOURNAL_LIMIT = 8192
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const BUILD_MARKER = /\n\/\/ dsh-pad-build:([a-f0-9]{64})\n?$/
const TRAILING_MARKERS = /\n\/\/ dsh-pad-body:([a-f0-9]{64})\n?(\n\/\/ dsh-pad-build:([a-f0-9]{64})\n?)$/

async function loadVerifyHostBundle() {
  const sourceModule = new URL('../src/host/bundle-integrity.ts', import.meta.url)
  if (existsSync(sourceModule)) {
    try {
      const mod = await import(sourceModule.href)
      if (typeof mod.verifyHostBundle === 'function') return mod.verifyHostBundle
    } catch {
      // Fall back to the standalone check when running outside TS-capable Node.
    }
  }
  return function verifyHostBundleFallback(text) {
    if (!BUILD_MARKER.test(text)) {
      throw new Error('宿主 bundle 缺少构建标记（dsh-pad-build），可能是不完整的 release')
    }
    const match = TRAILING_MARKERS.exec(text)
    if (match === null) {
      throw new Error('宿主 bundle 缺少正文标记（dsh-pad-body），可能是不完整的 release')
    }
    const bodyDigest = match[1]
    const buildTail = match[2]
    const buildDigest = match[3]
    const buildPayloadEnd = text.length - buildTail.length
    if (createHash('sha256').update(text.slice(0, buildPayloadEnd)).digest('hex') !== buildDigest) {
      throw new Error('宿主 bundle 的自校验哈希不匹配，可能被截断或篡改')
    }
    return { bodyDigest, buildDigest, buildPayloadEnd, bodyMarkerStart: match.index }
  }
}

function inspectUpdateJournal(pluginRoot) {
  const journalPath = join(pluginRoot, UPDATE_JOURNAL)
  let info
  try {
    info = lstatSync(journalPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'none' }
    return { status: 'corrupt', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!info.isFile() || info.size > JOURNAL_LIMIT) {
    return { status: 'corrupt', detail: '不是合法的普通文件或超过 8KB 上限' }
  }
  let journal
  try {
    journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  } catch {
    return { status: 'corrupt', detail: 'JSON 解析失败' }
  }
  if (
    journal === null || typeof journal !== 'object' ||
    journal.format !== 1 || typeof journal.id !== 'string' || !UUID_PATTERN.test(journal.id) ||
    !Array.isArray(journal.files) || journal.files.length !== UPDATE_FILES.length
  ) {
    return { status: 'corrupt', detail: 'journal 结构或版本无效' }
  }
  const stagedRoot = join(pluginRoot, BACKUP_DIRECTORY, journal.id, 'staged')
  for (let index = 0; index < journal.files.length; index += 1) {
    const file = journal.files[index]
    if (
      file === null || typeof file !== 'object' || file.path !== UPDATE_FILES[index] ||
      !Number.isSafeInteger(file.size) || file.size < 0 ||
      typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      return { status: 'corrupt', detail: `文件记录无效（索引 ${index}）` }
    }
    const stagedFile = join(stagedRoot, file.path)
    try {
      if (!lstatSync(stagedFile).isFile()) {
        return { status: 'corrupt', detail: `暂存文件不是普通文件：${file.path}` }
      }
      const content = readFileSync(stagedFile)
      if (content.length !== file.size || createHash('sha256').update(content).digest('hex') !== file.sha256) {
        return { status: 'corrupt', detail: `暂存文件校验和不匹配：${file.path}` }
      }
    } catch {
      return { status: 'corrupt', detail: `缺少或无法读取暂存文件：${file.path}` }
    }
  }
  return { status: 'pending', id: journal.id }
}

const verifyHostBundle = await loadVerifyHostBundle()

function ok(label, detail = '') {
  console.log(`✓ ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function bad(label, detail) {
  problems.push(`${label}：${detail}`)
  console.log(`✗ ${label} — ${detail}`)
}

function warn(label, detail) {
  notes.push(`${label}：${detail}`)
  console.log(`! ${label} — ${detail}`)
}

function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

console.log('dsh-pad doctor\n')

// 1. Package metadata and build artifacts.
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
ok('包名', manifest.name)

for (const file of ['lib/index.js', 'lib/client.js']) {
  const path = join(root, file)
  if (sizeOf(path) > 1000) ok(file, `${Math.round(sizeOf(path) / 1024)} KB`)
  else bad(file, '缺失或是空文件，插件装上也加载不了')
}

const hostBundlePath = join(root, 'lib/index.js')
if (sizeOf(hostBundlePath) > 1000) {
  try {
    const markers = verifyHostBundle(readFileSync(hostBundlePath, 'utf8'))
    ok('lib/index.js 完整性', `build:${markers.buildDigest.slice(0, 12)} body:${markers.bodyDigest.slice(0, 12)}`)
  } catch (error) {
    bad('lib/index.js 完整性', error instanceof Error ? error.message : String(error))
  }
}

const journalCheck = inspectUpdateJournal(root)
if (journalCheck.status === 'none') {
  ok('更新事务', '没有挂起的 .dsh-pad-update.json')
} else if (journalCheck.status === 'pending') {
  warn('.dsh-pad-update.json', `存在待恢复的更新事务（${journalCheck.id.slice(0, 8)}），重启 dsh 后会自动完成恢复`)
} else {
  bad('.dsh-pad-update.json', `更新事务日志损坏或不完整（${journalCheck.detail}），启动时会被拦截；请重装完整发行包或清理残损事务后重新构建`)
}

if (manifest.exports?.['./client'] === undefined) bad('package.json exports["./client"]', '必须指向 lib/client.js，否则 dsh 拒绝启动这个客户端插件')
else ok('package.json exports["./client"]', manifest.exports['./client'])

if (manifest.dsh?.bundle?.patch === undefined) bad('package.json dsh.bundle.patch', '缺少 bundle 补丁声明')
else ok('dsh.bundle.patch', manifest.dsh.bundle.patch)

if (existsSync(join(root, 'cordis.patch.yml'))) ok('cordis.patch.yml')
else bad('cordis.patch.yml', '缺失')

// 2. Profile state, when a profile can be found.
const home = process.env['DSH_HOME'] || join(homedir(), '.dsh')
const profile = join(home, 'profiles', 'web')
if (!existsSync(join(profile, 'package.json'))) {
  warn('profile', `没找到 ${profile}（设置 DSH_HOME 后再运行，或忽略这一节）`)
} else {
  const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  const dependency = profileManifest.dependencies?.['dsh-pad']
  const bundles = profileManifest.dsh?.profile?.bundles ?? []
  const installed = bundles.includes('dsh-pad')

  if (installed) ok('profile 已登记 dsh-pad', dependency ?? '（bundles 里但没有 dependencies）')
  else notes.push('profile 尚未安装 dsh-pad')

  if (installed && dependency === undefined) bad('profile dependencies', 'bundles 里有 dsh-pad，但 dependencies 里没有，安装不完整')

  const link = join(profile, 'node_modules', 'dsh-pad')
  if (installed) {
    if (!existsSync(link)) bad('profile node_modules/dsh-pad', '链接不存在，重装一次（dsh plugin --profile web add）')
    else if (!existsSync(join(link, 'lib', 'index.js')) || !existsSync(join(link, 'lib', 'client.js'))) {
      bad('profile 里的插件产物', '链接指向的目录没有 lib/，等于没构建')
    } else ok('profile node_modules/dsh-pad', '链接与产物都在')
  }

  // The classic mistake: copying the bundle patch into the profile patch.
  const patchPath = join(profile, 'cordis.patch.yml')
  if (existsSync(patchPath)) {
    const patch = readFileSync(patchPath, 'utf8')
    if (patch.includes('dsh-pad')) {
      bad('profile cordis.patch.yml', '里面有 dsh-pad 条目。插件应当以 bundle 方式登记，手写补丁会在启动时找不到模块；请删掉这段并改用 dsh plugin add')
    } else {
      ok('profile cordis.patch.yml', '没有手写的 dsh-pad 条目')
    }
  }
}

// 3. Report.
console.log('')
if (problems.length > 0) {
  console.log('结论：现在这样装上去加载不了。')
  for (const problem of problems) console.log(`  - ${problem}`)
  console.log('\n修法：')
  console.log('  1) cd 到插件目录，npm install && npm run build，确认 lib/index.js 与 lib/client.js 存在')
  console.log('  2) dsh plugin --profile web remove dsh-pad（先清掉半成品）')
  console.log('  3) dsh plugin --profile web add <插件绝对路径>')
  console.log('  4) 重启鲸屿，再运行 node scripts/doctor.mjs 复查')
  process.exit(1)
}

if (notes.length > 0) {
  console.log('提示：')
  for (const note of notes) console.log(`  - ${note}`)
}

console.log('结论：没问题，可以安装或启动。')
console.log('\n安装：dsh plugin --profile web add ' + root)
console.log('卸载：dsh plugin --profile web remove dsh-pad')
