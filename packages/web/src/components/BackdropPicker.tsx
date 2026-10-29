import { t } from '../i18n'
import { BACKDROPS, BACKDROP_LABEL } from '../backdrops'
import { setPreference, usePreferences, type Preferences } from '../preferences'

// Each gradient as a split swatch, light side and dark side, painted by its own [data-backdrop].
function Swatch({ backdrop }: { backdrop: Preferences['backdrop'] }) {
  return (
    <span className="backdrop-swatch" data-backdrop={backdrop === 'none' ? undefined : backdrop} aria-hidden="true">
      <span className="backdrop-swatch-half" data-scheme="light" />
      <span className="backdrop-swatch-half" data-scheme="dark" />
    </span>
  )
}

export function BackdropPicker({ labelId }: { labelId: string }) {
  const backdrop = usePreferences((s) => s.backdrop)
  const options: Preferences['backdrop'][] = ['none', ...BACKDROPS]
  return (
    <div className="palette-picker backdrop-picker" role="radiogroup" aria-labelledby={labelId}>
      {options.map((each) => {
        const name = each === 'none' ? t('common.off') : BACKDROP_LABEL[each]
        return (
          <button
            key={each}
            type="button"
            role="radio"
            aria-checked={each === backdrop}
            className="palette-option"
            aria-label={each === 'none' ? t('BackdropPicker.disableGradientBackground') : t('BackdropPicker.fromTheSlackThemeOfTheSameName', { name: name })}
            title={each === 'none' ? undefined : t('BackdropPicker.fromSlackSTheme', { name: name })}
            onClick={() => setPreference('backdrop', each)}
          >
            <Swatch backdrop={each} />
            <span className="palette-name">{name}</span>
          </button>
        )
      })}
    </div>
  )
}
