import { useEffect, useRef, useState, type FormEvent } from 'react'
import { agentDescriptor, agentCallOpen, checkTaskHandoff, isAgentKind, type AgentCall, type AgentProfile, type ChatItem, type Conversation, type ConversationStage, type RemoteMethod, type RemoteParams, type RemoteResult, type RemoteTaskPage, type Task } from '@conclave/protocol'
import { MobileConnection, MobileRequestError } from './mobile-connection'
import type { MobilePlatform } from './mobile-platform'
import { STATUS_LABEL, reasonText } from '../labels'
import { ChatPicker } from '../components/ChatPicker'
import { MobileMessages } from './MobileMessages'
import { MobileAgentOptions, initialAgentChoice, type MobileAgentChoice } from './MobileAgentOptions'

type Catalog = RemoteResult<'catalog'>
type ChatPage = RemoteResult<'chat.page'>
type Tab = 'tasks' | 'computers' | 'settings'
type Section = 'conversations' | 'tasks' | 'projects'
type Selection = { kind: 'task' | 'conversation'; id: string }
type Filter = 'all' | 'attention' | 'running'
const taskTime = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const preferenceKey = (name: string) => `conclave-mobile-${name}`
const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
const callState: Record<AgentCall['state'], string> = { queued: '排队中', starting: '正在启动', running: '执行中', awaiting: '需要回复', completed: '已完成', failed: '失败', cancelled: '已取消' }

export function MobileApp({ platform }: { platform?: MobilePlatform } = {}) {
  const [message, setMessage] = useState('从电脑设置中扫码，或粘贴配对链接')
  const [client] = useState(() => new MobileConnection(setMessage, platform))
  const preferences = client.platform.preferences
  const [deviceName, setDeviceName] = useState(() => preferences.read(preferenceKey('device-name')) || client.platform.deviceName || '手机浏览器')
  const [theme, setTheme] = useState(() => preferences.read(preferenceKey('theme')) || 'system')
  const [largeText, setLargeText] = useState(() => preferences.read(preferenceKey('large-text')) === 'true')
  const [autoReconnect, setAutoReconnect] = useState(() => preferences.read(preferenceKey('auto-reconnect')) !== 'false')
  const [initialized, setInitialized] = useState(false)
  const [wide, setWide] = useState(() => window.matchMedia?.('(min-width: 1024px)').matches ?? false)
  const [tab, setTab] = useState<Tab>('tasks')
  const [section, setSection] = useState<Section>('conversations')
  const [project, setProject] = useState('')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [taskInfo, setTaskInfo] = useState(false)
  const [manageHosts, setManageHosts] = useState(false)
  const modal = useRef<HTMLDialogElement | null>(null)
  const composer = useRef<HTMLTextAreaElement | null>(null)
  const [hostName, setHostName] = useState('我的电脑')
  const [invitationLink, setInvitationLink] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [page, setPage] = useState<RemoteTaskPage | null>(null)
  const [conversationPage, setConversationPage] = useState<RemoteResult<'conversations.page'> | null>(null)
  const [projects, setProjects] = useState<RemoteResult<'projects.list'> | null>(null)
  const [offset, setOffset] = useState(0)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [task, setTask] = useState<Task | null>(null)
  const [dependencies, setDependencies] = useState<Task[] | null>(null)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [chat, setChat] = useState<ChatPage | null>(null)
  const [older, setOlder] = useState<ChatItem[]>([])
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [text, setText] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [choice, setChoice] = useState<MobileAgentChoice>({ agent: null })
  const [stages, setStages] = useState<ConversationStage[]>([])
  const [calls, setCalls] = useState<AgentCall[]>([])
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [action, setAction] = useState<'handoff' | 'delegate' | null>(null)
  const [actionChoice, setActionChoice] = useState<MobileAgentChoice>({ agent: null })
  const [actionText, setActionText] = useState('')
  const [stopRunning, setStopRunning] = useState(false)
  const [profileId, setProfileId] = useState('')
  const [delegateCapability, setDelegateCapability] = useState<'readOnly' | 'develop'>('readOnly')
  const revision = useRef(0)
  const connectionAttempt = useRef(0)
  const operation = useRef(0)
  const operating = useRef(false)
  const connectingNow = useRef(false)
  const scanningNow = useRef(false)
  const mounted = useRef(true)
  const resumeConnection = useRef(false)
  const draftValue = useRef('')
  const writes = useRef(new Map<string, string>())
  const history = useRef<HTMLDivElement | null>(null)
  const followMessages = useRef(true)
  const connected = client.connected
  const hostId = client.activeHostId
  const supports = (method: RemoteMethod, capability?: string) => Boolean(catalog && (!capability || catalog.capabilities?.includes(capability)) && client.supports(method))
  const workspace = supports('conversations.page', 'conversations')
  const keyFor = (target: Selection | null, host = client.activeHostId) => host ? preferenceKey(`draft:${host}:${target?.kind ?? 'conversation'}:${target?.id ?? 'new'}`) : null
  const draftKey = keyFor(selected)
  const selectedKey = selected ? `${selected.kind}:${selected.id}` : 'new'

  useEffect(() => {
    let active = true
    mounted.current = true
    void client.ready.then(() => { if (active) { setInitialized(true); setHostName(client.hostName || client.invitationName || '我的电脑'); if (client.canConnect || client.invitationProblem) setTab('computers') } })
    return () => { active = false; mounted.current = false; connectionAttempt.current++; revision.current++; client.disconnect() }
  }, [client])
  useEffect(() => {
    const media = window.matchMedia?.('(min-width: 1024px)')
    if (!media) return
    const changed = () => { setWide(media.matches); if (media.matches) setDrawerOpen(false) }
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    // Shared menus portal to body; the entire standalone client owns the document theme.
    document.documentElement.dataset.theme = theme
    return () => { delete document.documentElement.dataset.theme }
  }, [theme])
  useEffect(() => {
    const saved = readDraft(selected)
    draftValue.current = saved; setText(saved)
  }, [draftKey, preferences])
  useEffect(() => {
    if (!connected || tab === 'settings') return
    let active = true
    let polling = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = revision.current
    const valid = () => active && current === revision.current
    const poll = async () => {
      if (!valid() || polling || !client.platform.isActive()) return
      polling = true
      try {
        if (!selected || drawerOpen || wide) {
          if (workspace && section === 'conversations') {
            const next = await client.call('conversations.page', { offset, filter, query, ...(project ? { project } : {}) })
            if (!valid()) return
            setConversationPage(next)
          } else if (workspace && section === 'projects' && supports('projects.list', 'projects')) {
            const next = await client.call('projects.list', {})
            if (!valid()) return
            setProjects(next)
          } else {
            const next = await client.call('tasks.page', { offset, filter, query, ...(supports('projects.list', 'projects') && project ? { project } : {}) })
            if (!valid()) return
            setPage(next)
          }
        }
        let conversationId: string | null = selected?.kind === 'conversation' ? selected.id : null
        if (selected?.kind === 'task') {
          const next = await client.call('tasks.get', { id: selected.id })
          if (!valid()) return
          setTask(next); conversationId = next.conversationId
          if (taskInfo && supports('tasks.handoff', 'handoff')) {
            const required = await Promise.all(next.dependsOn.map((id) => client.call('tasks.get', { id })))
            if (!valid()) return
            setDependencies(required)
          }
        }
        if (conversationId) {
          const currentConversation = await client.call('conversations.get', { id: conversationId })
          if (!valid()) return
          setConversation(currentConversation)
          if (selected?.kind === 'conversation' && currentConversation.taskId) {
            const owningTask = await client.call('tasks.get', { id: currentConversation.taskId })
            if (!valid()) return
            setTask(owningTask)
            if (taskInfo && supports('tasks.handoff', 'handoff')) {
              const required = await Promise.all(owningTask.dependsOn.map((id) => client.call('tasks.get', { id })))
              if (!valid()) return
              setDependencies(required)
            }
          }
          const items = await client.call('chat.page', { id: conversationId })
          if (!valid()) return
          setChat(items)
          if (taskInfo || action) {
            if (supports('conversations.stages', 'stages')) {
              const next = await client.call('conversations.stages', { id: conversationId })
              if (!valid()) return
              setStages(next)
            }
            if (supports('agentCalls.list', 'delegation')) {
              const next = await client.call('agentCalls.list', { id: conversationId })
              if (!valid()) return
              setCalls(next)
            }
            if (action === 'delegate' && supports('agentProfiles.available', 'delegation')) {
              const next = await client.call('agentProfiles.available', { id: conversationId })
              if (!valid()) return
              setProfiles(next)
            }
          }
        }
      } catch (failure) { if (valid()) setError(failure instanceof Error ? failure.message : '读取失败') }
      finally { polling = false; if (valid() && client.platform.isActive()) timer = setTimeout(() => void poll(), 5000) }
    }
    const unsubscribe = client.platform.subscribeActivity((foreground) => { clearTimeout(timer); if (foreground) void poll() })
    void poll()
    return () => { active = false; clearTimeout(timer); unsubscribe() }
  }, [client, connected, tab, selectedKey, drawerOpen, wide, hostId, offset, filter, query, project, section, workspace, taskInfo, action, refresh])
  useEffect(() => client.platform.subscribeActivity((foreground) => {
    if (foreground && initialized && autoReconnect && resumeConnection.current && !client.connected && !client.isPairing && client.canConnect && !connectingNow.current && !scanningNow.current) void connect(false)
  }), [client, initialized, autoReconnect, deviceName, hostName])
  useEffect(() => {
    if (initialized && !connected && client.platform.isActive() && autoReconnect && resumeConnection.current && !client.isPairing && client.canConnect && !connectingNow.current && !scanningNow.current) void connect(false)
  }, [client, initialized, connected, autoReconnect, scanning])
  useEffect(() => { if (history.current && followMessages.current) history.current.scrollTop = history.current.scrollHeight }, [chat, selectedKey])

  function savePreference(name: string, value: string) { preferences.write(preferenceKey(name), value) }
  function updateDraft(value: string) { draftValue.current = value; setText(value); if (draftKey) preferences.write(draftKey, value || null) }
  function readDraft(target: Selection | null) {
    const key = keyFor(target)
    if (!key) return ''
    const saved = preferences.read(key)
    if (saved !== null) return saved
    if (target?.kind !== 'task') return ''
    const legacyKey = preferenceKey(`draft:${hostId}:${target.id}`)
    const legacy = preferences.read(legacyKey)
    if (legacy !== null && preferences.write(key, legacy)) preferences.write(legacyKey, null)
    return legacy ?? ''
  }
  function selectTarget(target: Selection | null, preserveOperation = false) {
    if (!preserveOperation) { revision.current++; operation.current++; operating.current = false; setBusy(false) }
    setSelected(target); setTask(null); setDependencies(null); setConversation(null); setChat(null); setOlder([]); setOlderCursor(undefined); setStages([]); setCalls([]); setProfiles([]); setError(''); setAction(null)
    followMessages.current = true
    const saved = readDraft(target)
    draftValue.current = saved; setText(saved)
  }
  function leaveConnection() {
    connectionAttempt.current++; revision.current++; operation.current++
    operating.current = false; connectingNow.current = false; resumeConnection.current = false
    setConnecting(false); setBusy(false); setCatalog(null); setAction(null)
    client.disconnect()
  }
  function resetHostView() { selectTarget(null); setPage(null); setConversationPage(null); setProjects(null); setProject(''); setOffset(0); setCreating(false); setTaskInfo(false); setChoice({ agent: null }) }
  function changeHost(id: string) { leaveConnection(); client.selectHost(id); resetHostView(); setHostName(client.hostName); setRefresh((value) => value + 1) }
  async function perform(action: () => Promise<void>) {
    if (operating.current || !client.connected) return
    const current = revision.current
    const op = ++operation.current
    operating.current = true; setBusy(true); setError('')
    try { await action() } catch (failure) { if (current === revision.current) setError(failure instanceof Error ? failure.message : '操作失败') }
    finally { if (op === operation.current) { operating.current = false; setBusy(false) } }
  }
  async function write<M extends RemoteMethod>(method: M, params: RemoteParams<M>): Promise<RemoteResult<M>> {
    const key = JSON.stringify({ hostId: client.activeHostId, method, params })
    const requestId = writes.current.get(key) ?? crypto.randomUUID()
    writes.current.set(key, requestId)
    try { const result = await client.call(method, params, requestId); writes.current.delete(key); return result }
    catch (failure) { if (failure instanceof MobileRequestError && !failure.outcomeUnknown) writes.current.delete(key); throw failure }
  }
  async function connect(showTasks = true, automatic = false) {
    if (connectingNow.current) return
    const attempt = ++connectionAttempt.current
    connectingNow.current = true; setConnecting(true); setError(''); setCatalog(null)
    try {
      await client.connect(deviceName, automatic ? undefined : hostName)
      if (attempt !== connectionAttempt.current) return
      const nextCatalog = await client.call('catalog', {})
      if (attempt !== connectionAttempt.current) return
      setCatalog(nextCatalog); setHostName(client.hostName); resumeConnection.current = true
      setChoice((current) => current.agent && nextCatalog.agents.some((entry) => entry.id === current.agent) ? current : initialAgentChoice(nextCatalog))
      if (!nextCatalog.capabilities?.includes('conversations')) setSection('tasks')
      else if (showTasks) setSection('conversations')
      if (showTasks) { setTab('tasks'); setManageHosts(false); setDrawerOpen(!wide && !nextCatalog.capabilities?.includes('conversations')) }
      setRefresh((value) => value + 1)
    } catch (failure) { if (attempt === connectionAttempt.current) { client.disconnect('连接未完成，请重新连接'); resumeConnection.current = false; setError(failure instanceof Error ? failure.message : '连接失败') } }
    finally { if (attempt === connectionAttempt.current) { connectingNow.current = false; setConnecting(false) } }
  }
  async function scan() {
    const scanner = client.platform.scanInvitation
    if (!scanner || scanningNow.current || connectingNow.current || operating.current) return
    scanningNow.current = true; setScanning(true); setError('')
    const attempt = connectionAttempt.current
    try {
      const link = await scanner()
      if (!mounted.current || attempt !== connectionAttempt.current || link === null) return
      client.importInvitation(link); leaveConnection(); resetHostView()
      setInvitationLink(''); setHostName(client.invitationName || '我的电脑'); setManageHosts(false); setTab('computers'); setDrawerOpen(false)
      await connect(true, true)
    } catch (failure) { if (mounted.current && attempt === connectionAttempt.current) setError(failure instanceof Error ? failure.message : '扫码失败，请重试') }
    finally { scanningNow.current = false; if (mounted.current) setScanning(false) }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const agent = String(data.get('agent') ?? '')
    if (!isAgentKind(agent)) return
    const current = revision.current
    await perform(async () => {
      const created = await write('tasks.create', { title: String(data.get('title') ?? ''), details: String(data.get('details') ?? ''), repos: [String(data.get('project') ?? '')], agent })
      if (current !== revision.current) return
      setCreating(false); setDrawerOpen(false); selectTarget({ kind: 'task', id: created.id }, true); setTask(created)
    })
  }
  const managed = Boolean(conversation?.parentConversationId || conversation?.squadRunId || conversation?.helperOf)
  async function send(event: FormEvent) {
    event.preventDefault()
    if (!text.trim() || managed || (selected && !conversation?.id) || (!selected && (!workspace || !choice.agent))) return
    const current = revision.current
    const submittedHost = hostId
    const submittedDraft = text
    let submittedDraftKey = draftKey
    const payload = submittedDraft.trim()
    let target = conversation
    await perform(async () => {
      if (!selected && choice.agent) {
        const created = await write('conversations.create', { agent: choice.agent, projectPaths: project ? [project] : [], model: choice.model, effort: choice.effort, permissionMode: choice.permissionMode, agentPreset: choice.agentPreset })
        const createdKey = keyFor({ kind: 'conversation', id: created.id }, submittedHost)
        const retainedDraft = current === revision.current ? draftValue.current : submittedDraft
        if (createdKey) preferences.write(createdKey, retainedDraft)
        if (current !== revision.current) return
        if (submittedDraftKey && preferences.read(submittedDraftKey) === retainedDraft) preferences.write(submittedDraftKey, null)
        submittedDraftKey = createdKey; target = created
        selectTarget({ kind: 'conversation', id: created.id }, true); setConversation(created)
      }
      if (!target || current !== revision.current) return
      if (!target.chat && !target.taskId && selected?.kind !== 'task') {
        target = await write('conversations.continue', { id: target.id })
        if (current !== revision.current) return
        setConversation(target)
      }
      const key = `${submittedHost}:${target.id}:${payload}`
      const ref = writes.current.get(key) ?? crypto.randomUUID()
      writes.current.set(key, ref)
      await write('conversations.send', { id: target.id, text: payload, ref })
      writes.current.delete(key)
      if (submittedDraftKey && preferences.read(submittedDraftKey) === submittedDraft) preferences.write(submittedDraftKey, null)
      const legacyKey = selected?.kind === 'task' ? preferenceKey(`draft:${submittedHost}:${selected.id}`) : null
      if (legacyKey && preferences.read(legacyKey) === submittedDraft) preferences.write(legacyKey, null)
      if (current === revision.current) { if (draftValue.current === submittedDraft) { draftValue.current = ''; setText('') }; setRefresh((value) => value + 1) }
    })
  }
  async function respond(item: RequestItem, answer: Omit<RemoteParams<'conversations.respond'>, 'id' | 'requestId'>) {
    if (!conversation) return
    const id = conversation.id
    const current = revision.current
    await perform(async () => { await write('conversations.respond', { id, requestId: item.requestId, ...answer }); if (current === revision.current) setRefresh((value) => value + 1) })
  }
  async function startTask() {
    if (!task) return
    const current = revision.current
    await perform(async () => { const next = await write(task.conversationId ? 'tasks.resumeChat' : 'tasks.start', { id: task.id }); if (current === revision.current) { setTask(next); setRefresh((v) => v + 1) } })
  }
  function closeOverlay() { setDrawerOpen(false); setCreating(false); setTaskInfo(false); setAction(null); if (tab === 'computers') setTab('tasks') }
  function openHosts() { setDrawerOpen(false); setCreating(false); setTaskInfo(false); setAction(null); setManageHosts(false); setTab('computers') }
  function openCreate() { setDrawerOpen(false); setTaskInfo(false); setTab('tasks'); setCreating(true) }
  function openNew() { if (selected) selectTarget(null); setDrawerOpen(false); setTaskInfo(false); setTab('tasks'); setSection('conversations') }
  function openTask(id: string) { if (selected?.kind !== 'task' || selected.id !== id) selectTarget({ kind: 'task', id }); setDrawerOpen(false); setTab('tasks') }
  function openConversation(id: string) { if (selected?.kind !== 'conversation' || selected.id !== id) selectTarget({ kind: 'conversation', id }); setDrawerOpen(false); setTab('tasks') }
  function openParent() { if (conversation?.parentConversationId) openConversation(conversation.parentConversationId) }
  function openSettings() { closeOverlay(); setTab('settings') }
  function changeSection(next: Section) { setTab('tasks'); if (next === section && offset === 0 && !query && filter === 'all') return; setSection(next); setOffset(0); setQuery(''); setFilter('all'); setPage(null); setConversationPage(null) }
  function openAction(next: 'handoff' | 'delegate') { setAction(next); setActionText(''); setActionChoice(initialAgentChoice(next === 'handoff' && catalog ? { ...catalog, agents: catalog.agents.filter((agent) => agent.id !== conversation?.agent) } : catalog)); setStopRunning(false); setProfileId(''); setDelegateCapability('readOnly'); setDrawerOpen(false) }
  async function submitAction(event: FormEvent) {
    event.preventDefault()
    if (!conversation || !action) return
    const current = revision.current
    const id = conversation.id
    await perform(async () => {
      if (action === 'handoff' && actionChoice.agent) {
        const params = { agent: actionChoice.agent, note: actionText, model: actionChoice.model, effort: actionChoice.effort, permissionMode: task?.status === 'pending' ? undefined : actionChoice.permissionMode }
        if (task) { const next = await write('tasks.handoff', { id: task.id, ...params }); if (current === revision.current) setTask(next) }
        else { const next = await write('conversations.handoff', { id, stopRunning, ...params }); if (current === revision.current) setConversation(next) }
      } else if (action === 'delegate') {
        const key = JSON.stringify({ hostId, id, profileId, actionChoice, delegateCapability, actionText })
        const ref = writes.current.get(key) ?? crypto.randomUUID()
        writes.current.set(key, ref)
        const target = !profileId && actionChoice.agent ? { agent: actionChoice.agent, model: actionChoice.model, effort: actionChoice.effort, capability: delegateCapability } : undefined
        await write('agentCalls.dispatch', { id, instruction: actionText, ref, ...(profileId ? { profileId } : { target }) })
        writes.current.delete(key)
      }
      if (current === revision.current) { setAction(null); setTaskInfo(true); setRefresh((v) => v + 1) }
    })
  }
  const items = [...older.filter((item) => !chat?.items.some((entry) => entry.id === item.id)), ...(chat?.items ?? [])]
  const pending = items.filter((item) => (item.kind === 'approval' || item.kind === 'question') && !item.resolution)
  const blockingPending = pending.some((item) => item.kind === 'approval' || (item.kind === 'question' && !item.async))
  const state = items.findLast((item) => item.kind === 'state')
  const before = olderCursor === undefined ? chat?.before : olderCursor
  const locked = busy || !connected
  const status = connected ? '已连接' : connecting ? '连接中' : '未连接'
  const title = task?.title || conversation?.title || (workspace ? '新会话' : 'agents-go')
  const listPage = workspace && section === 'conversations' ? conversationPage : page
  const overlay = drawerOpen && !wide ? 'drawer' : tab === 'computers' ? 'hosts' : creating ? 'create' : action ? action : taskInfo && !wide ? 'info' : null
  useEffect(() => {
    const element = modal.current
    if (!element) return
    if (overlay) { if (!element.open) element.showModal(); element.focus() }
    else if (element.open) element.close()
  }, [overlay])
  useEffect(() => { const element = composer.current; if (element) { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 160)}px` } }, [text, conversation?.chat, selectedKey])
  const handoffBlocker = task && dependencies ? checkTaskHandoff(task, dependencies, conversation?.sessionId ? conversation.chat?.turn ?? null : null) : null
  const needsStop = Boolean(conversation?.sessionId && conversation.chat?.turn !== 'idle')
  const directDelegate = supports('agentCalls.dispatch', 'direct-delegation') && !conversation?.profile
  const currentChoice: MobileAgentChoice = conversation ? { agent: conversation.agent, model: conversation.chatOptions?.model ?? undefined, effort: conversation.chatOptions?.effort ?? undefined, agentPreset: conversation.chatOptions?.agentPreset ?? undefined, permissionMode: conversation.chatOptions?.permissionMode === 'ask' || conversation.chatOptions?.permissionMode === 'plan' || conversation.chatOptions?.permissionMode === 'readOnly' ? conversation.chatOptions.permissionMode : undefined } : choice
  const changeOptions = (next: MobileAgentChoice, option?: 'model' | 'effort' | 'permissionMode' | 'agentPreset') => {
    if (!conversation) { setChoice(next); return }
    if (!option) return
    const value = next[option]
    const current = revision.current
    if (value) void perform(async () => { await write('conversations.setOption', { id: conversation.id, option, value }); if (current === revision.current) setRefresh((v) => v + 1) })
  }
  const sidebar = <>
    <header className="mobile-drawer-header"><span className="mobile-brand"><MobileIcon name="mark" /><strong>agents-go</strong></span><button className="mobile-icon-button" aria-label={workspace ? '新建会话' : '新建任务'} disabled={!connected} onClick={workspace ? openNew : openCreate}><MobileIcon name="compose" /></button></header>
    <button className="mobile-node-picker" onClick={openHosts} aria-label="切换电脑"><MobileIcon name="computers" /><span><strong>{client.hostName || '连接电脑'}</strong><small><span className="mobile-dot" data-online={connected} />{status}</small></span><span aria-hidden="true">⌄</span></button>
    {workspace && <nav className="mobile-workspace-nav" aria-label="工作区"><button aria-current={section === 'conversations' ? 'page' : undefined} onClick={() => changeSection('conversations')}>会话</button><button aria-current={section === 'tasks' ? 'page' : undefined} onClick={() => changeSection('tasks')}>任务</button>{supports('projects.list', 'projects') && <button aria-current={section === 'projects' ? 'page' : undefined} onClick={() => changeSection('projects')}>项目</button>}</nav>}
    {section !== 'projects' && <>
      <label className="mobile-search"><MobileIcon name="search" /><span className="mobile-sr-only">{workspace && section === 'conversations' ? '搜索会话' : '搜索任务'}</span><input type="search" value={query} maxLength={200} placeholder={workspace && section === 'conversations' ? '搜索会话' : '搜索任务'} onChange={(event) => { setQuery(event.target.value); setOffset(0); setPage(null); setConversationPage(null) }} /></label>
      {workspace && <div className="mobile-project-picker"><ChatPicker label="项目范围" value={project} placeholder="所有项目" placement="below" options={[{ value: '', label: '所有项目' }, ...(catalog?.projects ?? []).map((path) => ({ value: path, label: projectName(path), description: path }))]} onChange={(value) => { setProject(value); setOffset(0) }} /></div>}
      <div className="mobile-segmented" role="group" aria-label={workspace && section === 'conversations' ? '会话筛选' : '任务筛选'}>{(['all', 'attention', 'running'] as const).map((value) => <button key={value} aria-pressed={filter === value} onClick={() => { if (filter === value) return; setFilter(value); setOffset(0); setPage(null); setConversationPage(null) }}>{value === 'all' ? '全部' : value === 'attention' ? '需要回复' : '执行中'}</button>)}</div>
    </>}
    <div className="mobile-drawer-scroll">
      {section === 'projects' && workspace ? <div className="mobile-list" aria-label="项目列表">{projects?.map((entry) => <button key={entry.path} className="mobile-project-row" onClick={() => { setProject(entry.path); changeSection('conversations') }}><MobileIcon name="folder" /><span><strong>{entry.name}</strong><small>{entry.conversationCount} 个会话 · {entry.taskCount} 个任务</small><small className="mobile-path">{entry.path}</small></span><MobileIcon name="chevron" /></button>)}{projects?.length === 0 && <p className="mobile-empty">电脑尚未添加项目。仍可新建独立会话。</p>}</div> : <div className="mobile-list" aria-label={workspace && section === 'conversations' ? '会话列表' : '任务列表'}>
        {workspace && section === 'conversations' ? conversationPage?.items.map((entry) => <button key={entry.id} className="mobile-task-row" aria-current={selected?.kind === 'conversation' && selected.id === entry.id ? 'page' : undefined} onClick={() => openConversation(entry.id)}><span className="mobile-task-title">{entry.title || '新会话'}</span><span className="mobile-task-meta">{entry.chat?.turn === 'awaiting' ? <small>需要回复</small> : <span className="mobile-dot" data-status={entry.chat?.turn} />}</span></button>) : page?.items.map((entry) => <button key={entry.id} className="mobile-task-row" aria-current={selected?.kind === 'task' && selected.id === entry.id ? 'page' : undefined} onClick={() => openTask(entry.id)}><span className="mobile-task-title">{entry.title}</span><span className="mobile-task-meta" title={STATUS_LABEL[entry.status]}>{entry.awaitingInput ? <small>需要回复</small> : <span className="mobile-dot" data-task-status={entry.status} />}</span></button>)}
        {!connected && <p className="mobile-empty">连接电脑后查看{workspace && section === 'conversations' ? '会话' : '任务'}</p>}{connected && listPage?.total === 0 && <p className="mobile-empty">{query || filter !== 'all' ? '没有符合条件的结果' : section === 'conversations' ? '还没有会话，发送第一条消息开始。' : '还没有任务，试试新建任务。'}</p>}{connected && !listPage && <p className="mobile-empty">正在读取{workspace && section === 'conversations' ? '会话' : '任务'}…</p>}
      </div>}
      {section !== 'projects' && listPage && (listPage.nextOffset !== null || offset > 0) && <nav className="mobile-pagination" aria-label="分页"><button disabled={!connected || offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>{offset + 1}–{offset + listPage.items.length}</span><button disabled={!connected || listPage.nextOffset == null} onClick={() => setOffset(listPage.nextOffset ?? offset)}>下一页</button></nav>}
      {workspace && section === 'tasks' && <button className="mobile-new-task mobile-full" disabled={!connected} onClick={openCreate}><MobileIcon name="compose" />新建任务</button>}
    </div>
    <footer className="mobile-drawer-footer"><span className="mobile-muted">{project ? projectName(project) : '所有项目'}</span><button className="mobile-icon-button" aria-label="设置" onClick={openSettings}><MobileIcon name="settings" /></button></footer>
  </>
  const detail = <div className="mobile-detail-body">
    <h3>{title}</h3>{task && <p className="mobile-muted">{STATUS_LABEL[task.status]}{task.awaitingInput ? ' · 等待输入' : ''}</p>}
    {task?.details && <p className="mobile-text">{task.details}</p>}
    {conversation && <dl className="mobile-metadata"><div><dt>Agent</dt><dd>{agentDescriptor(conversation.agent).label}</dd></div>{conversation.chatOptions?.model && <div><dt>模型</dt><dd>{conversation.chatOptions.model}</dd></div>}<div><dt>项目</dt><dd>{conversation.projectPaths.length ? conversation.projectPaths.map((path) => <span key={path} title={path}>{projectName(path)}</span>) : '独立会话'}</dd></div>{conversation.profile && <div><dt>角色</dt><dd>{conversation.profile.name}</dd></div>}</dl>}
    {conversation?.parentConversationId && <button className="mobile-full" onClick={openParent}>返回父会话</button>}
    {managed && <p className="mobile-muted">这是受管理的子会话。可查看进度和处理请求，执行目标由父会话或团队管理。</p>}
    <div className="mobile-toolbar">
      {task && <button disabled={locked} onClick={() => void startTask()}>{task.conversationId ? '继续任务' : '启动任务'}</button>}
      {!managed && !task?.squadId && !conversation?.discussionId && conversation && catalog?.agents.some((agent) => agent.id !== conversation.agent) && supports(task ? 'tasks.handoff' : 'conversations.handoff', 'handoff') && <button disabled={locked || Boolean(task && (dependencies === null || handoffBlocker))} title={handoffBlocker ? reasonText(handoffBlocker, handoffBlocker) : undefined} onClick={() => openAction('handoff')}>移交</button>}
      {!managed && !conversation?.discussionId && !conversation?.routineId && conversation && supports('agentCalls.dispatch', 'delegation') && <button disabled={locked} onClick={() => openAction('delegate')}>委派</button>}
      <button disabled={!connected} onClick={() => setRefresh((v) => v + 1)}>刷新{task ? '任务' : '会话'}</button>
    </div>
    {conversation && supports('conversations.stages', 'stages') && <section className="mobile-detail-section" aria-label="执行阶段"><h3>执行阶段</h3>{stages.length ? <ol className="mobile-stage-list">{stages.map((stage) => <li key={stage.id}><span className="mobile-dot" data-online={!stage.endedAt} /><span><strong>{agentDescriptor(stage.agent).label}</strong><small>{taskTime(stage.startedAt)} · {stage.endedAt ? '已结束' : '当前阶段'}</small></span></li>)}</ol> : <p className="mobile-muted">尚未启动执行阶段</p>}</section>}
    {conversation && supports('agentCalls.list', 'delegation') && <section className="mobile-detail-section" aria-label="委派子会话"><h3>委派子会话</h3>{calls.length ? calls.map((call) => <div className="mobile-delegate" key={call.id}><button className="mobile-delegate-open" onClick={() => openConversation(call.conversationId)}><strong>{call.profile.name}</strong><small>{callState[call.state]} · {agentDescriptor(call.profile.agent).label}</small><span>{call.instruction}</span></button>{(call.result || call.error) && <p className="mobile-text mobile-muted">{call.error || call.result}</p>}{agentCallOpen(call) && supports('agentCalls.cancel', 'delegation') && <button className="mobile-ghost" disabled={locked} onClick={() => { const current = revision.current; void perform(async () => { await write('agentCalls.cancel', { id: call.parentId, callId: call.id }); if (current === revision.current) setRefresh((v) => v + 1) }) }}>取消委派</button>}</div>) : <p className="mobile-muted">尚未委派给其他 Agent</p>}</section>}
  </div>

  return <main className="mobile-app" data-theme={theme} data-text-size={largeText ? 'large' : 'normal'}>
    {wide && <aside className="mobile-sidebar" aria-label="工作区侧栏">{sidebar}</aside>}
    <div className="mobile-main">
    <header className="mobile-header">
      {tab === 'settings' ? <><button className="mobile-icon-button" aria-label="返回聊天" onClick={() => setTab('tasks')}><MobileIcon name="back" /></button><span className="mobile-header-label">设置</span><span className="mobile-header-spacer" /></> : <>
        {!wide && <button className="mobile-icon-button" aria-label={workspace ? '打开工作区' : '打开任务列表'} onClick={() => setDrawerOpen(true)}><MobileIcon name="menu" /></button>}
        <button className="mobile-title-chip" onClick={selected ? () => setTaskInfo(!taskInfo) : openHosts} aria-label={selected ? task ? '任务信息' : '会话信息' : '切换电脑'}><strong>{title}</strong><small><span className="mobile-dot" data-online={connected} />{client.hostName || '连接 Conclave'}<span aria-hidden="true">⌄</span></small></button>
        <button className="mobile-icon-button" aria-label={workspace ? '新建会话' : '新建任务'} disabled={!connected} onClick={workspace ? openNew : openCreate}><MobileIcon name="compose" /></button>
      </>}
    </header>
    {error && !overlay && <p className="mobile-error" role="alert">{error}</p>}
    {!connected && selected && tab !== 'settings' && <div className="mobile-connection" role="status"><span>{connecting ? '正在恢复连接…' : '连接已断开，草稿已保留'}</span><button className="mobile-ghost" onClick={openHosts}>连接</button></div>}
    <div className="mobile-viewport">
    {tab === 'settings' ? <section className="mobile-page mobile-settings">
      <h1>设置</h1>
      <button className="mobile-setting-group mobile-host-row" onClick={openHosts}><span className="mobile-host-icon"><MobileIcon name="computers" /></span><span><strong>{client.hostName || '连接你的 Conclave'}</strong><small>{connected ? '已连接 · 任务在电脑上运行' : '管理已保存的电脑'}</small></span><MobileIcon name="chevron" /></button>
      <h2>外观</h2><div className="mobile-setting-group"><div className="mobile-theme-options" role="group" aria-label="主题">{(['system', 'light', 'dark'] as const).map((value) => <button key={value} aria-pressed={theme === value} onClick={() => { setTheme(value); savePreference('theme', value) }}><span className="mobile-theme-preview" data-preview={value}><i /><i /><i /></span><span>{value === 'system' ? '跟随系统' : value === 'light' ? '浅色' : '深色'}</span></button>)}</div>
        <label className="mobile-setting-row mobile-setting-toggle"><span><MobileIcon name="type" />放大文字</span><input type="checkbox" role="switch" checked={largeText} onChange={(event) => { setLargeText(event.target.checked); savePreference('large-text', String(event.target.checked)) }} /></label>
      </div>
      <h2>连接</h2><div className="mobile-setting-group">
        <label className="mobile-setting-row mobile-setting-toggle"><span><MobileIcon name="refresh" />回到前台时恢复连接</span><input type="checkbox" role="switch" checked={autoReconnect} onChange={(event) => { setAutoReconnect(event.target.checked); savePreference('auto-reconnect', String(event.target.checked)) }} /></label>
        <label className="mobile-setting-row mobile-device-name"><span><MobileIcon name="phone" />设备名称</span><input aria-label="设备名称" value={deviceName} maxLength={80} onChange={(event) => { setDeviceName(event.target.value); savePreference('device-name', event.target.value) }} /></label>
      </div><p className="mobile-muted mobile-setting-note">手动断开后不会自动重连。设备名称用于下一次配对。</p>
      <h2>关于</h2><div className="mobile-setting-group"><div className="mobile-setting-row"><span><MobileIcon name="mark" />agents-go</span><small>实验版</small></div><details className="mobile-setting-details"><summary>连接与数据</summary><p>手机只连接 Conclave 节点；项目、Agent 和模型由电脑管理。</p><p>{client.platform.scanInvitation ? '设备凭据加密保存在此 App，草稿保存在本机。卸载 App 后需要重新配对。' : '凭据和草稿保存在当前浏览器。清除网站数据或更换网址后，需要重新配对。'}后台通知尚未接入。</p><p>电脑需保持开机并开启远程连接。电脑撤销设备后需要重新配对。</p></details></div>
    </section> : selected || (connected && workspace) ? <section className="mobile-task">
      {(!selected || task || conversation) ? <>
        <div className="mobile-history" ref={history} onScroll={(event) => { const element = event.currentTarget; followMessages.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100 }}>
          {before && conversation && <button className="mobile-history-more mobile-ghost" disabled={locked} onClick={() => void perform(async () => { const current = revision.current; const previous = await client.call('chat.page', { id: conversation.id, before }); if (current !== revision.current) return; followMessages.current = false; setOlder((existing) => [...previous.items, ...existing]); setOlderCursor(previous.before) })}>加载更早的消息</button>}
          {!items.length && <div className={`mobile-chat-intro ${!selected ? 'mobile-new-conversation' : ''}`}><span className="mobile-mark"><MobileIcon name="mark" /></span><h1>{selected ? title : '想一起做点什么？'}</h1><p className="mobile-muted">{task?.details || (selected ? '和电脑上的 Agent 继续这段工作。' : '直接开始会话，也可以选一个项目。')}</p>{selected && <button className="mobile-ghost" onClick={() => setTaskInfo(true)}>{task ? '任务信息' : '会话信息'} <span aria-hidden="true">↗</span></button>}{!selected && <ChatPicker label="会话项目" value={project} placeholder="不关联项目" placement="below" options={[{ value: '', label: '不关联项目' }, ...(catalog?.projects ?? []).map((path) => ({ value: path, label: projectName(path), description: path }))]} onChange={setProject} disabled={locked} />}</div>}
          <div className="mobile-chat" aria-label={task ? '任务消息' : '会话消息'}><MobileMessages items={items.filter((item) => !pending.includes(item))} busy={locked} respond={respond} /></div>
        </div>
        <div className="mobile-dock">
          {pending.length > 0 && <div className="mobile-pending" aria-label="待处理请求"><p className="mobile-muted">需要你的回复 · {pending.length}</p><MobileMessages items={pending} busy={locked} respond={respond} /></div>}
          {managed ? <div className="mobile-start"><span className="mobile-muted">子会话由父会话或团队管理</span>{conversation?.parentConversationId && <button onClick={openParent}>返回父会话</button>}</div> : task && !conversation?.chat ? <div className="mobile-start"><span className="mobile-muted">{task.conversationId ? '会话已暂停' : '任务已准备好'}</span><button className="mobile-primary" disabled={locked} onClick={() => void startTask()}>{task.conversationId ? '继续任务' : '启动任务'}</button></div> : <>
            {(busy || !connected || blockingPending || conversation?.chat?.turn === 'running') && <div className="mobile-composer-status" role="status"><span className="mobile-dot" data-online={connected} /><span>{busy ? '正在提交…' : !connected ? '连接后可发送' : blockingPending ? '请先处理上方请求' : '正在执行 · 新消息将排队'}</span>{conversation?.chat?.turn === 'running' && text.trim() && <button className="mobile-ghost" disabled={locked} onClick={() => { const current = revision.current; void perform(async () => { await write('conversations.interrupt', { id: conversation.id }); if (current === revision.current) setRefresh((v) => v + 1) }) }}>停止本轮</button>}</div>}
            <form className="mobile-composer" onSubmit={(event) => void send(event)}>
              {selected && <button type="button" className="mobile-icon-button" aria-label={task ? '任务信息' : '会话信息'} onClick={() => setTaskInfo(!taskInfo)}><MobileIcon name="info" /></button>}
              <label className="mobile-sr-only" htmlFor="mobile-message">发送消息</label><textarea ref={composer} id="mobile-message" value={text} maxLength={10000} rows={1} onChange={(event) => updateDraft(event.target.value)} placeholder={selected ? task ? '继续这个任务…' : '继续这个会话…' : '发送消息，开始新会话…'} />
              {conversation?.chat?.turn === 'running' && !text.trim() ? <button type="button" className="mobile-icon-button mobile-primary" aria-label="停止本轮" disabled={locked} onClick={() => { const current = revision.current; void perform(async () => { await write('conversations.interrupt', { id: conversation.id }); if (current === revision.current) setRefresh((v) => v + 1) }) }}><MobileIcon name="stop" /></button> : <button className="mobile-icon-button mobile-primary" aria-label="发送" disabled={locked || !text.trim() || blockingPending || (!selected && !choice.agent)}><MobileIcon name="send" /></button>}
            </form>
            {catalog && ((!conversation && workspace) || supports('conversations.chatCatalog', 'chat-options')) ? <MobileAgentOptions client={client} catalog={catalog} choice={currentChoice} onChange={changeOptions} disabled={locked || Boolean(conversation && (conversation.workspaceReadOnly || !supports('conversations.setOption', 'chat-options')))} conversation={conversation} state={state} /> : <div className="mobile-composer-caption">{conversation ? agentDescriptor(conversation.agent).label : 'Agent'}<span>·</span>{client.hostName}</div>}
            {!selected && !catalog?.agents.length && <p className="mobile-muted">请先在电脑上安装 Agent。</p>}
          </>}
        </div>
      </> : <p className="mobile-empty">{connected ? `正在读取${selected?.kind === 'task' ? '任务' : '会话'}…` : '连接电脑后查看内容'}</p>}
    </section> : <section className="mobile-welcome"><span className="mobile-mark"><MobileIcon name="mark" /></span><h1>工作继续，随时随地</h1><p>连接你的 Conclave，<br />和电脑上的 Agent 一起完成工作。</p><div className="mobile-welcome-actions">{connected ? <><button className="mobile-primary" onClick={openCreate}><MobileIcon name="compose" />新建任务</button><button onClick={() => setDrawerOpen(true)}><MobileIcon name="tasks" />查看任务</button></> : <>{client.platform.scanInvitation && <button className="mobile-primary" disabled={!initialized || scanning || connecting} onClick={() => void scan()}><MobileIcon name="scan" />{scanning ? '正在扫码…' : connecting ? '正在连接…' : '扫码连接'}</button>}<button className={client.platform.scanInvitation ? '' : 'mobile-primary'} onClick={openHosts}><MobileIcon name="computers" />{client.hosts.length ? '已保存的电脑' : '连接电脑'}</button></>}</div><small>agents-go <span>·</span> Conclave 工作区</small></section>}
    </div>
    </div>
    {wide && taskInfo && selected && tab !== 'settings' && <aside className="mobile-inspector" aria-label={task ? '任务详情' : '会话详情'}><header className="mobile-dialog-heading"><h2>{task ? '任务信息' : '会话信息'}</h2><button className="mobile-icon-button" aria-label="关闭详情" onClick={() => setTaskInfo(false)}><MobileIcon name="close" /></button></header>{detail}</aside>}
    <dialog ref={modal} tabIndex={-1} className={`mobile-dialog ${overlay === 'drawer' ? 'mobile-drawer' : 'mobile-sheet'}`} aria-label={overlay === 'drawer' ? workspace ? '工作区' : '任务列表' : overlay === 'hosts' ? '电脑' : overlay === 'create' ? '新建任务' : overlay === 'handoff' ? '移交会话' : overlay === 'delegate' ? '委派任务' : task ? '任务信息' : '会话信息'} onCancel={(event) => { event.preventDefault(); closeOverlay() }} onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeOverlay() } }}>
    {overlay && <div className="mobile-dialog-content">
      {overlay !== 'drawer' && <><div className="mobile-sheet-handle" aria-hidden="true" /><header className="mobile-dialog-heading"><h2>{overlay === 'hosts' ? manageHosts ? '管理电脑' : '切换电脑' : overlay === 'create' ? '新建任务' : overlay === 'handoff' ? '移交会话' : overlay === 'delegate' ? '委派任务' : task ? '任务信息' : '会话信息'}</h2><button className="mobile-icon-button mobile-ghost" aria-label="关闭" onClick={closeOverlay}><MobileIcon name="close" /></button></header></>}
      {error && <p className="mobile-error" role="alert">{error}</p>}
      {overlay === 'drawer' ? sidebar : overlay === 'hosts' ?
 <div className="mobile-sheet-body">
        {!manageHosts && client.hosts.length > 0 && <div className="mobile-host-list" aria-label="已保存的电脑">{client.hosts.map((host) => <button key={host.id} className="mobile-host-row" aria-pressed={hostId === host.id} onClick={() => changeHost(host.id)} disabled={hostId === host.id}><span className="mobile-host-icon"><MobileIcon name="computers" /></span><span><strong>{host.name}</strong><small>{hostId === host.id ? status : host.lastConnectedAt ? `上次连接 ${taskTime(host.lastConnectedAt)}` : '已配对'}</small></span>{hostId === host.id && <span className="mobile-host-check" aria-hidden="true">✓</span>}</button>)}</div>}
        <div className="mobile-connection-status" role="status">{message}</div>
        {(client.canConnect || connecting) && <div className="mobile-host-config">
          {client.isPairing && <><h3>{client.invitationName || '配对这台电脑'}</h3><label>电脑名称<input value={hostName} maxLength={80} onChange={(event) => setHostName(event.target.value)} /></label><label>设备名称<input value={deviceName} maxLength={80} onChange={(event) => { setDeviceName(event.target.value); savePreference('device-name', event.target.value) }} /></label><p className="mobile-muted">配对后可访问会话、任务和项目，发送消息和处理确认。请确认链接来自你的电脑。</p></>}
          <div className="mobile-toolbar">{connected ? <><button className="mobile-primary" onClick={() => { closeOverlay(); setDrawerOpen(true) }}>查看任务</button><button onClick={leaveConnection}>断开</button></> : <button className="mobile-primary mobile-full" disabled={!initialized || connecting || !client.canConnect || !deviceName.trim() || !hostName.trim() || scanning} onClick={() => void connect()}>{connecting ? '正在连接…' : client.isPairing ? '连接并配对' : '重新连接'}</button>}{connecting && <button onClick={leaveConnection}>取消</button>}</div>
          {manageHosts && !client.isPairing && hostId && <><form onSubmit={(event) => { event.preventDefault(); void client.renameHost(hostId, hostName).then(() => setRefresh((value) => value + 1)).catch((failure: unknown) => setError(failure instanceof Error ? failure.message : '保存失败')) }}><label>显示名称<input value={hostName} maxLength={80} required onChange={(event) => setHostName(event.target.value)} /></label><button disabled={!hostName.trim()}>保存名称</button></form><button className="mobile-danger-text" onClick={() => { leaveConnection(); client.forget(); resetHostView(); setHostName(client.hostName || client.invitationName || '我的电脑'); setRefresh((value) => value + 1) }}>移除此电脑</button><p className="mobile-muted">只清除此设备保存的连接。撤销授权请在电脑的远程连接设置中操作。</p></>}
        </div>}
        {(manageHosts || !client.canConnect) && <div className="mobile-add-host"><h3>添加电脑</h3><p className="mobile-muted">{client.platform.scanInvitation ? '扫描电脑「设置 → 远程连接」的二维码，自动配对并连接。' : '用系统相机扫描电脑「设置 → 远程连接」的二维码，也可以粘贴配对链接。'}</p>{client.platform.scanInvitation && <button className="mobile-primary mobile-full" disabled={!initialized || scanning || connecting || busy} onClick={() => void scan()}><MobileIcon name="scan" />{scanning ? '正在扫码…' : '扫码连接'}</button>}<form onSubmit={(event) => {
          event.preventDefault()
          try { client.importInvitation(invitationLink); leaveConnection(); setInvitationLink(''); setHostName(client.invitationName || '我的电脑'); resetHostView(); setMessage('配对链接已导入，请确认并连接'); setCreating(false); setManageHosts(false); setError(''); setRefresh((value) => value + 1) }
          catch (failure) { setError(failure instanceof Error ? failure.message : '配对链接无效') }
        }}><label>配对链接<textarea value={invitationLink} onChange={(event) => setInvitationLink(event.target.value)} rows={2} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="粘贴电脑生成的完整链接" /></label><button className="mobile-full" disabled={!invitationLink.trim() || connecting}>导入配对链接</button></form></div>}
        {client.canConnect && !client.isPairing && <button className="mobile-manage-hosts mobile-full mobile-ghost" onClick={() => setManageHosts(!manageHosts)}>{manageHosts ? '返回电脑列表' : '管理电脑与添加连接'}<MobileIcon name="chevron" /></button>}
        {client.invitationProblem && <p className="mobile-error">{client.invitationProblem}</p>}{client.storageNotice && <p className="mobile-error">{client.storageNotice}</p>}
      </div> : overlay === 'create' ? <form className="mobile-create mobile-sheet-body" onSubmit={(event) => void create(event)}><label>标题<input name="title" required maxLength={200} placeholder="你想完成什么？" /></label><label>任务说明<textarea name="details" rows={3} maxLength={10000} placeholder="补充目标和要求…" /></label><label>项目<select name="project" aria-label="项目" required defaultValue={project}>{catalog?.projects.map((path) => <option key={path} value={path}>{path}</option>)}</select></label><div className="mobile-field"><span>Agent</span><input type="hidden" name="agent" value={choice.agent ?? ''} /><ChatPicker label="Agent" value={choice.agent} placeholder="选择 Agent" size="field" placement="below" options={(catalog?.agents ?? []).map((agent) => ({ value: agent.id, label: agent.name }))} onChange={(value) => { if (isAgentKind(value)) setChoice({ agent: value }) }} /></div>{!catalog ? <p>正在读取项目和 Agent…</p> : (!catalog.projects.length || !catalog.agents.length) && <p>请先在电脑上添加项目并安装 Agent。</p>}<button className="mobile-primary mobile-full" disabled={locked || !catalog?.projects.length || !choice.agent}>创建任务</button></form>
 : (overlay === 'handoff' || overlay === 'delegate') && catalog ? <form className="mobile-sheet-body mobile-action-form" onSubmit={(event) => void submitAction(event)}>
      {overlay === 'handoff' ? <p className="mobile-muted">由另一个 Agent 接手同一会话，保留已有上下文。委派则会创建并行子会话。{task?.status === 'pending' && '当前任务继续保持规划模式。'}</p> : <><p className="mobile-muted">建立子会话完成一项工作，结果返回当前会话。</p><div className="mobile-field"><span>委派给</span><ChatPicker label="委派角色" value={profileId} placeholder="选择角色" size="field" placement="below" options={[...(directDelegate ? [{ value: '', label: '临时 Agent' }] : []), ...profiles.map((profile) => ({ value: profile.id, label: profile.name, description: profile.description }))]} onChange={setProfileId} /></div></>}
      {(overlay === 'handoff' || (!profileId && directDelegate)) && <MobileAgentOptions client={client} catalog={overlay === 'handoff' ? { ...catalog, agents: catalog.agents.filter((agent) => agent.id !== conversation?.agent) } : catalog} choice={actionChoice} modelProvider={overlay === 'handoff' ? conversation?.modelProvider : undefined} onChange={setActionChoice} disabled={locked} placement="below" showPreset={false} showPermission={overlay === 'handoff' && task?.status !== 'pending'} />}
      {overlay === 'delegate' && !profileId && directDelegate && <div className="mobile-field"><span>工作权限</span><ChatPicker label="委派权限" value={delegateCapability} options={[{ value: 'readOnly', label: '只读分析' }, { value: 'develop', label: '允许修改项目', disabled: Boolean(conversation?.workspaceReadOnly || conversation?.planOnly) }]} placeholder="只读分析" size="field" placement="below" onChange={(value) => { if (value === 'readOnly' || value === 'develop') setDelegateCapability(value) }} /></div>}
      <label>{overlay === 'handoff' ? '移交说明' : '委派说明'}<textarea value={actionText} onChange={(event) => setActionText(event.target.value)} rows={4} maxLength={10000} required={overlay === 'delegate'} placeholder={overlay === 'handoff' ? '接下来要继续什么？' : '说明目标、范围和完成标准'} /></label>
      {overlay === 'handoff' && !task && needsStop && <label className="mobile-check"><input type="checkbox" checked={stopRunning} onChange={(event) => setStopRunning(event.target.checked)} />停止当前轮次后移交</label>}
      <button className="mobile-primary mobile-full" disabled={locked || (!profileId && !actionChoice.agent) || (overlay === 'delegate' && (!actionText.trim() || (!profileId && !directDelegate))) || (overlay === 'handoff' && !task && needsStop && !stopRunning)}>{overlay === 'handoff' ? '确认移交' : '确认委派'}</button>
    </form> : detail}
    </div>}
    </dialog>
  </main>
}
type RequestItem = Extract<ChatItem, { kind: 'approval' | 'question' }>
type IconName = Tab | 'menu' | 'compose' | 'back' | 'chevron' | 'close' | 'mark' | 'send' | 'stop' | 'info' | 'folder' | 'search' | 'type' | 'refresh' | 'phone' | 'scan'
function MobileIcon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    tasks: 'M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01', computers: 'M3 4h18v13H3zM8 21h8M12 17v4', settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
    menu: 'M4 6h16M4 12h12M4 18h16', compose: 'M13 5H5v15h15v-8M10 14l1-4 9-9 3 3-9 9-4 1', back: 'M19 12H5m7-7-7 7 7 7', chevron: 'm9 5 7 7-7 7', close: 'm6 6 12 12M6 18 18 6', mark: 'm5 6 6 6-6 6M13 18h6', send: 'M12 19V5m-6 6 6-6 6 6', stop: 'M7 7h10v10H7z', info: 'M12 11v6m0-10v.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', folder: 'M3 5h6l2 3h10v12H3z', search: 'm16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', type: 'm3 19 6-14 6 14M5 14h8M17 10h5m-2.5 0v9', refresh: 'M20 7a9 9 0 1 0 1 8M20 3v5h-5', phone: 'M7 2h10v20H7zM11 18h2', scan: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 7h3v3H7zM14 7h3v3h-3zM7 14h3v3H7zM14 14h3v3h-3z'
  }
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
