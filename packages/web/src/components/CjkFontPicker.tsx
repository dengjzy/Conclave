import { t } from '../i18n'
import { useCallback, useState } from 'react'
import { setPreference, usePreferences } from '../preferences'
import { chineseFamilies, cssFontFamily, systemFontFamilies } from '../system-fonts'
import { FontList, type Listing } from './ChatFontPicker'
import { ChevronDownIcon } from './icons'
import { Popover } from './Popover'
import { Segmented } from './SettingsControls'

const SAMPLE = '你好，世界'

// The family Chinese is set in, apart from the Latin font: the one that goes with it by default, or
// one installed here that has Chinese, each listed with a line of it in itself.
export function CjkFontPicker({ labelId, preference, title }: {
  labelId: string
  preference: 'chatCjkFontFamily' | 'codeCjkFontFamily'
  title: string
}) {
  const family = usePreferences((s) => s[preference])
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  const close = useCallback(() => setOpen(false), [])
  // Listed on the click that opens it: Chromium lists fonts only for a user's gesture.
  const openList = () => {
    setOpen(true)
    if (listing.state === 'ready') return
    setListing({ state: 'loading' })
    void systemFontFamilies().then((found) => setListing(found ? { state: 'ready', families: chineseFamilies(found) } : { state: 'unavailable' }))
  }
  const choose = (next: 'default' | 'custom') => {
    if (next === 'custom') return openList()
    close()
    setPreference(preference, '')
  }
  return (
    <div className="font-picker-control">
      <Segmented
        labelId={labelId}
        value={family ? 'custom' : 'default'}
        onChange={choose}
        options={[
          { value: 'default', label: t('CjkFontPicker.default') },
          { value: 'custom', label: t('ChatFontPicker.other') }
        ]}
      />
      {(family || open) && (
        <span className="menu-anchor">
          <button
            type="button"
            className="button ghost font-picker-button"
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => (open ? close() : openList())}
          >
            <span style={family ? { fontFamily: cssFontFamily(family) } : undefined}>{family || t('ChatFontPicker.chooseFont')}</span>
            <ChevronDownIcon />
          </button>
          {open && (
            <Popover label={title} onClose={close}>
              <FontList
                current={family}
                listing={listing}
                sample={SAMPLE}
                onPick={(picked) => {
                  setPreference(preference, picked)
                  close()
                }}
              />
            </Popover>
          )}
        </span>
      )}
    </div>
  )
}
