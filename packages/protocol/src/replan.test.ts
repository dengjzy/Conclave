import { describe, expect, it } from 'vitest'
import { parseReplan } from './replan'

describe('parseReplan', () => {
  const plan = { diagnosis: 'the test assumes a route that does not exist', instruction: 'add the route before the handler', steps: [] }

  it('reads a fenced answer', () => {
    expect(parseReplan(`\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)).toEqual(plan)
  })

  it('reads the last object in prose', () => {
    expect(parseReplan(`example ${JSON.stringify({ diagnosis: 'no', instruction: 'no' })}\nanswer ${JSON.stringify(plan)}`)).toEqual(plan)
  })

  it('rejects prose and an empty instruction', () => {
    expect(parseReplan('try again')).toBeNull()
    expect(parseReplan('{"diagnosis":"x","instruction":""}')).toBeNull()
  })
})
