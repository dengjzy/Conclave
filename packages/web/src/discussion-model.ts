import type { ChatCatalog } from '@conclave/protocol'
import { resolveModel, type ModelChoice } from './agent-models'

// A displayed catalog default must become an explicit choice before a group starts.
export function discussionModelChoice(catalog: ChatCatalog | null | undefined, choice: ModelChoice): ModelChoice {
  const resolved = resolveModel(catalog, choice)
  const model = choice.model ?? resolved.model?.id
  const effort = discussionModelUnavailable(catalog, choice) || !catalog ? choice.effort : resolved.effort
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
}

export function discussionModelUnavailable(catalog: ChatCatalog | null | undefined, choice: ModelChoice): boolean {
  return Boolean(catalog && choice.model && !catalog.models.some((model) => model.id === choice.model))
}

export function discussionModelReady(catalog: ChatCatalog | null | undefined, choice: ModelChoice): boolean {
  return catalog !== undefined && !discussionModelUnavailable(catalog, choice) && (!catalog?.models.length || Boolean(discussionModelChoice(catalog, choice).model))
}
