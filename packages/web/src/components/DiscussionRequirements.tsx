import { t } from '../i18n'
import { useId } from 'react'
import { MAX_DISCUSSION_REQUIREMENTS } from '@conclave/protocol'
import { DISCUSSION_REQUIREMENT_PRESETS } from '../discussion-requirements'
import { ChatPicker } from './ChatPicker'

export function DiscussionRequirements({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const id = useId()
  const selected = DISCUSSION_REQUIREMENT_PRESETS.find((preset) => preset.text === value)?.id ?? null
  return (
    <div className="discussion-draft-field">
      <div className="discussion-draft-requirements-head">
        <label htmlFor={id}>{t('DiscussionRequirements.discussionRequirementsOptional')}</label>
        <ChatPicker
          label={t('DiscussionRequirements.usePreset')}
          value={selected}
          placeholder={value ? t('DiscussionRequirements.custom') : t('DiscussionRequirements.usePreset')}
          size="large"
          placement="below"
          disabled={disabled}
          title={t('DiscussionRequirements.choosingAPresetReplacesTheContentBelowYou')}
          options={DISCUSSION_REQUIREMENT_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, description: preset.description }))}
          onChange={(chosen) => {
            const preset = DISCUSSION_REQUIREMENT_PRESETS.find((preset) => preset.id === chosen)
            if (preset) onChange(preset.text)
          }}
        />
      </div>
      <textarea
        id={id}
        className="discussion-draft-requirements"
        rows={4}
        maxLength={MAX_DISCUSSION_REQUIREMENTS}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        placeholder={t('DiscussionRequirements.sharedRequirementsForLengthStyleReasoningOrOutput')}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-hint`} className="discussion-draft-requirements-hint muted">{t('DiscussionRequirements.appliesToEveryMemberEveryRoundAndThe')}</p>
    </div>
  )
}
