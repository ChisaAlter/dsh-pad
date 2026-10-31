import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('doctor installation path', () => {
  it.each(['ascii', 'doctor space', '中文安装', 'literal %20 #hash'])('checks a fake install in a %s path', async directory => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-pad-doctor-'))
    roots.push(base)
    const root = join(base, directory)
    await mkdir(join(root, 'scripts'), { recursive: true })
    await mkdir(join(root, 'lib'), { recursive: true })
    await writeFile(join(root, 'scripts', 'doctor.mjs'), await readFile(new URL('../scripts/doctor.mjs', import.meta.url)))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'dsh-pad', version: '0.1.0', exports: { './client': './lib/client.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(root, 'lib', 'index.js'), '// fake host'.padEnd(1200, ' '))
    await writeFile(join(root, 'lib', 'client.js'), '// fake client'.padEnd(1200, ' '))
    await writeFile(join(root, 'cordis.patch.yml'), '- insert: []')
    const output = join(base, 'doctor-output.txt')
    // Both DSH_HOME and HOME are isolated; the child never reads the user's
    // profile, installation, credentials or data sources.
    const { open } = await import('node:fs/promises')
    const handle = await open(output, 'w')
    try {
      const child = spawn(process.execPath, [join(root, 'scripts', 'doctor.mjs')], {
        cwd: root, stdio: ['ignore', handle.fd, handle.fd],
        env: { ...process.env, DSH_HOME: join(base, 'fake-dsh-home'), HOME: join(base, 'fake-home'), USERPROFILE: join(base, 'fake-home') },
      })
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
      const text = await readFile(output, 'utf8')
      expect(code, text).toBe(0)
      expect(text).toContain('没问题，可以安装或启动')
      expect(text).toContain(root)
      expect(text).not.toContain('ENOENT')
    } finally {
      await handle.close()
    }
  })
})
