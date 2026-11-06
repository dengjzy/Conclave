import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readTailcatBrowserAssets } from './tailcat-browser-assets.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const web = path.join(root, 'packages/web')
const built = path.join(web, 'dist')
const standalone = path.join(web, 'remote-dist')
const cache = process.env.CONCLAVE_MOBILE_ASSET_DIR || process.env.CONCLAVE_REMOTE_ASSETS || path.join(root, 'packages/mobile/.cache/tailcat')
const assets = await readTailcatBrowserAssets(cache)
const html = await readFile(path.join(built, 'mobile.html'), 'utf8')
const desktop = await readFile(path.join(built, 'index.html'), 'utf8')
const policy = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self' https: wss:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
const page = html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
const desktopPage = desktop.replace('<head>', `<head>\n    <meta name="conclave-remote-client" content="true" />\n    <meta name="referrer" content="no-referrer" />\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`).replace(/\s*<link rel="manifest"[^>]*>/, '')
await writeFile(path.join(built, 'remote.html'), desktopPage)
await mkdir(path.join(built, 'assets'), { recursive: true })
for (const asset of assets) await writeFile(path.join(built, 'assets', asset.file), asset.bytes)
await writeFile(path.join(built, 'mobile.html'), page)
await rm(standalone, { recursive: true, force: true })
await mkdir(standalone, { recursive: true })
await cp(path.join(built, 'assets'), path.join(standalone, 'assets'), { recursive: true })
await writeFile(path.join(standalone, 'index.html'), desktopPage)
await writeFile(path.join(standalone, 'remote.html'), desktopPage)
await mkdir(path.join(standalone, 'conclave'), { recursive: true })
await writeFile(path.join(standalone, 'conclave/index.html'), desktopPage)
await writeFile(path.join(standalone, 'mobile.html'), page)
await writeFile(path.join(standalone, '_headers'), '/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n  Cache-Control: no-cache\n')
console.log('Built standalone remote client: packages/web/remote-dist (serve at an HTTPS origin root)')
