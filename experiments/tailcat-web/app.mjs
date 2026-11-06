const $ = (id) => document.getElementById(id);
const storageKey = 'conclave-tailcat-experiment-device';
const status = (text) => { $('status').textContent = text; };
const record = (text) => {
  const li = document.createElement('li');
  li.textContent = text;
  $('events').prepend(li);
};
const fragment = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
let pendingInvitation = null;
if (fragment.has('pair')) {
  try { pendingInvitation = JSON.parse(fragment.get('pair')); } catch { status('配对链接无效'); }
}

if (location.pathname === '/host') {
  $('host').hidden = false;
  const adminToken = fragment.get('admin');
  async function admin(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${adminToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('本机控制入口已失效，请从终端重新打开');
    return res.json();
  }
  async function refresh() {
    const result = await admin('/admin/status');
    $('devices').replaceChildren();
    for (const device of result.devices) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = device.name;
      const revoke = document.createElement('button');
      revoke.className = 'secondary';
      revoke.textContent = '撤销';
      revoke.onclick = async () => {
        await admin('/admin/revoke', { deviceId: device.id });
        record(`已撤销 ${device.name}`);
        await refresh();
      };
      li.append(label, revoke);
      $('devices').append(li);
    }
    if (!result.devices.length) $('devices').textContent = '尚无设备';
  }
  $('invite').onclick = async () => {
    try {
      const result = await admin('/admin/invite', {});
      $('qr').innerHTML = result.qr;
      $('pair-link').href = result.url;
      $('pair-link').textContent = result.external ? '打开手机配对页 ↗' : '在本机打开配对页 ↗';
      $('invite-note').textContent = result.external ? '手机关闭 Wi-Fi 后扫码，用 Safari 或 Chrome 打开，点击连接并配对。' : '本机实验地址，手机暂不可直接访问。';
      $('expiry').textContent = `有效至 ${new Date(result.expiresAt).toLocaleTimeString()}，仅可配对一次`;
      $('invitation').hidden = false;
      status('等待测试设备连接');
    } catch (err) { status(err.message); }
  };
  await refresh().then(() => status('独立测试实例与 Tailcat 已就绪')).catch((err) => status(err.message));
  setInterval(() => refresh().catch(() => {}), 2000);
} else {
  $('client').hidden = false;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch {}
  let conn = null;
  let nextId = 0;
  let generation = 0;
  let heartbeat;
  const pending = new Map();
  let sendQueue = Promise.resolve();

  function failPending(reason) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }
  function disconnected(text) {
    generation++;
    clearInterval(heartbeat);
    if (conn) conn.close();
    conn = null;
    failPending(text);
    $('disconnect').disabled = true;
    $('connected').hidden = true;
    $('connect').disabled = false;
    $('connect').textContent = saved ? '重新连接' : '连接并配对';
    status(text);
  }
  async function receive(connection, current) {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      while (current === generation) {
        const chunk = await connection.read();
        if (chunk === null) break;
        buffer += decoder.decode(chunk, { stream: true });
        if (buffer.length > 262144) throw new Error('响应超出实验限制');
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          const entry = pending.get(message.id);
          if (!entry) continue;
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.kind === 'error') {
            const error = new Error(message.message);
            error.code = message.code;
            entry.reject(error);
          } else entry.resolve(message);
        }
      }
      if (current === generation) disconnected('连接已关闭，可重新连接');
    } catch (err) {
      if (current === generation) disconnected(`连接中断：${err.message}`);
    }
  }
  function request(kind, fields = {}) {
    if (!conn) return Promise.reject(new Error('尚未连接'));
    const id = String(++nextId);
    const connection = conn;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('请求超时'));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      sendQueue = sendQueue.catch(() => {}).then(() => connection.write(new TextEncoder().encode(JSON.stringify({ kind, id, ...fields }) + '\n')));
      sendQueue.catch((error) => {
        const entry = pending.get(id);
        if (entry) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    });
  }
  async function probe() {
    const hello = await request('core', { method: 'system.hello' });
    const tasks = await request('core', { method: 'tasks.list' });
    $('core-version').textContent = `${hello.result.serverVersion} · 协议 ${hello.result.protocolVersion}`;
    $('task-count').textContent = `${tasks.result.length} 个（独立测试数据）`;
    record('真实 Conclave：版本握手和任务列表读取成功');
    return { hello: hello.result, tasks: tasks.result };
  }
  async function connect() {
    $('connect').disabled = true;
    status('正在通过 DERP 建立加密通道…');
    const info = pendingInvitation ?? saved;
    if (!info?.address || !Number.isInteger(info.port)) throw new Error('请先从电脑打开配对链接');
    if (pendingInvitation && pendingInvitation.expiresAt <= Date.now()) throw new Error('配对二维码已过期，请在电脑上重新生成');
    const start = performance.now();
    conn = await tailcatDial({ addr: info.address, port: info.port });
    const current = ++generation;
    receive(conn, current);
    if (pendingInvitation) {
      const result = await request('pair', { ticket: info.ticket, deviceName: $('device-name').value });
      saved = { address: info.address, port: info.port, deviceId: result.deviceId, deviceToken: result.deviceToken };
      pendingInvitation = null;
      try {
        localStorage.setItem(storageKey, JSON.stringify(saved));
        record('一次性口令已兑换，已保存独立设备凭据');
      } catch {
        record('已配对；浏览器未允许保存凭据，关闭页面后需重新扫码');
      }
    } else {
      await request('resume', { deviceId: saved.deviceId, deviceToken: saved.deviceToken });
      record('已用设备凭据恢复连接，无需重新扫码');
    }
    $('disconnect').disabled = false;
    $('connected').hidden = false;
    $('connect').textContent = '已连接';
    heartbeat = setInterval(() => request('ping').catch(() => {
      if (current === generation) disconnected('心跳中断，可重新连接');
    }), 20000);
    status(`已连接 · 建连与鉴权 ${Math.round(performance.now() - start)} ms`);
    return probe();
  }
  $('connect').onclick = () => connect().catch((err) => { disconnected(`连接失败：${err.message}`); record(err.message); });
  $('disconnect').onclick = () => disconnected('已主动断开');
  $('probe').onclick = () => probe().catch((err) => status(err.message));
  $('ping').onclick = async () => {
    try {
      const start = performance.now();
      await request('ping');
      const latency = Math.round(performance.now() - start);
      $('latency').textContent = `${latency} ms`;
      record(`加密通道往返 ${latency} ms`);
    } catch (err) { status(err.message); }
  };
  $('echo').onclick = async () => {
    try {
      const text = $('echo-text').value;
      const result = await request('echo', { text });
      if (result.text !== text) throw new Error('回传内容不一致');
      record(`回传一致：${result.text}`);
    } catch (err) { status(err.message); }
  };

  const ready = new Promise((resolve) => { globalThis.onTailcatReady = resolve; });
  const go = new Go();
  try {
    status('正在加载浏览器网络组件…');
    const response = await fetch(new URL('./assets/main.wasm.gz', import.meta.url));
    if (!response.ok) throw new Error('缺少 Tailcat WASM 产物');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (compressed && typeof DecompressionStream === 'undefined') throw new Error('浏览器版本过旧，请更新 Safari 或 Chrome');
    // Some static hosts decompress .gz responses before fetch receives them.
    const wasm = compressed ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : bytes;
    const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
    go.run(instance).catch(() => disconnected('浏览器网络组件已退出'));
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('网络组件加载超时')), 30000))]);
    $('connect').disabled = false;
    $('connect').textContent = pendingInvitation ? '连接并配对' : '重新连接';
    status(pendingInvitation ? '可以配对，口令仅供本次使用' : saved ? '已保存电脑，点击重新连接' : '请先从电脑打开配对链接');
    // Local smoke tests use the same transport and UI actions as the page.
    window.tailcatExperiment = { connect, disconnect: () => disconnected('已主动断开'), request, probe, ready: true };
  } catch (err) { status(`加载失败：${err.message}`); }
}
