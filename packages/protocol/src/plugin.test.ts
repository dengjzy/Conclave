import { expect, it } from 'vitest'
import { pluginSchemas } from './plugin'

const detail = { key: 'DEMO-1', title: 'Example', url: 'https://example.com/1', status: 'Open', statusCategory: 'todo', type: 'Issue', priority: null, updatedAt: null, markdown: '# Example' }

it('accepts existing text plugins and validates optional image encoding and limits', () => {
  const schema = pluginSchemas.fetch.result
  expect(schema.safeParse(detail).success).toBe(true)
  expect(schema.safeParse({ ...detail, images: [{ name: 'shot.png', base64: 'AQI=' }] }).success).toBe(true)
  for (const base64 of ['AQI', 'AQI?', '=AAA', 'AA=A', 'A===']) {
    expect(schema.safeParse({ ...detail, images: [{ name: 'bad.png', base64 }] }).success).toBe(false)
  }
  expect(schema.safeParse({ ...detail, images: Array.from({ length: 21 }, () => ({ name: '', base64: '' })) }).success).toBe(false)
  const base64 = Buffer.alloc(10 * 1024 * 1024).toString('base64')
  expect(schema.safeParse({ ...detail, images: [{ name: 'limit.png', base64 }] }).success).toBe(true)
  expect(schema.safeParse({ ...detail, images: [{ name: 'too-big.png', base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64') }] }).success).toBe(false)
  expect(schema.safeParse({ ...detail, images: Array.from({ length: 6 }, () => ({ name: '', base64 })) }).success).toBe(false)
})
