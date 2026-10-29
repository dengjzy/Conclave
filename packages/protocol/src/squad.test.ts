import { describe, expect, it } from 'vitest'
import { SquadFields, checkSquadStart, squadModes } from './squad'
import { Task } from './task'
import { checkScheduleTask } from './schedule'
import { rpcSchemas } from './rpc'

const id = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const fields = () => ({ name: 'Delivery', leaderId: id(1), members: [
  { id: id(1), name: 'Lead', agent: 'claude' as const, capability: 'readOnly' as const },
  { id: id(2), name: 'Build', agent: 'codex' as const, capability: 'develop' as const },
  { id: id(3), name: 'Review', agent: 'cursor' as const, capability: 'readOnly' as const }
] })
describe('squad contracts', () => {
  it('supports repeated agent kinds with distinct roles and rejects invalid rosters', () => {
    const squad = fields()
    expect(SquadFields.parse(squad).members[0]?.role).toBe('')
    expect(SquadFields.safeParse({ ...squad, leaderId: id(9) }).success).toBe(false)
    expect(SquadFields.safeParse({ ...squad, leaderId: id(2) }).success).toBe(false)
    expect(SquadFields.safeParse({ ...squad, members: squad.members.map((member) => ({ ...member, capability: 'readOnly' })) }).success).toBe(false)
    expect(SquadFields.safeParse({ ...squad, members: [squad.members[0], squad.members[0], squad.members[1]] }).success).toBe(false)
    expect(SquadFields.safeParse({ ...squad, members: [squad.members[0], { ...squad.members[1], name: 'lead' }] }).success).toBe(false)
  })
  it('offers the intersection of development modes without promoting permissions', () => {
    const squad = SquadFields.parse(fields())
    expect(squadModes(squad)).toEqual(['ask', 'acceptEdits'])
    expect(squadModes(squad, true)).toContain('bypass')
    const mixed = { ...squad, members: [...squad.members, { ...squad.members[1]!, id: id(4), agent: 'cursor' as const }] }
    expect(squadModes(mixed, true)).toEqual(['ask'])
  })
  it('blocks unfinished dependencies, running reassignment and scheduled squad execution', () => {
    const task = Task.parse({ id: 't', title: 'Task', details: '', status: 'pending', repos: [{ path: '/p', branch: null, worktreePath: null }], dependsOn: [], agent: 'claude', squadId: id(5), createdAt: 0, updatedAt: 0 })
    expect(checkSquadStart(task, [{ status: 'review' }])).toBe('dependencies-unfinished')
    expect(checkSquadStart({ ...task, status: 'running' }, [])).toBe('not-pending')
    expect(checkSquadStart({ ...task, status: 'running' }, [], true)).toBeNull()
    expect(checkScheduleTask(task, [])).toBe('squad-schedule-unsupported')
    expect(rpcSchemas['squads.start'].params.parse({ id: 't', squadId: id(5) }).permissionMode).toBe('ask')
  })
})
