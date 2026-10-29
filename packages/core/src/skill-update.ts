import type { SkillChange, SkillEntry } from '@conclave/protocol'

// Include scripts and references: a skill can change without its description changing.
export function skillUpdateChanges(before: readonly SkillEntry[], after: readonly SkillEntry[], files: readonly string[]): SkillChange[] {
  const changes: SkillChange[] = []
  for (const skill of after) {
    const previous = before.find((entry) => entry.name === skill.name)
    if (!previous) changes.push({ name: skill.name, kind: 'added' })
    else if (previous.dir !== skill.dir || previous.description !== skill.description || previous.problem !== skill.problem || files.some((file) => skill.dir === '.' || file.startsWith(`${skill.dir}/`))) changes.push({ name: skill.name, kind: 'changed' })
  }
  for (const skill of before) if (!after.some((entry) => entry.name === skill.name)) changes.push({ name: skill.name, kind: 'removed' })
  return changes.sort((a, b) => a.name.localeCompare(b.name))
}
