import { Capacitor } from '@capacitor/core'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import './mobile.css'
import { MobileApp } from './MobileApp'

async function start() {
  const root = document.getElementById('root')
  if (!root) throw new Error('Missing mobile root')
  try {
    const platform = Capacitor.isNativePlatform()
      ? await (await import('./mobile-native')).createNativeMobilePlatform()
      : undefined
    createRoot(root).render(<MobileApp platform={platform} />)
  } catch {
    const message = document.createElement('p')
    message.setAttribute('role', 'alert')
    message.textContent = 'agents-go 无法读取设备存储，请关闭后重新打开。'
    root.replaceChildren(message)
  }
}
void start()
