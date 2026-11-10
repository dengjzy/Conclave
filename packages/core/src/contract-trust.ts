import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import type { CheckSpec } from '@conclave/protocol'

// A contract's checks run commands the agent can edit: a script in the worktree, or a package.json
// script. The user's save records what those files were, so a check that finds different content
// refuses to run instead of reporting a pass the agent arranged.
export type CheckRoot = {
  // Where the check runs: the task worktree once there is one.
  root: string
  // The repo the user picked. `.conclave/project.json` is read from here, as project config is.
  repo: string
}

const PROJECT_CONFIG = '.conclave/project.json'
const BASE_FILES = [PROJECT_CONFIG, 'package.json']
const SHELL_META = '*?[]{}<>|&;$`'
const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.py', '.rb', '.pl', '.php'])

type Entry = { repo: string; path: string; content: Buffer | null }

function read(file: string): Buffer | null {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

// A command's words, with a quoted path kept whole. This is not a shell parser: only words that
// name an existing file inside the repo count, so operators and options fall away on their own.
function commandWords(command: string): string[] {
  const words: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|([^\s"']+)/g
  for (const match of command.matchAll(pattern)) words.push(match[1] ?? match[2] ?? match[3] ?? '')
  return words
}

function scriptPaths(root: string, command: string): string[] {
  const found: string[] = []
  for (const word of commandWords(command)) {
    if (!word || word.startsWith('-') || path.isAbsolute(word)) continue
    if ([...word].some((char) => SHELL_META.includes(char))) continue
    const resolved = path.resolve(root, word)
    const relative = path.relative(root, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue
    const info = statSync(resolved, { throwIfNoEntry: false })
    if (!info?.isFile()) continue
    // A command also names artifacts (`test -f RESULT.md`); only code it runs is trusted.
    if (!SCRIPT_EXTENSIONS.has(path.extname(resolved).toLowerCase()) && (info.mode & 0o111) === 0) continue
    found.push(relative.split(path.sep).join('/'))
  }
  return found
}

function entries(checks: readonly CheckSpec[], rootOf: (repo: string) => CheckRoot): Entry[] {
  const repos = [...new Set(checks.map((check) => check.repo))].sort()
  const out: Entry[] = []
  for (const repo of repos) {
    const { root, repo: repoPath } = rootOf(repo)
    const files = new Set(BASE_FILES)
    for (const check of checks) {
      if (check.repo !== repo) continue
      for (const script of scriptPaths(root, check.command)) files.add(script)
    }
    for (const relative of [...files].sort()) {
      // The config is not copied into a worktree; comparing the repo's copy keeps the hash stable
      // while still noticing a changed config wherever the worktree has its own.
      const file = path.join(root, relative)
      const content = read(file) ?? (relative === PROJECT_CONFIG && root !== repoPath ? read(path.join(repoPath, relative)) : null)
      out.push({ repo, path: relative, content })
    }
  }
  return out
}

// What the user trusts when saving a contract: the checks as written and the files they can run.
// Missing files are part of the hash too, so deleting a script is a change, not a smaller plan.
export function checkTrust(checks: readonly CheckSpec[], rootOf: (repo: string) => CheckRoot): { hash: string; files: string[] } {
  const all = entries(checks, rootOf)
  const hash = createHash('sha256')
  hash.update('conclave-check-trust-v1\n')
  hash.update(JSON.stringify(checks))
  hash.update('\n')
  for (const entry of all) {
    hash.update(`${entry.repo}\n${entry.path}\n`)
    hash.update(entry.content === null ? 'missing\n' : `file:${entry.content.length}\n`)
    if (entry.content !== null) hash.update(entry.content)
    hash.update('\n')
  }
  return {
    hash: hash.digest('hex'),
    files: [...new Set(all.filter((entry) => entry.content !== null).map((entry) => entry.path))]
  }
}
