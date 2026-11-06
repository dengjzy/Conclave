export function phoneBrowser(userAgent: string, touchPoints = 0): boolean {
  return /Android|iPhone|iPod|iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)
}

export function clientLayout(options: { userAgent: string; touchPoints?: number; desktopBridge?: boolean; override?: string | null }): 'desktop' | 'mobile' {
  if (options.override === 'desktop' || options.override === 'mobile') return options.override
  if (options.desktopBridge) return 'desktop'
  return phoneBrowser(options.userAgent, options.touchPoints) ? 'mobile' : 'desktop'
}

export function localNodeAvailable(hostname: string, desktopBridge = false): boolean {
  return desktopBridge || ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
}
