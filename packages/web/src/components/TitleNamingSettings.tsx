import { t } from '../i18n'
import { setChatSettings, useCore } from '../core-store'
import { usePreferences } from '../preferences'
import { Segmented, SettingsRow } from './SettingsControls'

export function TitleNamingSettings() {
  const mode = useCore((state) => state.chatSettings?.titleNaming)
  if (mode === undefined) return null
  return <SettingsRow
    label={t('TitleNamingSettings.conversationTitleNaming')}
    description={t('TitleNamingSettings.whenOffUseTheFirstMessageWhenOn')}
    control={(labelId) => <div className="title-naming-options"><Segmented labelId={labelId} value={mode}
      options={[{ value: 'off', label: t('common.off') }, { value: 'first', label: t('TitleNamingSettings.summarizeFirstTurn') }, { value: 'latest', label: t('TitleNamingSettings.updateEveryTurn') }]}
      onChange={(titleNaming) => void setChatSettings({ titleNaming, titleModels: usePreferences.getState().quickModels })} /></div>}
  />
}
