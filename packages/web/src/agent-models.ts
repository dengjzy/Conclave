import { useEffect, useState } from 'react'
import type { AgentKind, ChatCatalog, ChatModel, ModelProvider } from '@conclave/protocol'
import { useCore } from './core-store'
import { catalogKey } from './model-provider-choice'

// A model and effort picked for an agent to start in; absent is its default.
export type ModelChoice = { model?: string; effort?: string }

// The models an agent offers, or a model provider offers it, asked of core once each while the caller
// is shown: undefined while the answer is on its way, null when there is none.
export function useAgentCatalog(agent: AgentKind | null, enabled: boolean, provider: ModelProvider | null = null): ChatCatalog | null | undefined {
  const rpc = useCore((s) => s.rpc)
  const [catalogs, setCatalogs] = useState<Record<string, ChatCatalog | null>>({})
  const key = agent ? catalogKey(agent, provider) : null
  useEffect(() => {
    if (!agent || !key || !rpc || !enabled || key in catalogs) return
    let current = true
    const settle = (catalog: ChatCatalog | null) => {
      if (current) setCatalogs((known) => ({ ...known, [key]: catalog }))
    }
    rpc.call('conversations.chatCatalog', { agent, ...(provider ? { modelProvider: provider.id } : {}) }).then(settle, () => settle(null))
    return () => { current = false }
  }, [agent, key, provider, rpc, enabled, catalogs])
  return key ? catalogs[key] : null
}

// Group creation needs the same catalog snapshot for its labels and submitted choices.
export function useAgentCatalogs(agents: readonly AgentKind[]): Partial<Record<AgentKind, ChatCatalog | null>> {
  const rpc = useCore((state) => state.rpc)
  const [catalogs, setCatalogs] = useState<Partial<Record<AgentKind, ChatCatalog | null>>>({})
  const unique = [...new Set(agents)].sort()
  const key = unique.join(',')
  useEffect(() => {
    if (!rpc) return
    let current = true
    const pending = unique.filter((agent) => !(agent in catalogs))
    void Promise.all(pending.map(async (agent) => {
      const catalog = await rpc.call('conversations.chatCatalog', { agent }).catch(() => null)
      return { agent, catalog }
    })).then((loaded) => {
      if (current && loaded.length) setCatalogs((known) => ({ ...known, ...Object.fromEntries(loaded.map(({ agent, catalog }) => [agent, catalog])) }))
    })
    return () => { current = false }
  }, [rpc, key])
  return catalogs
}

export type ResolvedModel = {
  defaultModel: ChatModel | undefined
  // The model it will run: the one picked, else the default.
  model: ChatModel | undefined
  // The one picked, when the catalog lists it; undefined is the default.
  modelId: string | undefined
  efforts: readonly string[]
  effort: string | undefined
}

// A choice as the catalog can take it: a model it lists, an effort that model takes.
export function resolveModel(catalog: ChatCatalog | null | undefined, choice: ModelChoice): ResolvedModel {
  const defaultModel = catalog?.models.find((each) => each.isDefault)
  const picked = catalog?.models.find((each) => each.id === choice.model)
  const model = picked ?? defaultModel
  const efforts = model?.efforts ?? []
  return {
    defaultModel,
    model,
    modelId: picked?.id,
    efforts,
    effort: choice.effort && efforts.includes(choice.effort) ? choice.effort : undefined
  }
}
