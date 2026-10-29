import { t } from '../i18n'
import { AUTO_ARCHIVE_DAYS, DEFAULT_AUTO_ARCHIVE_DAYS } from '@conclave/protocol'
import { setChatSettings, useCore } from '../core-store'
import { Segmented, SettingsRow, Toggle } from './SettingsControls'

// Off by default; on, how long a conversation may sit idle before core puts it away. Hidden against
// a core that does not archive on its own.
export function AutoArchiveSettings() {
  const days = useCore((state) => state.chatSettings?.autoArchiveDays)
  if (days === undefined) return null
  return <>
    <SettingsRow
      label={t('AutoArchiveSettings.automaticallyArchiveInactiveConversations')}
      description={t('AutoArchiveSettings.archiveConversationsWithNoRecentMessagesFindThem')}
      control={(labelId) => (
        <Toggle labelId={labelId} checked={days !== null} onChange={(on) => void setChatSettings({ autoArchiveDays: on ? DEFAULT_AUTO_ARCHIVE_DAYS : null })} />
      )}
    />
    {days !== null && (
      <SettingsRow
        label={t('AutoArchiveSettings.inactivityPeriod')}
        description={t('AutoArchiveSettings.measuredFromTheLastMessageOrWhenYou')}
        control={(labelId) => (
          <Segmented labelId={labelId} value={String(days)}
            options={AUTO_ARCHIVE_DAYS.map((each) => ({ value: String(each), label: t('AutoArchiveSettings.days', { each: each }) }))}
            onChange={(value) => void setChatSettings({ autoArchiveDays: Number(value) })} />
        )}
      />
    )}
  </>
}
