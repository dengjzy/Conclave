import { t } from '../i18n'
import { openOverview, useOverview, useCore } from '../core-store'
import { CountBadge } from './CountBadge'
import { ListIcon } from './icons'

export function OverviewEntry() {
  const open = useCore((s) => s.overviewOpen)
  const count = useOverview().counts.mine
  return (
    <button type="button" className="inbox-entry overview-entry" aria-current={open}
      aria-label={t('OverviewEntry.overview', { value1: count ? t('OverviewEntry.itemsNeedYourResponse', { count: count }) : '' })} onClick={openOverview}>
      <ListIcon />
      <span>{t('OverviewEntry.overview_1276')}</span>
      <CountBadge count={count} />
    </button>
  )
}
