import { localized, t } from './i18n'
// The palettes the interface comes in. Each is a block of tokens in styles.css under
// [data-palette]; this is the list the settings offer and the preference is checked against.
export const PALETTES = ['terracotta', 'indigo', 'nord', 'paper', 'catppuccin'] as const
export type Palette = (typeof PALETTES)[number]

// Each palette's name, and where its colours come from, for the settings.
export const PALETTE_LABEL: Record<Palette, { name: string; origin: string }> = localized(() => ({
  terracotta: { name: t('palettes.terracotta'), origin: t('palettes.conclaveDefaultNeutralGraysWithTerracotta') },
  indigo: { name: t('palettes.indigo'), origin: t('palettes.fromLinearCoolGraysWithIndigo') },
  nord: { name: t('palettes.nord'), origin: t('palettes.fromNordPolarBlueGraysAndFrost') },
  paper: { name: t('palettes.paper'), origin: t('palettes.warmPaperInspiredByNotionAndReadersWith') },
  catppuccin: { name: t('palettes.catppuccin'), origin: t('palettes.fromCatppuccinLatteAndMochaWithLavender') }
}))
