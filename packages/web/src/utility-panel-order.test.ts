import { describe, expect, it } from 'vitest'
import { openUtilityPanel, updateUtilityPanelOrder, visibleUtilityPanelOrder, type UtilityPanelsOpen } from './utility-panel-order'

const none: UtilityPanelsOpen = { terminal: false, ports: false, files: false }

describe('utility panel order', () => {
  it('puts a newly opened panel below one already open', () => {
    const filesFirst = updateUtilityPanelOrder([], 'files', true)
    expect(updateUtilityPanelOrder(filesFirst, 'terminal', true)).toEqual(['files', 'terminal'])

    const terminalFirst = updateUtilityPanelOrder([], 'terminal', true)
    expect(updateUtilityPanelOrder(terminalFirst, 'files', true)).toEqual(['terminal', 'files'])
  })

  it('moves a closed and reopened panel to the bottom', () => {
    const closed = updateUtilityPanelOrder(['files', 'terminal'], 'files', false)
    expect(updateUtilityPanelOrder(closed, 'files', true)).toEqual(['terminal', 'files'])
  })

  it('repairs a missing order while respecting the panels that are visible', () => {
    expect(visibleUtilityPanelOrder([], { ...none, files: true })).toEqual(['files'])
    expect(visibleUtilityPanelOrder(['terminal'], { ...none, files: true, terminal: true })).toEqual(['terminal', 'files'])
    expect(visibleUtilityPanelOrder(['files', 'terminal'], { ...none, terminal: true })).toEqual(['terminal'])
  })
})

describe('openUtilityPanel', () => {
  it('stacks any two of the three, the newer below', () => {
    expect(openUtilityPanel(['ports'], { ...none, ports: true }, 'terminal')).toEqual(['ports', 'terminal'])
    expect(openUtilityPanel(['files'], { ...none, files: true }, 'ports')).toEqual(['files', 'ports'])
  })

  it('puts the top one away when a third opens', () => {
    const open = { ...none, files: true, terminal: true }
    expect(openUtilityPanel(['files', 'terminal'], open, 'ports')).toEqual(['terminal', 'ports'])
    expect(openUtilityPanel(['terminal', 'files'], open, 'ports')).toEqual(['files', 'ports'])
  })

  it('leaves a panel already open where it is', () => {
    expect(openUtilityPanel(['files', 'terminal'], { ...none, files: true, terminal: true }, 'files')).toEqual(['files', 'terminal'])
  })
})
