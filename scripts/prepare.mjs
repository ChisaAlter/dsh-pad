/**
 * Install-time hook (`prepare`).
 *
 * `dsh plugin add` either links the checkout or installs it as a dependency.
 * In both cases the install must survive an environment that never granted the
 * build script: pnpm answers "Ignored build scripts" when it refuses to run it,
 * and a dependency install does not carry devDependencies, so esbuild can be
 * absent. A missing toolchain must not turn a working `lib/` into a failed
 * install, and a missing `lib/` must fail loudly with the fix instead of
 * producing a plugin that cannot load.
 */
import { existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const built = existsSync(new URL('lib/index.js', root)) && existsSync(new URL('lib/client.js', root))
const source = existsSync(new URL('src/index.ts', root))

// Packed releases contain ready-to-load bundles without a source toolchain.
// A consumer may happen to provide esbuild; that must not trigger a missing-src
// rebuild or invalidate an otherwise complete installation.
if (!source) {
  if (built) process.exit(0)
  console.error('dsh-pad: 发行包缺少 lib/，且不含可构建的源码，请重新安装完整发行包。')
  process.exit(1)
}

let esbuild
try {
  esbuild = await import('esbuild')
} catch {
  esbuild = undefined
}

if (esbuild === undefined) {
  if (built) {
    console.warn('dsh-pad: esbuild 不可用，沿用仓库里已有的 lib/（未重新构建）')
    process.exit(0)
  }
  console.error('dsh-pad: 缺少 lib/ 且没有 esbuild，无法构建。请在插件目录执行 `npm install && npm run build`，或安装时允许构建脚本（见 README）。')
  process.exit(1)
}

await import('./build.mjs')
