import { appendFile, lstat, mkdir, readdir, rename, rmdir, stat, symlink } from 'node:fs/promises'
import path from 'node:path'

// An account's config folder shares with the user's own folder whatever is not tied to the sign-in,
// each entry a link to the one there: a session opened on one account is the same file on every
// other, so a switch resumes it rather than starting over.

export type SharedEntry = {
  name: string
  // Made in the user's folder when it has none yet, so the agent writes there rather than into the
  // account's: what history must be shared to resume across accounts. Without it, an entry the user's
  // folder lacks is left out.
  create?: 'dir' | 'file'
}

// follow: what a link leads to, as in the user's folder, where an entry may be a link of their own.
async function kind(file: string, follow = false): Promise<'link' | 'dir' | 'file' | null> {
  try {
    const found = await (follow ? stat : lstat)(file)
    return found.isSymbolicLink() ? 'link' : found.isDirectory() ? 'dir' : 'file'
  } catch {
    return null
  }
}

// What the agent wrote into the account's own copy before it was a link moves to the user's folder,
// each entry the user's folder lacks; the copy goes once it is empty, and stays (unlinked) otherwise.
async function absorb(dir: string, into: string): Promise<boolean> {
  for (const name of await readdir(dir)) {
    const target = path.join(into, name)
    if ((await kind(target)) === null) await rename(path.join(dir, name), target)
  }
  return rmdir(dir).then(() => true, () => false)
}

export async function linkShared(home: string, own: string, entries: readonly SharedEntry[]): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    const source = path.join(own, entry.name)
    const link = path.join(home, entry.name)
    let found = await kind(source, true)
    if (found === null && entry.create) {
      if (entry.create === 'dir') await mkdir(source, { recursive: true, mode: 0o700 })
      else await appendFile(source, '', { mode: 0o600 })
      found = entry.create
    }
    if (found === null) continue
    const present = await kind(link)
    // A link is already there, or a file of the account's own that the agent wrote: left as it is.
    if (present === 'link' || present === 'file') continue
    if (present === 'dir' && (found !== 'dir' || !(await absorb(link, source)))) continue
    // A junction needs no privilege on Windows, where a file link may be refused: that entry then
    // stays the account's own.
    await symlink(source, link, found === 'dir' ? 'junction' : 'file').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error
    })
  }
}
