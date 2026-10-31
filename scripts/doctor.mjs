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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const problems = []
const notes = []

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
