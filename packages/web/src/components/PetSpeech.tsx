import type { ReactNode } from 'react'
import { t } from '../i18n'

// Shared by the roaming pet and its stationary setup guide.
export function PetSpeech({ text, open, children, dismiss }: { text: ReactNode; open?: () => void; children?: ReactNode; dismiss(): void }) {
  return <>
    <div className="pet-speech-content">
      {open ? <button type="button" className="pet-bubble-text" onClick={open}>{text}</button> : <p className="pet-speech-text">{text}</p>}
      {children}
    </div>
    <button type="button" className="pet-bubble-dismiss" aria-label={t('Pet.dismiss')} onClick={dismiss}>×</button>
  </>
}
