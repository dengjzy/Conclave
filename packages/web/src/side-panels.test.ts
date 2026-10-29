import { describe, expect, it } from 'vitest'
import { exclusivePanels, type SidePanels } from './side-panels'

const closed: SidePanels = { terminalPanelOpen: false, inspectorOpen: false, conversationInspectorOpen: false, utilityPanelOrder: [] }

describe('exclusivePanels', () => {
  it('puts the inspectors away when the terminal opens', () => {
    const before = { ...closed, inspectorOpen: true, conversationInspectorOpen: true }
    expect(exclusivePanels({ ...before, terminalPanelOpen: true, utilityPanelOrder: ['terminal'] }, before)).toEqual({ inspectorOpen: false, conversationInspectorOpen: false })
  })

  it('puts the terminal away when either inspector opens', () => {
    const before: SidePanels = { ...closed, terminalPanelOpen: true, utilityPanelOrder: ['terminal'] }
    const expected = { terminalPanelOpen: false, utilityPanelOrder: [] }
    expect(exclusivePanels({ ...before, inspectorOpen: true }, before)).toEqual(expected)
    expect(exclusivePanels({ ...before, conversationInspectorOpen: true }, before)).toEqual(expected)
  })

  it('puts ports away with the terminal when an inspector opens', () => {
    const before: SidePanels = { ...closed, terminalPanelOpen: true, portsPanelOpen: true, utilityPanelOrder: ['ports', 'terminal'] }
    expect(exclusivePanels({ ...before, inspectorOpen: true }, before)).toEqual({ terminalPanelOpen: false, portsPanelOpen: false, utilityPanelOrder: [] })
  })

  it('treats the files panel as the terminal: either it or an inspector', () => {
    const inspector = { ...closed, conversationInspectorOpen: true }
    expect(exclusivePanels({ ...inspector, filesPanelOpen: true, utilityPanelOrder: ['files'] }, inspector)).toEqual({ inspectorOpen: false, conversationInspectorOpen: false })
    const files: SidePanels = { ...closed, filesPanelOpen: true, utilityPanelOrder: ['files'] }
    expect(exclusivePanels({ ...files, inspectorOpen: true }, files)).toEqual({ terminalPanelOpen: false, filesPanelOpen: false, utilityPanelOrder: [] })
  })

  it('changes nothing when nothing opens, or the other side is already away', () => {
    const terminal = { ...closed, terminalPanelOpen: true }
    expect(exclusivePanels(terminal, terminal)).toBeNull()
    expect(exclusivePanels(terminal, closed)).toBeNull()
    expect(exclusivePanels({ ...closed, inspectorOpen: true }, closed)).toBeNull()
    expect(exclusivePanels(closed, { ...closed, inspectorOpen: true })).toBeNull()
  })
})
