/**
 * A single-file ESM entry with a dependency-free recovery bootstrap. The body is
 * bundled as CommonJS and kept in a string: neither its imports nor its code are
 * evaluated until recovery and on-disk identity checks have completed.
 */
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))

/** @param {{ bodySource?: string, write?: boolean, logLevel?: string }} [options] */
export async function buildHost(options = {}) {
  const body = await build({
    absWorkingDir: root,
    ...(options.bodySource === undefined
      ? { entryPoints: ['src/index.ts'] }
      : { stdin: { contents: options.bodySource, resolveDir: root, sourcefile: 'src/test-host-body.ts', loader: 'ts' } }),
    outfile: 'lib/body.cjs', bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node22',
    sourcemap: 'inline', external: ['@deepseek-ai/*'],
    define: { 'import.meta.url': '__dshPadModuleUrl' }, logLevel: 'silent',
  })
  const bodySource = body.outputFiles[0].text
  const result = await build({
    absWorkingDir: root, entryPoints: ['src/host-entry.ts'], outfile: 'lib/index.js',
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', sourcemap: 'linked',
    define: { '__DSH_PAD_HOST_BODY__': JSON.stringify(bodySource) }, logLevel: options.logLevel ?? 'silent',
  })
  const entry = result.outputFiles.find(file => file.path.endsWith('index.js'))
  if (entry === undefined) throw new Error('Missing host entry output')
  const bodyId = createHash('sha256').update(bodySource).digest('hex')
  const entrySource = entry.text + `\n// dsh-pad-body:${bodyId}\n`
  const id = createHash('sha256').update(entrySource).digest('hex')
  const marker = `\n// dsh-pad-build:${id}\n`
  entry.contents = Buffer.from(entrySource + marker)
  if (options.write !== false) {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
    for (const file of result.outputFiles) await writeFile(file.path, file.contents)
  }
  return { ...result, buildId: id }
}
