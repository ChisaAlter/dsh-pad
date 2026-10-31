import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('packed release preparation', () => {
  it.each([true, false])('handles a sourceless release with complete bundles=%s without rebuilding', async complete => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-pad-packed-'))
    roots.push(root)
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, 'lib'))
    await writeFile(join(root, 'scripts/prepare.mjs'), await readFile(new URL('../scripts/prepare.mjs', import.meta.url)))
    if (complete) {
      await writeFile(join(root, 'lib/index.js'), '// ready host')
      await writeFile(join(root, 'lib/client.js'), '// ready client')
    }
    // If the consumer has esbuild, a release must still not try to rebuild src.
    await mkdir(join(root, 'node_modules/esbuild'), { recursive: true })
    await writeFile(join(root, 'node_modules/esbuild/package.json'), JSON.stringify({ name: 'esbuild', type: 'module', exports: './index.js' }))
    await writeFile(join(root, 'node_modules/esbuild/index.js'), 'throw new Error("Packed releases must not load esbuild")')
    const output = join(root, 'output.txt')
    const handle = await open(output, 'w')
    try {
      const child = spawn(process.execPath, [join(root, 'scripts/prepare.mjs')], { cwd: root, stdio: ['ignore', handle.fd, handle.fd] })
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
      const text = await readFile(output, 'utf8')
      expect(code, text).toBe(complete ? 0 : 1)
      expect(text).not.toContain('Packed releases must not load esbuild')
      if (!complete) expect(text).toContain('发行包缺少 lib/')
    } finally { await handle.close() }
  })
})
