import { useEffect, useState } from 'react'
import { activeAccount, DEFAULT_ACCOUNT, type AgentAccounts, type AgentKind, type ChatCatalog, type ChatModel, type Environment, type ModelProvider } from '@conclave/protocol'
import { useCore } from './core-store'
import { catalogKey } from './model-provider-choice'

// A model and effort picked for an agent to start in; absent is its default.
export type ModelChoice = { model?: string; effort?: string }

// Identifies the active account, sign-in state, and CLI binary/version so native model catalogs
// reload automatically when an account or CLI setup changes.
export function agentCatalogScope(agent: AgentKind, accounts: AgentAccounts | null, environment: Environment | null): string {
  const accountId = activeAccount(accounts, agent)
  const entry = accounts?.accounts.find((item) => item.agent === agent && item.id === accountId)
  const check = environment?.checks.find((item) => item.tool === agent)
  const signedIn = entry ? entry.signedIn : (accountId === DEFAULT_ACCOUNT ? Boolean(check?.signedIn) : false)
  return `${accountId}:${signedIn ? '1' : '0'}:${check?.version ?? ''}:${check?.path ?? ''}`
}

// The models an agent offers, or a model provider offers it, asked of core once each while the caller
// is shown: undefined while the answer is on its way, null when there is none.
export function useAgentCatalog(agent: AgentKind | null, enabled: boolean, provider: ModelProvider | null = null): ChatCatalog | null | undefined {
  const rpc = useCore((s) => s.rpc)
  const accounts = useCore((s) => s.accounts)
  const environment = useCore((s) => s.environment)
  const [catalogs, setCatalogs] = useState<Record<string, ChatCatalog | null>>({})
  const scope = agent && !provider ? agentCatalogScope(agent, accounts, environment) : null
  const key = agent ? catalogKey(agent, provider, scope) : null
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
  const accounts = useCore((state) => state.accounts)
  const environment = useCore((state) => state.environment)
  const [catalogs, setCatalogs] = useState<Record<string, ChatCatalog | null>>({})
  const unique = [...new Set(agents)].sort()
  const entries = unique.map((agent) => ({
    agent,
    key: catalogKey(agent, null, agentCatalogScope(agent, accounts, environment))
  }))
  const cacheKey = entries.map((entry) => entry.key).join(',')
  useEffect(() => {
    if (!rpc) return
    let current = true
    const pending = entries.filter((entry) => !(entry.key in catalogs))
    if (!pending.length) return
    void Promise.all(pending.map(async (entry) => {
      const catalog = await rpc.call('conversations.chatCatalog', { agent: entry.agent }).catch(() => null)
      return { key: entry.key, catalog }
    })).then((loaded) => {
      if (current && loaded.length) setCatalogs((known) => ({ ...known, ...Object.fromEntries(loaded.map(({ key, catalog }) => [key, catalog])) }))
    })
    return () => { current = false }
  }, [rpc, cacheKey])
  return Object.fromEntries(entries.flatMap((entry) => entry.key in catalogs ? [[entry.agent, catalogs[entry.key] ?? null]] : []))
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
