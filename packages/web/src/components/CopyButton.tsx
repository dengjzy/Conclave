import { t } from '../i18n'
import { useEffect, useState, type ReactNode } from 'react'
import { CheckIcon, CopyIcon } from './icons'

// Copies its text, and says it did with a check for a moment. With children it shows them before
// the icon, for a value that is itself what to click.
export function CopyButton({ text, label = t('CopyButton.copy'), children }: { text: string; label?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={children ? 'copy-button copy-button-text' : 'copy-button'}
      data-copied={copied || undefined}
      aria-label={copied ? t('BranchStatus.copied') : label}
      title={copied ? t('BranchStatus.copied') : label}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}
    >
      {children}
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}
