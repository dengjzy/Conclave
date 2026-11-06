// A document belongs to one node; switching nodes always starts a fresh document.
const selected = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('node')
export const storageNode = selected && selected !== 'local' ? selected : null

export function nodeStorageKey(key: string, node: string | null = storageNode): string {
  return node ? `conclave.node:${encodeURIComponent(node)}:${key}` : key
}

export const nodeStorage = {
  getItem(key: string): string | null { return localStorage.getItem(nodeStorageKey(key)) },
  setItem(key: string, value: string): void { localStorage.setItem(nodeStorageKey(key), value) },
  removeItem(key: string): void { localStorage.removeItem(nodeStorageKey(key)) }
}
