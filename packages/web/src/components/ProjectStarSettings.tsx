import { useEffect, useState } from 'react'
import { PROJECT_GITHUB_URL, type ProjectStarResult, type ProjectStarStatus } from '@conclave/protocol'
import { useCore } from '../core-store'
import { t } from '../i18n'
import { SettingsRow } from './SettingsControls'
import { StarIcon } from './icons'

type Problem = Extract<ProjectStarResult, { ok: false }>['problem']
const PROBLEM_KEYS = {
  unavailable: 'ProjectStar.unavailable',
  'permission-denied': 'ProjectStar.permissionDenied',
  'account-changed': 'ProjectStar.accountChanged',
  'request-failed': 'ProjectStar.failed'
} as const

export function ProjectStarSettings() {
  const rpc = useCore((state) => state.rpc)
  const sources = useCore((state) => state.sources)
  const supported = rpc?.features.includes('project-star') ?? false
  const [status, setStatus] = useState<ProjectStarStatus>({ state: 'unavailable' })
  const [checking, setChecking] = useState(supported)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  useEffect(() => {
    if (busy) return
    if (!supported || !rpc) { setStatus({ state: 'unavailable' }); setChecking(false); return }
    let current = true
    let request = 0
    const check = async () => {
      if (document.hidden) return
      const id = ++request
      setChecking(true)
      try {
        const result = await rpc.call('support.starStatus', {})
        if (current && id === request) {
          setStatus(result)
          if (result.state === 'ready' && result.starred) setProblem(null)
        }
      } catch {
        if (current && id === request) setStatus({ state: 'unavailable' })
      } finally {
        if (current && id === request) setChecking(false)
      }
    }
    const refresh = () => { void check() }
    refresh()
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      current = false
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [rpc, supported, sources, busy])

  const star = async () => {
    if (!rpc || status.state !== 'ready' || status.starred || busy || checking) return
    setBusy(true)
    setProblem(null)
    try {
      const result = await rpc.call('support.star', { identity: status.identity })
      if (result.ok) setStatus({ ...status, starred: true })
      else setProblem(result.problem)
    } catch {
      setProblem('request-failed')
    } finally {
      setBusy(false)
    }
  }
  const starred = status.state === 'ready' && status.starred
  return <SettingsRow label={t('ProjectStar.title')} description={problem ? t(PROBLEM_KEYS[problem]) : undefined} control={() => (
    <span className="project-star-actions">
      {starred ? <span className="project-star-thanks" role="status"><StarIcon />{t('ProjectStar.thanks')}</span>
        : checking ? <span className="muted" role="status">{t('ProjectStar.checking')}</span>
        : status.state === 'ready' && <button type="button" className="button" disabled={busy} onClick={() => void star()}><StarIcon />{t(busy ? 'ProjectStar.starring' : 'ProjectStar.star')}</button>}
      {!starred && !checking && (status.state === 'unavailable' || problem) && <a className="button" href={PROJECT_GITHUB_URL} target="_blank" rel="noreferrer">{t('ProjectStar.openGithub')}</a>}
    </span>
  )} />
}
