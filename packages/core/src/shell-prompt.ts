import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

// What a terminal says about itself, as other terminal apps do: tools that colour their output
// look at COLORTERM and TERM_PROGRAM, and macOS's ls colours only with CLICOLOR, unless the user
// has said otherwise.
export function terminalEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { COLORTERM: 'truecolor', TERM_PROGRAM: 'Conclave', ...(env.CLICOLOR === undefined ? { CLICOLOR: '1' } : {}) }
}

// zsh reads its startup files from ZDOTDIR. Pointed at these, it still reads the user's own,
// each in turn from where they keep them, and hands ZDOTDIR back once .zshrc is read, so .zlogin
// and any shell started inside are the user's alone. Only a prompt left as it came (macOS's, or
// zsh's own) is replaced, by one in colour with the git branch; a prompt the user set, a theme or
// starship, is left alone. Nothing of the user's is written.
const USER = '${CONCLAVE_USER_ZDOTDIR:-$HOME}'
const ZSH_FILES: Record<string, string> = {
  '.zshenv': `# Conclave: the user's own .zshenv, read as zsh would have.
_conclave_zdotdir=$ZDOTDIR
ZDOTDIR=${USER}
[[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv
# One that moves ZDOTDIR on purpose keeps it, and the rest is read from there.
[[ $ZDOTDIR == "${USER}" ]] && ZDOTDIR=$_conclave_zdotdir
unset _conclave_zdotdir
`,
  '.zprofile': `# Conclave: the user's own .zprofile.
_conclave_zdotdir=$ZDOTDIR
ZDOTDIR=${USER}
[[ -f $ZDOTDIR/.zprofile ]] && source $ZDOTDIR/.zprofile
ZDOTDIR=$_conclave_zdotdir
unset _conclave_zdotdir
`,
  '.zshrc': `# Conclave: the user's own .zshrc, then a prompt in colour where theirs is still the default.
ZDOTDIR=${USER}
[[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
if [[ -n $CONCLAVE_USER_ZDOTDIR ]]; then ZDOTDIR=$CONCLAVE_USER_ZDOTDIR; else unset ZDOTDIR; fi
unset CONCLAVE_USER_ZDOTDIR
if [[ $PROMPT == '%n@%m %1~ %# ' || $PROMPT == '%m%# ' ]]; then
  autoload -Uz vcs_info add-zsh-hook
  zstyle ':vcs_info:*' enable git
  zstyle ':vcs_info:git:*' formats ' %b'
  zstyle ':vcs_info:git:*' actionformats ' %b|%a'
  _conclave_vcs_info() { vcs_info }
  add-zsh-hook precmd _conclave_vcs_info
  setopt prompt_subst
  PROMPT='%F{cyan}%1~%f%F{magenta}\${vcs_info_msg_0_}%f %(?.%F{green}.%F{red})%#%f '
fi
`
}

// Where the files go, under Conclave's home, and the environment a shell is started with to read them.
// null where the shell is not zsh: other shells keep their own prompt.
export class ShellPrompt {
  private written: Promise<void> | null = null

  constructor(private readonly root: string) {}

  async env(shell: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string> | null> {
    if (path.basename(shell) !== 'zsh') return null
    this.written ??= this.write().catch((error: unknown) => {
      this.written = null
      throw error
    })
    await this.written
    return { ZDOTDIR: this.zsh(), ...(env.ZDOTDIR ? { CONCLAVE_USER_ZDOTDIR: env.ZDOTDIR } : {}) }
  }

  private zsh(): string {
    return path.join(this.root, 'zsh')
  }

  // Rewritten only where they differ, so a shell starting meanwhile never reads half a file.
  private async write(): Promise<void> {
    await mkdir(this.zsh(), { recursive: true, mode: 0o700 })
    for (const [name, text] of Object.entries(ZSH_FILES)) {
      const file = path.join(this.zsh(), name)
      if ((await readFile(file, 'utf8').catch(() => null)) === text) continue
      const temporary = `${file}.${process.pid}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      await rename(temporary, file)
    }
  }
}
