import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { createGateway } from './gateway.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const { values } = parseArgs({ options: {
  assets: { type: 'string', default: '/tmp/conclave-tailcat-runtime' },
  state: { type: 'string' },
  'client-url': { type: 'string' },
  port: { type: 'string', default: '0' },
} });
const externalClient = values['client-url'] ? new URL(values['client-url']) : null;
if (externalClient && (externalClient.protocol !== 'https:' || externalClient.username || externalClient.password || externalClient.search || externalClient.hash)) {
  throw new Error('--client-url 必须是无查询参数、凭据或 fragment 的 HTTPS 网页地址');
}
const assets = path.resolve(values.assets);
const state = values.state ? path.resolve(values.state) : await mkdtemp(path.join(tmpdir(), 'conclave-tailcat-test-'));
await mkdir(state, { recursive: true, mode: 0o700 });
const coreHome = await mkdtemp(path.join(state, 'core-'));
const adminToken = randomBytes(32).toString('base64url');
const children = [];
const files = [];
let gateway;
let http;
let stopping = false;
let stoppingPromise;

function start(command, args, env, log) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', log.fd, log.fd] });
  children.push(child);
  child.on('error', () => {});
  return child;
}
async function waitFile(file, child, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null) throw new Error(`测试进程提前退出，检查 ${state} 内的私有日志`);
    try { const text = await readFile(file, 'utf8'); if (text.trim()) return text; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`启动超时，检查 ${state} 内的私有日志`);
}
function stop() {
  if (stoppingPromise) return stoppingPromise;
  stopping = true;
  stoppingPromise = (async () => {
    if (http) { http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); }
    if (gateway) await gateway.close();
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }));
    await Promise.all(files.map((file) => file.close()));
  })();
  return stoppingPromise;
}
process.on('SIGINT', () => stop().then(() => process.exit(0)));
process.on('SIGTERM', () => stop().then(() => process.exit(0)));

try {
  const coreLog = await open(path.join(state, 'core.log'), 'wx', 0o600);
  files.push(coreLog);
  const core = start(process.execPath, ['--import', 'tsx', 'packages/core/src/main.ts', '--host', '127.0.0.1', '--port', '0'], {
    CONCLAVE_HOME: coreHome, CONCLAVE_HOST: '127.0.0.1', CONCLAVE_PORT: '0',
  }, coreLog);
  const endpoint = JSON.parse(await waitFile(path.join(coreHome, 'core.json'), core));
  function coreCall(method, { signal }) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/?token=${encodeURIComponent(endpoint.token)}`);
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        socket.close();
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new Error('read cancelled'));
      const timer = setTimeout(() => finish(new Error('core timeout')), 10000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      socket.addEventListener('open', () => {
        if (!finished) socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'system.hello' ? { protocolVersion: endpoint.protocolVersion } : {} }));
      });
      socket.addEventListener('message', ({ data }) => {
        try {
          const result = JSON.parse(data);
          if (result.id !== 1) return;
          if (result.error) finish(new Error('core rejected request')); else finish(null, result.result);
        } catch { finish(new Error('invalid core response')); }
      });
      socket.addEventListener('error', () => finish(new Error('core connection failed')));
      socket.addEventListener('close', () => { if (!finished) finish(new Error('core disconnected')); });
    });
  }
  gateway = await createGateway({ coreCall });
  const nativePort = gateway.address.port;
  const tailcatLog = await open(path.join(state, 'tailcat.log'), 'wx', 0o600);
  files.push(tailcatLog);
  const addressFile = path.join(state, 'tailcat.addr');
  const tailcat = start(path.join(assets, 'cli/tailcat'), ['serve', '--key=new', String(nativePort)], {
    TAILCAT_ADDR_FILE: addressFile,
    XDG_CONFIG_HOME: path.join(state, 'config'), XDG_CACHE_HOME: path.join(state, 'cache'),
  }, tailcatLog);
  const address = (await waitFile(addressFile, tailcat)).trim();
  const productionCss = await readFile(path.join(root, 'packages/web/src/styles.css'), 'utf8');
  const tokens = productionCss.match(/:root,\s*\[data-palette='studio'\]\s*\{[\s\S]*?\n\}/)?.[0];
  if (!tokens) throw new Error('无法读取 Conclave 样式令牌');
  let origin;
  const staticFiles = new Map([
    ['/', ['index.html', 'text/html']], ['/client', ['index.html', 'text/html']], ['/host', ['index.html', 'text/html']],
    ['/app.mjs', ['app.mjs', 'text/javascript']], ['/experiment.css', ['experiment.css', 'text/css']],
    ['/assets/wasm_exec.js', [path.join(assets, 'wasm_exec.js'), 'text/javascript']],
    ['/assets/main.wasm.gz', [path.join(assets, 'main.wasm.gz'), 'application/gzip']],
  ]);
  function authorized(req) {
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${adminToken}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
  async function body(req) {
    let data = '';
    for await (const chunk of req) { data += chunk; if (data.length > 2048) throw new Error('body too large'); }
    return JSON.parse(data || '{}');
  }
  http = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://tailcat.dev wss:; img-src 'self' data:; frame-ancestors 'none'");
    try {
      if (`http://${req.headers.host}` !== origin) return json(res, 403, { error: 'host rejected' });
      const pathname = new URL(req.url, origin).pathname;
      if (pathname.startsWith('/admin/')) {
        if (!authorized(req) || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { error: 'forbidden' });
        if (pathname === '/admin/status' && req.method === 'GET') return json(res, 200, { devices: gateway.listDevices() });
        if (pathname === '/admin/invite' && req.method === 'POST') {
          const invitation = gateway.createInvitation();
          const payload = { version: 1, address, port: nativePort, ticket: invitation.ticket, expiresAt: invitation.expiresAt };
          const url = `${externalClient?.href ?? `${origin}/client`}#pair=${encodeURIComponent(JSON.stringify(payload))}`;
          const code = QRCode.create(url, { errorCorrectionLevel: 'M' });
          const size = code.modules.size;
          let d = '';
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (code.modules.get(y, x)) d += `M${x + 4},${y + 4}h1v1h-1z`;
          const qr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size + 8} ${size + 8}" shape-rendering="crispEdges"><path fill="currentColor" d="${d}"/></svg>`;
          return json(res, 200, { url, qr, expiresAt: invitation.expiresAt, external: Boolean(externalClient) });
        }
        if (pathname === '/admin/revoke' && req.method === 'POST') {
          const input = await body(req);
          return json(res, 200, { revoked: typeof input.deviceId === 'string' && gateway.revoke(input.deviceId) });
        }
        return json(res, 404, { error: 'not found' });
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'method rejected' });
      if (pathname === '/tokens.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(tokens); }
      const file = staticFiles.get(pathname);
      if (!file) return json(res, 404, { error: 'not found' });
      const data = await readFile(path.resolve(here, file[0]));
      res.writeHead(200, { 'Content-Type': file[1], 'Content-Length': data.length });
      res.end(data);
    } catch { if (!res.headersSent) json(res, 500, { error: 'experiment request failed' }); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(Number(values.port), '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${http.address().port}`;
  const info = { origin, clientUrl: externalClient?.href ?? `${origin}/client`, hostUrl: `${origin}/host#admin=${adminToken}`, coreHome, corePort: endpoint.port, protocolVersion: endpoint.protocolVersion, pid: process.pid, corePid: core.pid, tailcatPid: tailcat.pid };
  await writeFile(path.join(state, 'experiment.json'), JSON.stringify(info, null, 2), { mode: 0o600, flag: 'wx' });
  for (const child of children) child.once('exit', () => {
    if (!stopping) { console.error('实验组件退出，正在停止本次实验'); stop().then(() => process.exit(1)); }
  });
  console.log(`Tailcat 网页实验已启动：${origin}`);
  console.log(`本机配对入口保存在：${path.join(state, 'experiment.json')}（权限 0600）`);
  console.log('只读测试 core；按 Ctrl+C 停止本次实验。');
} catch (error) {
  console.error(error.message);
  await stop();
  process.exitCode = 1;
}
