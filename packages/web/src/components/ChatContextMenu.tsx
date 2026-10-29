import { t } from '../i18n'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import { canHaveHelper, type Conversation, type ResolvedFile } from '@conclave/protocol'
import { handToHelper } from '../helper-conversations'
import { useCore } from '../core-store'
import { canRevealFile } from '../desktop-bridge'
import { copyFileText, filePreviewSupported, showChatFile, type ChatFileScope } from '../file-actions'
import { linkTarget, type FileReference } from '../file-links'
import { copyRegionText } from './ChatCopyRegion'
import { ContextMenu, MenuItem, menuPoint, type MenuPoint } from './ContextMenu'
import { FileMenuItems } from './FileMenu'
import { CodeIcon, CopyIcon, DocumentIcon, FolderIcon, LinkIcon, SparkIcon } from './icons'

export const ChatFilesContext = createContext<ChatFileScope | null>(null)
export function useChatFiles(): ChatFileScope | null { return useContext(ChatFilesContext) }

type Menu = { at: MenuPoint; selection: string; text: string; code: string | null; href: string | null; reference: FileReference | null; file: ResolvedFile | null; resolving: boolean; error: string | null }

export function selectedChatText(root: HTMLElement): string {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return ''
  return selection.toString()
}

export function useChatContextMenu(list: RefObject<HTMLDivElement | null>, scope: ChatFileScope) {
  const parent = useCore((state) => state.conversations[scope.conversationId])
  const [menu, setMenu] = useState<Menu | null>(null)
  const sequence = useRef(0)
  const close = useCallback(() => { sequence.current++; setMenu(null) }, [])
  useEffect(() => { close(); return () => { sequence.current++ } }, [scope.conversationId, close])
  const openMenu = (target: Element, at: MenuPoint) => {
    if (!list.current) return
    const path = target.closest<HTMLElement>('[data-file-path]')?.dataset.filePath
    const reference = path ? { path, line: Number(target.closest<HTMLElement>('[data-file-line]')?.dataset.fileLine) || null } : null
    const href = target.closest<HTMLAnchorElement>('a[href]')?.getAttribute('href') ?? null
    const code = target.closest('.chat-code pre')
    const state: Menu = {
      at, selection: selectedChatText(list.current), text: copyRegionText(target, list.current) ?? '',
      code: code?.textContent?.replace(/\n$/, '') ?? null,
      href: href && ['web', 'app'].includes(linkTarget(href)?.kind ?? '') ? href : null,
      reference, file: null, resolving: reference !== null && filePreviewSupported(), error: null
    }
    const current = ++sequence.current
    setMenu(state)
    const rpc = useCore.getState().rpc
    if (reference && state.resolving && rpc) void rpc.call('files.resolve', { conversationId: scope.conversationId, path: reference.path }).then((file) => {
      if (sequence.current === current) setMenu({ ...state, file, resolving: false, error: file ? null : t('ChatContextMenu.fileNotFound') })
    }, () => { if (sequence.current === current) setMenu({ ...state, resolving: false, error: t('ChatContextMenu.cannotAccessFile') }) })
  }
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return
    event.preventDefault()
    openMenu(event.target, menuPoint(event, event.target.closest<HTMLElement>('button, .chat-entry') ?? event.currentTarget))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) || !(event.target instanceof Element)) return
    event.preventDefault()
    const box = (event.target.closest<HTMLElement>('button, .chat-entry') ?? event.currentTarget).getBoundingClientRect()
    openMenu(event.target, { x: box.left + 12, y: box.bottom })
  }
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const mac = window.conclave?.platform === 'darwin' || navigator.userAgent.includes('Mac')
    if (event.button === 2 || (mac && event.ctrlKey)) event.preventDefault()
  }
  const copy = (text: string) => { close(); void copyFileText(text) }
  const content = menu && (
    <ContextMenu at={menu.at} scrollBoundary={list.current} label={t('ChatContextMenu.chatContent')} onClose={close}>
      <HandToHelperItem parent={parent} selection={menu.selection} inspector={scope.inspector} onClose={close} />
      {menu.selection && <MenuItem label={t('ChatContextMenu.copySelection')} icon={<CopyIcon />} onSelect={() => copy(menu.selection)} />}
      {menu.text && <MenuItem label={t('ChatContextMenu.copyContent')} icon={<DocumentIcon />} onSelect={() => copy(menu.text)} />}
      {menu.code !== null && <MenuItem label={t('ChatContextMenu.copyCode')} icon={<CodeIcon />} onSelect={() => copy(menu.code ?? '')} />}
      {menu.href && <MenuItem label={t('ChatContextMenu.copyLink')} icon={<LinkIcon />} onSelect={() => copy(menu.href ?? '')} />}
      {menu.file && <FileMenuItems scope={scope} file={menu.file} line={menu.reference?.line} onClose={close} />}
      {menu.reference && !filePreviewSupported() && canRevealFile() && <MenuItem label={t('ChatContextMenu.showInFileManager')} icon={<FolderIcon />} onSelect={() => { close(); if (menu.reference) void showChatFile(scope, menu.reference) }} />}
      {menu.resolving && <div className="menu-label" role="status">{t('ChatContextMenu.findingFile')}</div>}
      {menu.error && <div className="menu-label" role="status">{menu.error}</div>}
      {!menu.selection && !menu.text && menu.code === null && !menu.reference && !menu.href && <MenuItem label={t('ChatContextMenu.nothingToCopy')} disabled onSelect={close} />}
    </ContextMenu>
  )
  return { onContextMenu, onKeyDown, onPointerDown, menu: content, open: menu !== null }
}

export function HandToHelperItem({ parent, selection, inspector, onClose }: {
  parent: Conversation | undefined
  selection: string
  inspector: 'task' | 'conversation'
  onClose: () => void
}) {
  const supported = useCore((state) => state.rpc?.features.includes('conversation-helper') ?? false)
  if (!selection.trim() || !supported || !parent || !canHaveHelper(parent)) return null
  return <MenuItem label={t('ChatContextMenu.askHelper')} icon={<SparkIcon />} onSelect={() => { document.getSelection()?.removeAllRanges(); onClose(); void handToHelper(parent, selection, inspector) }} />
}
