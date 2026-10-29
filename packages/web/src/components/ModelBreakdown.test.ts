import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DashboardModel } from '@conclave/protocol'
import { ModelBreakdown, modelDetails } from './ModelBreakdown'

const row = (fields: Partial<DashboardModel>): DashboardModel => ({
  agent: 'claude', model: 'opus', runs: 0, decided: 0, accepted: 0, medianRunMs: null, turns: 0, tokens: 0, ...fields
})
const detailed = { continued: 0, redone: 0, failedTurns: 0, interruptedTurns: 0, usageLimitTurns: 0, medianTurnMs: null }

describe('model breakdown', () => {
  it('opens a row only where its core reported the details', () => {
    const html = (models: DashboardModel[]) => renderToStaticMarkup(createElement(ModelBreakdown, { models }))
    expect(html([row({ runs: 2, turns: 3 })])).not.toContain('aria-expanded')
    expect(html([row({ runs: 2, turns: 3, ...detailed })])).toContain('aria-expanded="false"')
  })

  it('tells how judged runs went and how turns broke off, with shares once there are enough', () => {
    expect(modelDetails(row({ runs: 6, decided: 5, accepted: 3, ...detailed, continued: 1, redone: 1, turns: 4, failedTurns: 2, usageLimitTurns: 1, interruptedTurns: 1, medianTurnMs: 3000 }))).toEqual([
      '任务：判定 5 次，接受 3（60%） · 继续修改 1（20%） · 重做 1（20%）',
      '对话：失败 2（撞额度 1） · 中断 1 · 每回合耗时中位 3 秒'
    ])
  })

  it('leaves out what a row has none of', () => {
    expect(modelDetails(row({ runs: 2, ...detailed }))).toEqual([])
  })
})
