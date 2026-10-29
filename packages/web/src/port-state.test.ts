import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRpcClient, Task, type ListeningPort, type RpcConnection } from '@conclave/protocol'
import { portGroups, portKey, portUrl, openPort } from './port-state'
import { setPortsMaximized, showTerminal, toggleFilesPanel, togglePortsPanel, toggleTerminalPanel, useCore } from './core-store'

const port: ListeningPort = { sessionId: 'session', pid: 123, startedAt: 'start', port: 3000, address: '127.0.0.1', command: 'node', canStop: true, terminalId: null, conversationId: null, taskId: null, label: null, cwd: '/project' }
beforeEach(() => useCore.setState(useCore.getInitialState(), true))

describe('port presentation', () => {
  it.each([['*','http://127.0.0.1:3000/'], ['0.0.0.0','http://127.0.0.1:3000/'], ['::','http://[::1]:3000/'], ['::1','http://[::1]:3000/'], ['127.0.0.1','http://127.0.0.1:3000/']])('opens %s on a usable local address', (address, url) => {
    expect(portUrl({ ...port, address })).toBe(url)
  })

  it('distinguishes a port reused by a new process and IPv4/IPv6 listeners', () => {
    expect(portKey(port)).not.toBe(portKey({ ...port, startedAt: 'later' }))
    expect(portKey(port)).not.toBe(portKey({ ...port, address: '::1' }))
  })

  it('groups services by task, while keeping unrelated terminals distinct', () => {
    const task = Task.parse({ id: 'task', title: 'Login page', details: '', status: 'running', agent: 'claude', repos: [], dependsOn: [], createdAt: 0, updatedAt: 0 })
    const groups = portGroups([{ ...port, taskId: task.id }, { ...port, taskId: task.id, port: 8080 }, { ...port, sessionId: 'another' }], { task }, {}, [])
    expect(groups.map((each) => [each.title, each.ports.length])).toEqual([['Login page', 2], ['终端', 1]])
  })
})

describe('port panel navigation', () => {
  it('closes inspectors when the port panel opens', () => {
    useCore.setState({ inspectorOpen: true, conversationInspectorOpen: true })
    togglePortsPanel()
    expect(useCore.getState()).toMatchObject({ portsPanelOpen: true, inspectorOpen: false, conversationInspectorOpen: false })
    useCore.setState({ inspectorOpen: true })
    expect(useCore.getState().portsPanelOpen).toBe(false)
  })

  it('stacks two of the three panels, and a third puts the top one away', async () => {
    useCore.setState({ terminals: [{ id: 'terminal', sessionId: 's', cwd: '/p', title: 'dev', createdAt: 0 }] })
    toggleFilesPanel()
    togglePortsPanel()
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['files', 'ports'], filesPanelOpen: true, portsPanelOpen: true })
    await toggleTerminalPanel()
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['ports', 'terminal'], filesPanelOpen: false, portsPanelOpen: true, terminalPanelOpen: true })
    toggleFilesPanel()
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['terminal', 'files'], portsPanelOpen: false, filesPanelOpen: true })
    showTerminal('terminal')
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['terminal', 'files'], activeTerminalId: 'terminal' })
    await toggleTerminalPanel()
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['files'], terminalPanelOpen: false })
  })

  it('lets a panel opened beside a maximized one show, back at its size', () => {
    togglePortsPanel()
    setPortsMaximized(true)
    toggleFilesPanel()
    expect(useCore.getState()).toMatchObject({ utilityPanelOrder: ['ports', 'files'], portsMaximized: false })
  })

  it('does not leave another utility maximized behind a maximized port panel', () => {
    useCore.setState({ terminalMaximized: true, filesMaximized: true })
    setPortsMaximized(true)
    expect(useCore.getState()).toMatchObject({ portsMaximized: true, terminalMaximized: false, filesMaximized: false })
  })

  it('opens a port in a new browser window', () => {
    const openMock = vi.fn()
    ;(globalThis as any).window = { open: openMock }
    openPort({ ...port, port: 3000, address: '127.0.0.1' })
    expect(openMock).toHaveBeenCalledWith('http://127.0.0.1:3000/', '_blank')
  })
})
