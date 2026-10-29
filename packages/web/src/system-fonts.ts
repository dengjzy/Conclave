// The Local Font Access API, which Chromium has and the DOM typings do not yet.
declare global {
  interface Window {
    queryLocalFonts?: () => Promise<{ family: string }[]>
  }
}

let families: Promise<string[] | null> | null = null

// The font families installed here, sorted, each once; null where the browser cannot list them.
// Chromium lists them only for a visible page and a user's gesture, so this is asked from a click,
// and a failed ask is not kept, so the next click tries again.
export function systemFontFamilies(): Promise<string[] | null> {
  if (!window.queryLocalFonts) return Promise.resolve(null)
  families ??= window.queryLocalFonts().then(
    (fonts) => [...new Set(fonts.map((font) => font.family))].sort((a, b) => a.localeCompare(b)),
    () => {
      families = null
      return null
    }
  )
  return families
}

// Whether every glyph of the family is as wide as the next, by measuring: what the terminal and
// code may be set in. Nothing marks a family monospaced in what the browser lists.
export function isMonospace(family: string): boolean {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return true
  context.font = `16px ${cssFontFamily(family)}, sans-serif`
  return Math.abs(context.measureText('iiiiii').width - context.measureText('MMMMMM').width) < 0.5
}

// A family name as a CSS font-family value: quoted, so names with spaces or digits read right.
export function cssFontFamily(family: string): string {
  return `"${family.trim().replace(/["\\]/g, '\\$&')}"`
}

// Chinese fonts one of which is on nearly every machine, each drawn apart from the next: a family
// that lacks a glyph comes out in the one named after it, and so differently behind two of these.
const CHINESE_REFERENCES = ['PingFang SC', 'Songti SC', 'Hiragino Sans GB', 'Heiti SC', 'Kaiti SC', 'Microsoft YaHei', 'SimSun', 'SimHei', 'KaiTi', 'Noto Sans CJK SC', 'Noto Serif CJK SC', 'Source Han Sans SC', 'WenQuanYi Micro Hei']
// Simplified forms: a Japanese or traditional font that has the shared characters lacks these.
const CHINESE_PROBE = '汉语字体'

// The families that have simplified Chinese of their own, found by drawing it in each, first behind
// one reference font and then another: drawn alike, the glyphs were the family's. Where two
// references that differ are not to be had, there is no telling, and every family is kept.
export function chineseFamilies(families: readonly string[], draw: (fontFamily: string) => string | null = drawProbe): readonly string[] {
  const references = CHINESE_REFERENCES.filter((reference) => families.includes(reference))
  const drawn = references.map((reference) => draw(cssFontFamily(reference)))
  const second = drawn.findIndex((each, index) => index > 0 && each !== null && drawn[0] !== null && each !== drawn[0])
  if (second === -1) return families
  const [first, other] = [cssFontFamily(references[0] ?? ''), cssFontFamily(references[second] ?? '')]
  return families.filter((family) => {
    const own = cssFontFamily(family)
    const behind = draw(`${own}, ${first}`)
    return behind !== null && behind === draw(`${own}, ${other}`)
  })
}

let probe: CanvasRenderingContext2D | null | undefined

// What the probe looks like drawn in a font: its pixels' coverage, as a string to compare.
function drawProbe(fontFamily: string): string | null {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!probe) return null
  const { canvas } = probe
  canvas.width = 96
  canvas.height = 28
  probe.clearRect(0, 0, canvas.width, canvas.height)
  probe.font = `20px ${fontFamily}`
  probe.fillText(CHINESE_PROBE, 0, 22)
  const { data } = probe.getImageData(0, 0, canvas.width, canvas.height)
  let hash = 0
  for (let index = 3; index < data.length; index += 4) hash = (hash * 31 + (data[index] ?? 0)) | 0
  return String(hash)
}
