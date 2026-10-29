import { useState, useEffect } from 'react'
import { perform } from '../core-store'
import { FolderIcon, CloseIcon } from './icons'

interface DirectoryItem {
  name: string
  path: string
  isGit: boolean
}

interface DirectoryListing {
  current: string
  parent: string | null
  directories: DirectoryItem[]
}

const QUICK_PATHS = [
  { label: '💼 工作区 (workspace)', path: '/home/swrd/workspace' },
  { label: '📁 日志目录 (temp)', path: '/home/swrd/temp' },
  { label: '📁 工作台 (docs)', path: '/home/swrd/workspace/工作台' },
  { label: '🏠 家目录 (home)', path: '/home/swrd' }
]

export function FolderBrowserModal({
  initialPath = '/home/swrd/workspace',
  onSelect,
  onClose
}: {
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const [currentPath, setCurrentPath] = useState(initialPath)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadDirectory = async (targetPath: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await perform((rpc) => rpc.call('fs.listDirectories', { path: targetPath }))
      if (res) {
        setListing(res)
        setCurrentPath(res.current)
      } else {
        setError('无法读取目录')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取目录失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDirectory(initialPath)
  }, [initialPath])

  const openNativePicker = async () => {
    try {
      const res = await perform((rpc) => rpc.call('system.pickFolder', { defaultPath: currentPath }))
      if (res?.path) {
        onSelect(res.path)
      }
    } catch {}
  }

  const breadcrumbs = currentPath.split('/').filter(Boolean)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-dialog folder-browser-modal" style={{ maxWidth: 640, width: '90%' }} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1.1rem', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <FolderIcon />
            选择目录 / 打开项目
          </h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <CloseIcon />
          </button>
        </header>

        <div className="modal-body" style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Quick jumps */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {QUICK_PATHS.map((item) => (
              <button
                key={item.path}
                type="button"
                className="button tertiary small"
                style={{ fontSize: '0.8rem', padding: '4px 8px' }}
                onClick={() => void loadDirectory(item.path)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {/* Breadcrumb Path Bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'var(--surface-sunken)', padding: '6px 12px', borderRadius: 6, overflowX: 'auto' }}>
            <button
              type="button"
              className="link-button"
              style={{ fontWeight: 600, color: 'var(--text-accent)' }}
              onClick={() => void loadDirectory('/')}
            >
              /
            </button>
            {breadcrumbs.map((seg, idx) => {
              const full = '/' + breadcrumbs.slice(0, idx + 1).join('/')
              return (
                <span key={full} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--text-muted)' }}>/</span>
                  <button
                    type="button"
                    className="link-button"
                    style={{
                      color: idx === breadcrumbs.length - 1 ? 'var(--text-primary)' : 'var(--text-accent)',
                      fontWeight: idx === breadcrumbs.length - 1 ? 600 : 400
                    }}
                    onClick={() => void loadDirectory(full)}
                  >
                    {seg}
                  </button>
                </span>
              )
            })}
          </div>

          {/* Directory Content List */}
          <div
            style={{
              maxHeight: 320,
              overflowY: 'auto',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              background: 'var(--surface-default)'
            }}
          >
            {loading && <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>正在加载目录...</div>}
            {error && <div style={{ padding: 16, color: 'var(--text-danger)' }}>{error}</div>}
            {!loading && listing && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {listing.parent && (
                  <li>
                    <button
                      type="button"
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 14px',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        color: 'var(--text-muted)',
                        borderBottom: '1px solid var(--border-subtle)'
                      }}
                      onClick={() => void loadDirectory(listing.parent!)}
                    >
                      <span style={{ fontSize: '1rem' }}>📁</span>
                      <span>.. (返回上一级)</span>
                    </button>
                  </li>
                )}
                {listing.directories.length === 0 && (
                  <li style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)' }}>当前目录下无子文件夹</li>
                )}
                {listing.directories.map((dir) => (
                  <li key={dir.path}>
                    <button
                      type="button"
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: '8px 14px',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        borderBottom: '1px solid var(--border-subtle)'
                      }}
                      onClick={() => void loadDirectory(dir.path)}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ fontSize: '1rem' }}>📁</span>
                        <span style={{ color: 'var(--text-primary)' }}>{dir.name}</span>
                      </span>
                      {dir.isGit && (
                        <span style={{ fontSize: '0.7rem', padding: '2px 6px', borderRadius: 4, background: 'var(--surface-raised)', color: 'var(--text-accent)' }}>
                          git
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <footer className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border-subtle)' }}>
          <button type="button" className="button tertiary" onClick={() => void openNativePicker()}>
            🖥️ 系统原生窗口
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
            <button type="button" className="button primary" onClick={() => onSelect(currentPath)}>
              选择当前目录
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
