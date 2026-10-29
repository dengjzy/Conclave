import { expect, it } from 'vitest'
import { skillUpdateChanges } from './skill-update'

const skill = (name: string) => ({ name, description: name, dir: `skills/${name}`, problem: null })

it('previews script changes as well as added, removed and invalidated skills', () => {
  expect(skillUpdateChanges([skill('tdd'), skill('review'), skill('notes')], [skill('tdd'), skill('research'), { ...skill('notes'), problem: 'missing description' }], ['skills/tdd/scripts/check.sh'])).toEqual([
    { name: 'notes', kind: 'changed' }, { name: 'research', kind: 'added' }, { name: 'review', kind: 'removed' }, { name: 'tdd', kind: 'changed' }
  ])
})
