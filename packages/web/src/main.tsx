import { clientLayout, localNodeAvailable } from './client-layout'

async function boot() {
  const url = new URL(location.href)
  const layout = clientLayout({ userAgent: navigator.userAgent, touchPoints: navigator.maxTouchPoints, desktopBridge: Boolean(window.conclave), override: url.searchParams.get('layout') })
  if (layout === 'mobile') {
    url.pathname = '/mobile.html'
    url.searchParams.delete('node')
    url.searchParams.delete('token')
    url.searchParams.delete('port')
    location.replace(url)
    return
  }
  const publicClient = Boolean(document.querySelector('meta[name="conclave-remote-client"]')) || !localNodeAvailable(url.hostname, Boolean(window.conclave))
  if ((publicClient || url.hash.startsWith('#pair=')) && !url.searchParams.has('node')) {
    url.searchParams.set('node', 'connect')
    history.replaceState(null, '', url)
  }
  const desktop = await import('./desktop-main')
  await desktop.startDesktop()
}
void boot().catch(() => {
  const root = document.getElementById('root')
  if (root) { const message = document.createElement('p'); message.setAttribute('role', 'alert'); message.textContent = 'Conclave 页面启动失败，请刷新后重试。'; root.replaceChildren(message) }
})
