import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function signedHostBundle(body = '// fake host'.padEnd(1200, ' ')): string {
  const bodyDigest = createHash('sha256').update(body).digest('hex')
  const withBody = `${body}\n// dsh-pad-body:${bodyDigest}`
  const buildDigest = createHash('sha256').update(withBody).digest('hex')
  return `${withBody}\n// dsh-pad-build:${buildDigest}\n`
}

async function createFakeInstall(directory = 'ascii', hostText = signedHostBundle()) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-pad-doctor-'))
  roots.push(base)
  const root = join(base, directory)
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'scripts', 'doctor.mjs'), await readFile(new URL('../scripts/doctor.mjs', import.meta.url)))
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'dsh-pad', version: '0.1.0', main: 'lib/index.js',
    exports: { './client': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(root, 'lib', 'index.js'), hostText)
  await writeFile(join(root, 'lib', 'client.js'), '// fake client'.padEnd(1200, ' '))
  await writeFile(join(root, 'cordis.patch.yml'), '- insert:\n    - id: dsh-pad\n      name: dsh-pad\n')
  return { base, root }
}

async function runDoctor(base: string, root: string): Promise<{ code: number | null, text: string }> {
  const output = join(base, 'doctor-output.txt')
  // Both DSH_HOME and HOME are isolated; the child never reads the user's
  // profile, installation, credentials or data sources.
  const handle = await open(output, 'w')
  try {
    const child = spawn(process.execPath, [join(root, 'scripts', 'doctor.mjs')], {
      cwd: root, stdio: ['ignore', handle.fd, handle.fd],
      env: { ...process.env, DSH_HOME: join(base, 'fake-dsh-home'), HOME: join(base, 'fake-home'), USERPROFILE: join(base, 'fake-home') },
    })
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    const text = await readFile(output, 'utf8')
    return { code, text }
  } finally {
    await handle.close()
  }
}

describe('doctor installation path', () => {
  it.each(['ascii', 'doctor space', '中文安装', 'literal %20 #hash'])('checks a fake install in a %s path', async directory => {
    const { base, root } = await createFakeInstall(directory)
    const { code, text } = await runDoctor(base, root)
    expect(code, text).toBe(0)
    expect(text).toContain('没问题，可以安装或启动')
    expect(text).toContain('lib/index.js 完整性')
    expect(text).toContain(root)
    expect(text).not.toContain('ENOENT')
  })

  it('fails when lib/index.js is missing or has invalid integrity markers', async () => {
    const { base, root } = await createFakeInstall('corrupt-host', '// missing markers'.padEnd(1200, 'x'))
    const { code, text } = await runDoctor(base, root)
    expect(code, text).toBe(1)
    expect(text).toContain('lib/index.js 完整性')
    expect(text).toContain('dsh-pad-build')
  })

  it('warns when a valid pending update journal exists', async () => {
    const { base, root } = await createFakeInstall('pending-journal')
    const id = randomUUID()
    const stagedDir = join(root, '.dsh-pad-update-backup', id, 'staged')
    await mkdir(join(stagedDir, 'lib'), { recursive: true })
    const files = [
      ['lib/index.js', signedHostBundle('// next host'.padEnd(1200, 'a'))],
      ['lib/client.js', '// next client'.padEnd(1200, 'b')],
      ['package.json', JSON.stringify({ name: 'dsh-pad', version: '0.2.0' })],
      ['cordis.patch.yml', '- insert:\n    - id: dsh-pad\n      name: dsh-pad\n'],
    ] as const
    const records = []
    for (const [rel, content] of files) {
      await writeFile(join(stagedDir, rel), content)
      const buf = Buffer.from(content, 'utf8')
      records.push({ path: rel, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') })
    }
    await writeFile(join(root, '.dsh-pad-update.json'), JSON.stringify({ format: 1, id, files: records }))
    const { code, text } = await runDoctor(base, root)
    expect(code, text).toBe(0)
    expect(text).toContain('.dsh-pad-update.json')
    expect(text).toContain('待恢复的更新事务')
  })

  it('fails when .dsh-pad-update.json is corrupt', async () => {
    const { base, root } = await createFakeInstall('corrupt-journal')
    await writeFile(join(root, '.dsh-pad-update.json'), '{not-valid-json')
    const { code, text } = await runDoctor(base, root)
    expect(code, text).toBe(1)
    expect(text).toContain('.dsh-pad-update.json')
    expect(text).toContain('损坏')
  })
})
