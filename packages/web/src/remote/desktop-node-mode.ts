// Node changes reload the document, so routing is the source of truth for native capabilities.
export function isRemoteDesktopNode(): boolean {
  if (typeof window === 'undefined') return false
  const target = new URLSearchParams(window.location?.search ?? '').get('node')
  return Boolean(target && target !== 'local')
}
