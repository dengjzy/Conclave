import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { build } from 'vite'
import { readTailcatBrowserAssets } from '../../../scripts/tailcat-browser-assets.mjs'

const directory = fileURLToPath(new URL('..', import.meta.url))
const web = path.resolve(directory, '../web')
const dist = path.join(directory, 'dist')
const stylesheet = await readFile(path.join(web, 'src/styles.css'), 'utf8')
const studio = stylesheet.match(/:root,\s*\[data-palette='studio'\]\s*\{([\s\S]*?)\n\}/)?.[1]
if (!studio) throw new Error('Studio colour tokens were not found')
function lightToken(name) {
  const value = studio.match(new RegExp(`--${name}:\\s*light-dark\\(\\s*(#[0-9a-fA-F]+)\\s*,`))?.[1]
  if (!value) throw new Error(`Native colour requires a concrete Studio light token: ${name}`)
  return value
}
const nativeColors = [
  ['agents_surface', 'bg'], ['agents_mark', 'mark-mono'], ['agents_mark_text', 'surface'],
  ['colorPrimary', 'accent'], ['colorPrimaryDark', 'accent'], ['colorAccent', 'accent']
]
await writeFile(path.join(directory, 'android/app/src/main/res/values/colors.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated from packages/web/src/styles.css by scripts/build.mjs. -->\n<resources>\n${nativeColors.map(([name, token]) => `    <color name="${name}">${lightToken(token)}</color>`).join('\n')}\n</resources>\n`)
const cache = process.env.CONCLAVE_MOBILE_ASSET_DIR || path.join(directory, '.cache', 'tailcat')
const verified = await readTailcatBrowserAssets(cache)
await build({ configFile: false, root: web, publicDir: false, base: '/', build: {
  outDir: dist, emptyOutDir: true, target: 'chrome123',
  rollupOptions: { input: path.join(web, 'mobile.html') }
} })
await rename(path.join(dist, 'mobile.html'), path.join(dist, 'index.html'))
const htmlPath = path.join(dist, 'index.html')
const policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https: wss:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
const html = await readFile(htmlPath, 'utf8')
await writeFile(htmlPath, html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`))
await mkdir(path.join(dist, 'assets'), { recursive: true })
for (const asset of verified) {
  // Android treats .gz assets specially, so package decoded WASM under its real extension.
  await writeFile(path.join(dist, 'assets', asset.file.replace(/\.gz$/, '')), asset.file.endsWith('.gz') ? gunzipSync(asset.bytes) : asset.bytes)
}
console.log('Built agents-go with verified, local Tailcat assets.')
await writeFile(path.join(dist, 'unsupported.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>请更新 Android System WebView</title><body><h1>请更新 Android System WebView</h1><p>agents-go 需要 WebView 123 或更新版本。更新后重新打开应用。</p></body></html>')
