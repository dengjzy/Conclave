import Markdown, { defaultUrlTransform, type Components } from 'react-markdown'
import { openOverview, setSettingsOpen } from '../core-store'
import { guideFor, guideImage, guideSettingsSection } from '../guide-page'
import { t, useLocale } from '../i18n'
import { remarkPlugins } from '../markdown-syntax'

// The guide is the app's own text: its images are bundled with it, its links go to the web.
const components: Components = {
  img: ({ node: _node, src, alt }) => {
    const url = typeof src === 'string' ? guideImage(src) : undefined
    // Taken at twice their size: shown at half their pixels, they read as the app does.
    return url ? <img src={url} alt={alt ?? ''} onLoad={(event) => { event.currentTarget.style.width = `${event.currentTarget.naturalWidth / 2}px` }} /> : null
  },
  a: ({ node: _node, href, children }) => {
    const section = href ? guideSettingsSection(href) : null
    if (section) return <a href={href} onClick={(event) => { event.preventDefault(); setSettingsOpen(true, section) }}>{children}</a>
    return <a href={href} target="_blank" rel="noreferrer">{children}</a>
  }
}

// Markdown drops a link it does not know the scheme of; the guide's own settings links stay.
function urlTransform(url: string): string {
  return guideSettingsSection(url) ? url : defaultUrlTransform(url)
}

export function GuideView() {
  const locale = useLocale((s) => s.locale)
  const { title, body } = guideFor(locale)
  return (
    <section className="worktrees-page guide-page" aria-label={t('GuideView.guide')}>
      <header className="worktrees-header">
        <div className="worktrees-heading">
          <h2>{title}</h2>
        </div>
        <button type="button" className="button" onClick={openOverview}>{t('GuideView.backToOverview')}</button>
      </header>
      <div className="chat-markdown guide-markdown">
        <Markdown remarkPlugins={remarkPlugins} components={components} urlTransform={urlTransform}>{body}</Markdown>
      </div>
    </section>
  )
}
