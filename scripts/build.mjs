/**
 * Build both halves of the plugin.
 *
 * - lib/index.js — Host half (Node ESM). Every @deepseek-ai package stays an
 *   import so the running dsh install answers it (peer resolution).
 * - lib/client.js — Browser half in the dsh client-module closure format:
 *   `window.__ModuleLoader__.load({ id, factory: (require) => { … } })`.
 *   Only the shell's platform modules are left to the injected `require`;
 *   everything else is inlined, mirroring dsh's own client bundle preset.
 */
import { readFileSync } from 'node:fs'
import { build, context } from 'esbuild'

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

const host = {
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: 'linked',
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
}

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
  for (const options of [host, client]) await (await context(options)).watch()
} else {
  await Promise.all([build(host), build(client)])
}
