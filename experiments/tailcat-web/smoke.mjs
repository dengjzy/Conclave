import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const requireWeb = createRequire(path.resolve(here, '../../packages/web/package.json'));
const { chromium } = requireWeb('playwright-core');
const infoPath = process.argv[2];
if (!infoPath) throw new Error('Usage: node smoke.mjs /tmp/.../experiment.json');
const info = JSON.parse(await readFile(infoPath, 'utf8'));
const outputDir = path.dirname(infoPath);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const checks = [];
const relayOrigins = new Set();
const browserErrors = [];
const redact = (text) => text.replace(/#(?:pair|admin)=[^\s"']+/g, '#[redacted]').replace(/tc[A-Za-z0-9_-]{30,}/g, '[redacted]');
const report = { checkedAt: new Date().toISOString(), mode: 'real Chrome + public DERP + native Tailcat + isolated Conclave core', clientOrigin: new URL(info.clientUrl ?? info.origin).origin, protocolVersion: info.protocolVersion, checks, relayOrigins: [], browserErrors, rttMs: [] };
function observe(page) {
  page.on('pageerror', (error) => browserErrors.push(redact(error.message)));
  page.on('websocket', (ws) => { if (ws.url().startsWith('wss:')) relayOrigins.add(new URL(ws.url()).origin); });
}
try {
  const hostContext = await browser.newContext({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 2 });
  const host = await hostContext.newPage();
  observe(host);
  await host.goto(info.hostUrl);
  await host.getByRole('button', { name: '生成一次性二维码' }).click();
  await host.locator('#pair-link').waitFor({ state: 'visible' });
  const invitationUrl = await host.locator('#pair-link').getAttribute('href');
  const qrPng = PNG.sync.read(await host.locator('#qr').screenshot());
  const decoded = jsQR(new Uint8ClampedArray(qrPng.data), qrPng.width, qrPng.height);
  assert.ok(decoded?.data === invitationUrl, 'rendered QR must decode to the exact invitation URL');
  checks.push('QR image decodes to exact pairing URL');

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  // The browser cannot access the test core directly. Only the gateway knows its endpoint/token.
  let directCoreRequests = 0;
  await context.route(`http://127.0.0.1:${info.corePort}/**`, (route) => { directCoreRequests++; return route.abort(); });
  await context.routeWebSocket(new RegExp(`^wss?://(?:127\\.0\\.0\\.1|localhost):${info.corePort}(?:/|$)`), (socket) => {
    directCoreRequests++;
    socket.close();
  });
  const client = await context.newPage();
  observe(client);
  await client.goto(invitationUrl);
  await client.waitForFunction(() => window.tailcatExperiment?.ready, null, { timeout: 120000 });
  const connected = await client.evaluate(() => window.tailcatExperiment.connect());
  assert.equal(connected.hello.protocolVersion, info.protocolVersion);
  assert.deepEqual(connected.tasks, []);
  checks.push('WASM paired through public DERP and read real system.hello + tasks.list');
  assert.equal(new URL(client.url()).hash, '', 'pairing secret removed from address bar');
  checks.push('Pairing URL fragment removed after load');

  const echoes = ['你好，Conclave 👋', 'a'.repeat(4096), 'line one\nline two'];
  for (const text of echoes) {
    const result = await client.evaluate((text) => window.tailcatExperiment.request('echo', { text }), text);
    assert.equal(result.text, text);
  }
  checks.push('Unicode, multiline and 4 KiB payload echo round trips');
  const denied = await client.evaluate(async () => {
    try { await window.tailcatExperiment.request('core', { method: 'system.setChatSettings' }); return 'unexpected-success'; }
    catch (error) { return error.code; }
  });
  assert.equal(denied, 'method-not-allowed');
  checks.push('Paired browser is still denied non-allowlisted core methods');
  for (let i = 0; i < 5; i++) report.rttMs.push(await client.evaluate(async () => {
    const start = performance.now();
    await window.tailcatExperiment.request('ping');
    return Math.round(performance.now() - start);
  }));
  await client.getByRole('button', { name: '测量往返' }).click();
  await client.getByRole('button', { name: '发送并验证回传' }).click();
  await client.waitForFunction(() => document.querySelector('#events').textContent.includes('回传一致'));
  await client.screenshot({ path: path.join(outputDir, 'client-connected.png'), fullPage: true });

  await client.evaluate(() => window.tailcatExperiment.disconnect());
  const resumed = await client.evaluate(() => window.tailcatExperiment.connect());
  assert.equal(resumed.hello.protocolVersion, info.protocolVersion);
  checks.push('Disconnect and reconnect using device credentials');
  await client.reload();
  await client.waitForFunction(() => window.tailcatExperiment?.ready, null, { timeout: 120000 });
  const reloaded = await client.evaluate(() => window.tailcatExperiment.connect());
  assert.deepEqual(reloaded.tasks, []);
  checks.push('Page reload reconnects without reusing pairing ticket');

  const reusedContext = await browser.newContext();
  const reused = await reusedContext.newPage();
  observe(reused);
  await reused.goto(invitationUrl);
  await reused.waitForFunction(() => window.tailcatExperiment?.ready, null, { timeout: 120000 });
  const reusedResult = await reused.evaluate(async () => {
    try { await window.tailcatExperiment.connect(); return 'unexpected-success'; }
    catch (error) { window.tailcatExperiment.disconnect(); return error.code ?? error.message; }
  });
  assert.equal(reusedResult, 'invalid-invitation');
  checks.push('Second browser cannot reuse a consumed invitation');
  await reusedContext.close();

  await host.locator('#devices button').first().click();
  await client.waitForFunction(() => document.querySelector('#connected').hidden, null, { timeout: 15000 });
  const revoked = await client.evaluate(async () => {
    try { await window.tailcatExperiment.connect(); return 'unexpected-success'; }
    catch (error) { window.tailcatExperiment.disconnect(); return error.code ?? error.message; }
  });
  assert.equal(revoked, 'unauthorized');
  checks.push('Revocation disconnects an active device and rejects reconnect');
  assert.equal(directCoreRequests, 0);
  assert.ok(relayOrigins.size > 0, 'a real public DERP WebSocket must have been opened');
  assert.deepEqual(browserErrors, []);
  checks.push('No direct browser-to-core access and no uncaught browser errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = redact(error.message);
  process.exitCode = 1;
} finally {
  report.relayOrigins = [...relayOrigins];
  await writeFile(path.join(outputDir, 'smoke-result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
