import { describe, expect, it } from 'vitest'
import type { ChatCatalog } from '@conclave/protocol'
import { resolveModel } from './agent-models'
import { discussionModelChoice, discussionModelReady, discussionModelUnavailable } from './discussion-model'

const catalog: ChatCatalog = {
  models: [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', description: null, efforts: ['low', 'high'], isDefault: true },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', description: null, efforts: ['low'], isDefault: false }
  ]
}

describe('group chat model choices', () => {
  it('submits the displayed catalog default even when the user never changed models', () => {
    const untouched = {}
    expect(resolveModel(catalog, untouched).model?.id).toBe('gpt-6-astra')
    expect(discussionModelChoice(catalog, untouched)).toEqual({ model: 'gpt-6-astra' })
    // The runtime may have an unsupported default such as Terra; omitting model is not equivalent.
    expect(discussionModelChoice(catalog, untouched).model).not.toBeUndefined()
  })

  it('keeps an explicit model and only a reasoning effort that it supports', () => {
    expect(discussionModelChoice(catalog, { model: 'gpt-6-astra', effort: 'high' })).toEqual({ model: 'gpt-6-astra', effort: 'high' })
    expect(discussionModelChoice(catalog, { model: 'gpt-6-luna', effort: 'high' })).toEqual({ model: 'gpt-6-luna' })
    expect(discussionModelChoice(catalog, { model: 'gpt-6-astra', effort: 'low' })).toEqual({ model: 'gpt-6-astra', effort: 'low' })
  })

  it('requires a new choice instead of silently replacing a copied group’s retired model', () => {
    const copied = { model: 'gpt-6.1-terra', effort: 'ultra' }
    expect(discussionModelChoice(catalog, copied)).toEqual(copied)
    expect(discussionModelUnavailable(catalog, copied)).toBe(true)
    expect(discussionModelReady(catalog, copied)).toBe(false)
    expect(discussionModelReady(catalog, { model: 'gpt-6-astra' })).toBe(true)
  })

  it('does not invent a specific model for agents without a catalog or catalog default', () => {
    for (const unavailable of [undefined, null, { models: [] }]) {
      expect(discussionModelChoice(unavailable, {})).toEqual({})
      expect(discussionModelChoice(unavailable, { model: 'existing-model' })).toEqual({ model: 'existing-model' })
    }
    expect(discussionModelChoice(null, { model: 'existing-model', effort: 'high' })).toEqual({ model: 'existing-model', effort: 'high' })
    expect(discussionModelChoice({ models: catalog.models.map((model) => ({ ...model, isDefault: false })) }, {})).toEqual({})
    expect(discussionModelReady(undefined, {})).toBe(false)
    expect(discussionModelReady(null, {})).toBe(true)
    expect(discussionModelReady({ models: catalog.models.map((model) => ({ ...model, isDefault: false })) }, {})).toBe(false)
  })
})
