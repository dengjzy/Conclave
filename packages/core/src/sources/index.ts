import { DEFAULT_INSTANCE } from '@conclave/protocol'
import type { CredentialStore } from '../credential-store'
import type { SourceConfigStore } from '../source-config'
import type { SourceProvider } from '../source-provider'
import { createGithubSource } from './github-source'
import { createGitlabSource } from './gitlab-source'
import { createJiraSource } from './jira-source'

export { createGithubSource } from './github-source'
export { createGitlabSource } from './gitlab-source'
export { createJiraSource } from './jira-source'

export type BuiltinSourceContext = {
  config?: SourceConfigStore
  credentials?: CredentialStore
}

export function builtinSourceProviders(context: BuiltinSourceContext = {}): SourceProvider[] {
  return [
    createGithubSource({
      configuredHost: () => context.config?.get('github', DEFAULT_INSTANCE)?.settings.host,
      hasStoredCredential: () => Boolean(context.credentials?.get('github', DEFAULT_INSTANCE))
    }),
    createGitlabSource({
      configuredHost: () => context.config?.get('gitlab', DEFAULT_INSTANCE)?.settings.host,
      hasStoredCredential: () => Boolean(context.credentials?.get('gitlab', DEFAULT_INSTANCE))
    }),
    createJiraSource()
  ]
}
