import { getLocale, t } from './i18n'
import { AGENT_KINDS, agentDescriptor, isAgentKind, type EnvironmentCheck, type EnvironmentProblem, type EnvironmentTool } from '@conclave/protocol'
import { agentLabel } from './labels'

export function toolLabel(tool: EnvironmentTool): string {
  return isAgentKind(tool) ? agentLabel(tool) : 'Git'
}

// The platform picks the package manager.
export const GIT_INSTALL_HINT = () => window.conclave?.platform === 'darwin' ? 'xcode-select --install' : t('environmentText.installGitWithYourSystemPackageManager')

// Every agent Conclave runs, as a sentence names them: "A、B 或 C".
export function agentNames(): string {
  const labels = AGENT_KINDS.map(agentLabel)
  return labels.length > 1 ? t('environmentText.or', { value1: labels.slice(0, -1).join('、'), value2: labels.at(-1) }) : labels.join('')
}

export function checkStatusText(check: EnvironmentCheck): string {
  if (check.status === 'missing') return t('AgentPicker.notInstalled')
  const outdated = isAgentKind(check.tool) ? agentDescriptor(check.tool, getLocale()).environment.outdated : undefined
  if (check.status === 'unknown') return outdated && check.problem === 'incompatible-version' ? `${outdated.status}（${check.version ?? ''}）` : t('environmentText.foundVersionUnknown')
  return check.version ? t('environmentText.installed', { value1: check.version }) : t('InstalledAgentsSettings.installed')
}

export function signedInText(check: EnvironmentCheck): string | null {
  if (check.signedIn === null) return null
  return check.signedIn ? t('InstalledAgentsSettings.signedIn') : t('InstalledAgentsSettings.notSignedIn')
}

// One line for the sidebar: the first thing to fix.
export function problemText(problem: EnvironmentProblem): string {
  switch (problem.code) {
    case 'git-missing':
      return t('environmentText.gitNotFoundTaskWorktreesCannotBeCreated')
    case 'no-agent':
      return t('environmentText.notFound', { value1: agentNames() })
    case 'no-signed-in-agent':
      return t('environmentText.agentsAreInstalledButNoneAreSignedIn')
    case 'signed-out':
      return t('environmentText.isNotSignedIn', { value1: toolLabel(problem.tool) })
  }
}
