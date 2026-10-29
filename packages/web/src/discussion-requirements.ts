import { localized, t } from './i18n'
import { DEFAULT_DISCUSSION_REQUIREMENTS } from '@conclave/protocol'

export const DISCUSSION_REQUIREMENT_PRESETS = localized(() => ([
  { id: 'concise', label: t('discussionRequirements.conciseDiscussion'), description: t('discussionRequirements.beSpecificExplainReasoningAndAimForUnder'), text: DEFAULT_DISCUSSION_REQUIREMENTS },
  { id: 'compare', label: t('discussionRequirements.compareApproaches'), description: t('discussionRequirements.compareBenefitsCostsRisksAndApplicability'), text: [
    '- 列出主要可选方案，比较各自的收益、成本、风险和适用条件。',
    '- 区分已知事实与假设；不确定的地方明确说明。',
    '- 最后给出推荐方案、理由，以及需要进一步验证的问题。'
  ].join('\n') },
  { id: 'deep', label: t('discussionRequirements.inDepthAnalysis'), description: t('discussionRequirements.developArgumentsFullyWithEvidenceCounterexamplesAndUncertainty'), text: [
    '- 根据问题需要充分展开，不限制篇幅。',
    '- 给出论据与证据；引用项目代码时注明文件和行号。',
    '- 主动检查反例、边界条件与替代解释，明确不确定性。',
    '- 总结关键结论、分歧和仍需验证的问题。'
  ].join('\n') }
] as const))
