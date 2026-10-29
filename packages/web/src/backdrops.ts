// Experimental: a gradient the window's frame is drawn on, behind the sidebar and status bar, with
// the panes floating over it. Taken from Slack's themes; each is a [data-backdrop] block in
// styles.css. It sits beside the palette rather than replacing it.
export const BACKDROPS = ['aubergine', 'lagoon', 'mood-indigo', 'sea-glass', 'kind-of-blue', 'funky-fresh', 'sunglasses-inside'] as const
export type Backdrop = (typeof BACKDROPS)[number]

export const BACKDROP_LABEL: Record<Backdrop, string> = {
  aubergine: 'Aubergine',
  lagoon: 'Lagoon',
  'mood-indigo': 'Mood Indigo',
  'sea-glass': 'Sea Glass',
  'kind-of-blue': 'Kind of Blue',
  'funky-fresh': 'Funky Fresh',
  'sunglasses-inside': 'Sunglasses Inside'
}
