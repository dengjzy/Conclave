import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { tidyProjectConfig, type ProjectConfig } from '@conclave/protocol'
import { gitTopLevel } from './workspace'

// What a project's own files at its top level say about it: whether one is there, and its text.
export type ProjectFiles = { has(name: string): boolean; read(name: string): string | null }

// A project.json filled in from those files, and what it was told by, for the form to say so.
export type ProjectConfigSuggestion = { config: ProjectConfig; from: string[] }

const MAX_READ_BYTES = 256 * 1024
// Files that hold the user's local settings and stay out of git: what a new worktree lacks.
const LOCAL_FILES = ['.env', '.env.local', '.env.development.local', '.env.test.local']
// npm's placeholder for a project with no tests.
const NO_TEST = /no test specified/

const json = (text: string | null): unknown => {
  try {
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}
const Scripts = z.object({ scripts: z.record(z.string(), z.unknown()).catch({}) }).catch({ scripts: {} })
const SupersetConfig = z.object({ setup: z.union([z.string(), z.array(z.string())]).nullish() })
const ConductorConfig = z.object({ scripts: z.object({ setup: z.string().nullish() }).nullish() })

type Part = { from: string; setup?: string; check?: string }

// Node: the package manager by its lockfile, and the project's own typecheck and test scripts.
function node(files: ProjectFiles): Part | null {
  if (!files.has('package.json')) return null
  const scripts = Scripts.parse(json(files.read('package.json'))).scripts
  const manager = files.has('pnpm-lock.yaml') ? 'pnpm' : files.has('yarn.lock') ? 'yarn' : files.has('bun.lock') || files.has('bun.lockb') ? 'bun' : 'npm'
  const install = manager === 'npm' ? (files.has('package-lock.json') ? 'npm ci' : 'npm install') : `${manager} install`
  const run = (script: string) => (manager === 'npm' ? (script === 'test' ? 'npm test' : `npm run ${script}`) : manager === 'bun' ? `bun run ${script}` : `${manager} ${script}`)
  const has = (script: string) => typeof scripts[script] === 'string' && !NO_TEST.test(String(scripts[script]))
  const check = ['typecheck', 'test'].filter(has).map(run).join(' && ')
  return { from: manager, setup: install, ...(check ? { check } : {}) }
}

function python(files: ProjectFiles): Part | null {
  if (files.has('uv.lock')) return { from: 'uv', setup: 'uv sync', check: 'uv run pytest' }
  if (files.has('poetry.lock')) return { from: 'Poetry', setup: 'poetry install', check: 'poetry run pytest' }
  if (files.has('requirements.txt')) return { from: 'pip', setup: 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt', check: '.venv/bin/python -m pytest' }
  return null
}

function java(files: ProjectFiles): Part | null {
  if (files.has('pom.xml')) {
    const mvn = files.has('mvnw') ? './mvnw' : 'mvn'
    return { from: 'Maven', setup: `${mvn} -q -DskipTests dependency:go-offline`, check: `${mvn} -q test` }
  }
  if (files.has('build.gradle') || files.has('build.gradle.kts')) {
    const gradle = files.has('gradlew') ? './gradlew' : 'gradle'
    return { from: 'Gradle', check: `${gradle} test` }
  }
  return null
}

const RULES: readonly ((files: ProjectFiles) => Part | null)[] = [
  node,
  (files) => (files.has('go.mod') ? { from: 'Go', setup: 'go mod download', check: 'go vet ./... && go test ./...' } : null),
  (files) => (files.has('Cargo.toml') ? { from: 'Cargo', setup: 'cargo fetch', check: 'cargo test' } : null),
  python,
  java,
  (files) => (files.has('Gemfile') ? { from: 'Bundler', setup: 'bundle install', check: files.has('spec') ? 'bundle exec rspec' : 'bundle exec rake test' } : null),
  (files) => (files.has('composer.json') ? { from: 'Composer', setup: 'composer install', ...(files.has('phpunit.xml') || files.has('phpunit.xml.dist') ? { check: 'vendor/bin/phpunit' } : {}) } : null)
]

// A setup the user already wrote for another worktree tool, which says more than any guess.
function imported(files: ProjectFiles): Part | null {
  const superset = SupersetConfig.safeParse(json(files.read('.superset/config.json')))
  const setup = superset.success ? superset.data.setup : null
  const lines = (Array.isArray(setup) ? setup : setup ? [setup] : []).map((line) => line.trim()).filter(Boolean)
  if (lines.length > 0) return { from: 'Superset', setup: lines.join('\n') }
  const conductor = ConductorConfig.safeParse(json(files.read('conductor.json')))
  const script = conductor.success ? conductor.data.scripts?.setup?.trim() : null
  return script ? { from: 'Conductor', setup: script } : null
}

// What to fill the form with: the local files a worktree would lack, a setup imported from another
// tool or else one per kind of project found, and each kind's checks; several kinds run one after
// another.
export function suggestProjectConfig(files: ProjectFiles): ProjectConfigSuggestion {
  const parts = RULES.flatMap((rule) => rule(files) ?? [])
  const fromTool = imported(files)
  const join = (commands: (string | undefined)[]) => commands.filter(Boolean).join(' && ')
  const config = tidyProjectConfig({
    copy: LOCAL_FILES.filter((name) => files.has(name)),
    setup: fromTool?.setup ?? join(parts.map((part) => part.setup)),
    check: join(parts.map((part) => part.check))
  })
  return { config, from: [...(fromTool ? [fromTool.from] : []), ...parts.map((part) => part.from)] }
}

// The suggestion for a project as its checkout stands; nothing for a folder outside git.
export async function suggestForProject(repoPath: string): Promise<ProjectConfigSuggestion> {
  const topLevel = await gitTopLevel(repoPath)
  if (!topLevel) return { config: {}, from: [] }
  const names = [
    'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'go.mod', 'Cargo.toml', 'uv.lock',
    'poetry.lock', 'requirements.txt', 'pom.xml', 'mvnw', 'build.gradle', 'build.gradle.kts', 'gradlew', 'Gemfile', 'spec',
    'composer.json', 'phpunit.xml', 'phpunit.xml.dist', '.superset/config.json', 'conductor.json', ...LOCAL_FILES
  ]
  const found = new Map<string, number>()
  await Promise.all(names.map(async (name) => {
    const info = await stat(path.join(topLevel, name)).catch(() => null)
    if (info) found.set(name, info.isFile() ? info.size : -1)
  }))
  const texts = new Map<string, string | null>()
  for (const name of ['package.json', '.superset/config.json', 'conductor.json']) {
    const size = found.get(name)
    if (size !== undefined && size >= 0 && size <= MAX_READ_BYTES) texts.set(name, await readFile(path.join(topLevel, name), 'utf8').catch(() => null))
  }
  return suggestProjectConfig({ has: (name) => found.has(name), read: (name) => texts.get(name) ?? null })
}
