import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { values } = parseArgs({ options: {
  assets: { type: 'string', default: '/tmp/conclave-tailcat-runtime' },
  state: { type: 'string' },
} });
const assets = path.resolve(values.assets);
const state = values.state ? path.resolve(values.state) : await mkdtemp(path.join(tmpdir(), 'conclave-tailcat-public-'));
await mkdir(state, { recursive: true, mode: 0o700 });
const infoFile = path.join(state, 'public.json');
const instance = randomBytes(16).toString('hex');
let server;
let tunnel;
let tunnelClosed;
let tunnelFailure;
let log;
let published = false;
let stopping = false;
let stoppingPromise;
let publicUrl;
let registered = false;

function stop() {
  if (stoppingPromise) return stoppingPromise;
  stopping = true;
  stoppingPromise = (async () => {
    if (published) await rm(infoFile, { force: true });
    if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
      tunnel.kill('SIGTERM');
      await Promise.race([tunnelClosed, delay(3_000)]);
      if (tunnel.exitCode === null && tunnel.signalCode === null) {
        tunnel.kill('SIGKILL');
        await Promise.race([tunnelClosed, delay(1_000)]);
      }
    }
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (log && !log.destroyed) await new Promise((resolve) => log.end(resolve));
  })();
  return stoppingPromise;
}

function failed() {
  if (stopping) return;
  console.error(`公网静态入口已停止；详情仅保存在 ${state} 内的私有日志。`);
  process.exitCode = 1;
  void stop();
}

process.on('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.on('SIGTERM', () => { void stop().then(() => process.exit(0)); });

try {
  const [sourceHtml, sourceApp, css, productionCss, wasmJs, wasm] = await Promise.all([
    readFile(path.join(here, 'index.html'), 'utf8'),
    readFile(path.join(here, 'app.mjs'), 'utf8'),
    readFile(path.join(here, 'experiment.css')),
    readFile(path.join(root, 'packages/web/src/styles.css'), 'utf8'),
    readFile(path.join(assets, 'wasm_exec.js')),
    readFile(path.join(assets, 'main.wasm.gz')),
  ]);
  const hostSection = /\s*<section\s+id="host"[^>]*>[\s\S]*?<\/section>/g;
  if ([...sourceHtml.matchAll(hostSection)].length !== 1) throw new Error('无法明确移除本机管理界面');
  const html = sourceHtml.replace(hostSection, '');
  const hostStart = sourceApp.indexOf("if (location.pathname === '/host') {");
  const clientBoundary = "} else {\n  $('client').hidden = false;";
  const clientStart = sourceApp.indexOf(clientBoundary, hostStart);
  if (hostStart < 0 || clientStart < 0) throw new Error('无法明确移除本机管理逻辑');
  const app = Buffer.from(sourceApp.slice(0, hostStart) + "{\n  $('client').hidden = false;" + sourceApp.slice(clientStart + clientBoundary.length));
  const tokens = productionCss.match(/:root,\s*\[data-palette='studio'\]\s*\{[\s\S]*?\n\}/)?.[0];
  if (!tokens) throw new Error('无法读取 Conclave 样式令牌');
  // Only these immutable buffers are public. No request can read a directory or reach core.
  const files = new Map([
    ['/', [Buffer.from(html), 'text/html; charset=utf-8']],
    ['/client', [Buffer.from(html), 'text/html; charset=utf-8']],
    ['/app.mjs', [app, 'text/javascript; charset=utf-8']],
    ['/experiment.css', [css, 'text/css; charset=utf-8']],
    ['/tokens.css', [Buffer.from(tokens), 'text/css; charset=utf-8']],
    ['/assets/wasm_exec.js', [wasmJs, 'text/javascript; charset=utf-8']],
    ['/assets/main.wasm.gz', [wasm, 'application/gzip']],
  ]);
  let origin;
  server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://tailcat.dev wss:; img-src 'self' data:; frame-ancestors 'none'");
    res.setHeader('X-Conclave-Static-Instance', instance);
    const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { notFound(); return; }
    const allowedHosts = [new URL(origin).host, ...(publicUrl ? [new URL(publicUrl).host] : [])];
    if (!allowedHosts.includes(req.headers.host)) { notFound(); return; }
    let pathname;
    try { pathname = new URL(req.url, origin).pathname; } catch { notFound(); return; }
    const file = files.get(pathname);
    if (!file) { notFound(); return; }
    const [data, type] = file;
    if (pathname.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=300');
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  server.on('error', failed);
  origin = `http://127.0.0.1:${server.address().port}`;

  const isolated = await mkdtemp(path.join(state, 'public-runtime-'));
  const config = path.join(isolated, 'empty.yml');
  await writeFile(config, '{}\n', { mode: 0o600, flag: 'wx' });
  log = createWriteStream(path.join(state, 'public-tunnel.log'), { flags: 'wx', mode: 0o600 });
  await new Promise((resolve, reject) => { log.once('open', resolve); log.once('error', reject); });
  log.on('error', failed);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TUNNEL_|CLOUDFLARED_|CLOUDFLARE_)/i.test(key)));
  Object.assign(env, { XDG_CONFIG_HOME: isolated, XDG_CACHE_HOME: isolated });
  tunnel = spawn(path.join(assets, 'cli/cloudflared'), [
    'tunnel', '--config', config, '--no-autoupdate', '--protocol', 'http2', '--url', origin,
  ], { cwd: isolated, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  tunnelClosed = new Promise((resolve) => tunnel.once('close', resolve));
  let recent = '';
  const inspect = (chunk) => {
    recent = (recent + chunk.toString('utf8')).slice(-32_768);
    const found = recent.match(/https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com\b/);
    if (found) publicUrl = found[0];
    if (/\bRegistered tunnel connection\b/i.test(recent)) registered = true;
  };
  for (const stream of [tunnel.stdout, tunnel.stderr]) {
    stream.pipe(log, { end: false });
    stream.on('data', inspect);
  }
  tunnel.once('error', () => { tunnelFailure = true; if (published) failed(); });
  tunnel.once('close', () => { tunnelFailure = true; if (published) failed(); });

  const deadline = Date.now() + 120_000;
  while ((!publicUrl || !registered) && !tunnelFailure && !stopping && Date.now() < deadline) await delay(150);
  let reachable = false;
  while (publicUrl && registered && !tunnelFailure && !stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`${publicUrl}/client`, { redirect: 'error', signal: AbortSignal.timeout(5_000), cache: 'no-store' });
      if (response.status === 200 && response.headers.get('x-conclave-static-instance') === instance && await response.text() === html) {
        reachable = true;
        break;
      }
      await response.body?.cancel();
    } catch { /* Registration can precede DNS and edge availability. */ }
    await delay(500);
  }
  if (!reachable || tunnelFailure || stopping) throw new Error('公网入口未就绪；未写入 public.json');
  await writeFile(infoFile, JSON.stringify({ url: publicUrl, pid: process.pid, tunnelPid: tunnel.pid, origin }, null, 2), { mode: 0o600, flag: 'wx' });
  published = true;
  if (tunnelFailure) throw new Error('公网隧道已退出');
  console.log(`公网静态入口已就绪：${publicUrl}/client`);
  console.log(`状态保存在：${infoFile}（权限 0600）；按 Ctrl+C 停止。`);
} catch (error) {
  console.error(`${error.message}；详情仅保存在 ${state} 内的私有日志。`);
  await stop();
  process.exitCode = 1;
}
