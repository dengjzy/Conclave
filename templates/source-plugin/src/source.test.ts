import { expect, it } from 'vitest'
import { source } from './source.js'

it('fetches the issue listed in the inbox and reports missing issues', async () => {
  const signal = new AbortController().signal
  const credential = { kind: 'none', payload: {} }
  const issues = await source.list({}, credential, signal)
  const first = issues[0]
  if (!first) throw new Error('Missing example issue')
  expect(await source.fetch({}, credential, first.key, signal)).toMatchObject(first)
  await expect(source.fetch({}, credential, 'EX-2', signal)).rejects.toMatchObject({ code: 'not-found' })
})
