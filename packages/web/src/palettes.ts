import { localized, t } from './i18n'
// The palettes the interface comes in. Each is a block of tokens in styles.css under
// [data-palette]; this is the list the settings offer and the preference is checked against.
export const PALETTES = ['studio', 'ember'] as const
export type Palette = (typeof PALETTES)[number]

// Each palette's name, and where its colours come from, for the settings.
export const PALETTE_LABEL: Record<Palette, { name: string; origin: string }> = localized(() => ({
  studio: { name: t('palettes.studio'), origin: t('palettes.studioOrigin') },
  ember: { name: t('palettes.ember'), origin: t('palettes.emberOrigin') }
}))
