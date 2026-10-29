import { describe, expect, it } from 'vitest'
import { piCompatible, piInstallation } from './pi-cli'
import { parsePiModelId, piEfforts, piModels, piProviderModels } from './pi-models'

describe('Pi CLI', () => {
  it('runs a Pi with registerMcpServer: 0.99 on', () => {
    expect(piCompatible('0.98.9')).toBe(false)
    expect(piCompatible('0.99.0')).toBe(true)
    expect(piCompatible('1.0.4')).toBe(true)
    expect(piCompatible(null)).toBe(false)
  })

  it('installs it from npm on every platform', () => {
    expect(piInstallation('darwin')).toEqual({ agent: 'pi', shell: 'bash', command: 'npm install -g @earendil-works/pi-coding-agent' })
    expect(piInstallation('win32')?.shell).toBe('powershell')
  })

  it('offers the thinking levels Pi does: the usual unless mapped away, xhigh and max only where mapped', () => {
    expect(piEfforts({ id: 'm', provider: 'p', reasoning: true, thinkingLevelMap: { xhigh: 'xhigh', minimal: 'low' } })).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(piEfforts({ id: 'm', provider: 'p', reasoning: true, thinkingLevelMap: { off: null, max: 'max' } })).toEqual(['minimal', 'low', 'medium', 'high', 'max'])
    expect(piEfforts({ id: 'm', provider: 'p', reasoning: false })).toEqual([])
  })

  it('offers a model provider\'s models under Conclave\'s name for it, with the effort levels Pi has', () => {
    const models = piProviderModels({ providerId: 'glm', defaultModel: 'glm-5', models: [{ id: 'glm-5', label: null, contextWindow: null, maxOutput: null, efforts: ['high', 'turbo'] }, { id: 'glm-4.7', label: 'GLM 4.7', contextWindow: null, maxOutput: null, efforts: [] }] })
    expect(models).toEqual([
      { id: 'conclave-glm/glm-5', label: 'glm-5', description: null, efforts: ['high'], isDefault: true },
      { id: 'conclave-glm/glm-4.7', label: 'GLM 4.7', description: null, efforts: [], isDefault: false }
    ])
  })

  it('names a model by its provider and id, as Pi takes one', () => {
    expect(piModels([{ id: 'claude-sonnet-5-5', provider: 'anthropic', name: 'Claude Sonnet 5.5' }], 'anthropic/claude-sonnet-5-5')).toEqual([
      { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', description: 'anthropic', efforts: [], isDefault: true }
    ])
    expect(parsePiModelId('openrouter/anthropic/claude')).toEqual({ provider: 'openrouter', modelId: 'anthropic/claude' })
    expect(parsePiModelId('claude')).toBeNull()
  })
})
