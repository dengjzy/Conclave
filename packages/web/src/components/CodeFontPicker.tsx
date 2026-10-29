import { t } from '../i18n'
import { useCallback, useState } from 'react'
import { setPreference, usePreferences } from '../preferences'
import { cssFontFamily, isMonospace, systemFontFamilies } from '../system-fonts'
import { FontList, type Listing } from './ChatFontPicker'
import { ChevronDownIcon } from './icons'
import { Popover } from './Popover'
import { Segmented } from './SettingsControls'

// The font for code and the terminal: the bundled Geist Mono, or a monospaced family installed
// here. Only those are listed: in a proportional font the terminal's columns come apart.
export function CodeFontPicker({ labelId }: { labelId: string }) {
  const family = usePreferences((s) => s.codeFontFamily)
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  const close = useCallback(() => setOpen(false), [])
  // Listed on the click that opens it: Chromium lists fonts only for a user's gesture.
  const openList = () => {
    setOpen(true)
    if (listing.state === 'ready') return
    setListing({ state: 'loading' })
    void systemFontFamilies().then((found) => setListing(found ? { state: 'ready', families: found.filter(isMonospace) } : { state: 'unavailable' }))
  }
  const choose = (next: 'bundled' | 'custom') => {
    if (next === 'custom') return openList()
    close()
    setPreference('codeFontFamily', '')
  }
  return (
    <div className="font-picker-control">
      <Segmented
        labelId={labelId}
        value={family ? 'custom' : 'bundled'}
        onChange={choose}
        options={[
          { value: 'bundled', label: 'Geist Mono' },
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
            <Popover label={t('CodeFontPicker.chooseCodeFont')} onClose={close}>
              <FontList
                current={family}
                listing={listing}
                onPick={(picked) => {
                  setPreference('codeFontFamily', picked)
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
