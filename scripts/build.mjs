/**
 * Build both halves of the plugin.
 *
 * - lib/index.js — Host half (Node ESM). A dependency-free recovery bootstrap
 *   evaluates the embedded body only after verifying the complete release.
 *   Platform peers stay external and resolve from the running dsh installation.
 * - lib/client.js — Browser half in the dsh client-module closure format:
 *   `window.__ModuleLoader__.load({ id, factory: (require) => { … } })`.
 *   Only the shell's platform modules are left to the injected `require`;
 *   everything else is inlined, mirroring dsh's own client bundle preset.
 */
import { readFileSync } from 'node:fs'
import { build, context } from 'esbuild'
import { buildHost } from './host-build.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const watch = process.argv.includes('--watch')

/** Specifiers the dsh web shell seeds into the client module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const client = {
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: 'linked',
  external: PLATFORM_MODULES,
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
}

if (watch) {
  // The host build contains two dependent bundles. A small dependency watcher
  // invokes them together so each rebuild gets matching embedded code and ids.
  const { watch: watchFiles } = await import('node:fs')
  let hostBuild = Promise.resolve()
  let timer
  const rebuildHost = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      hostBuild = hostBuild.catch(() => {}).then(() => buildHost())
      void hostBuild.catch(error => console.error('[dsh-pad] Host rebuild failed', error))
    }, 60)
  }
  await buildHost()
  watchFiles(new URL('../src/', import.meta.url), { recursive: true }, rebuildHost)
  await (await context(client)).watch()
} else {
  await Promise.all([buildHost(), build(client)])
}
