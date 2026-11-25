import { expect, test } from 'bun:test'

import { noopPermissionService } from '@/permissions/permissions'

import { createWatchTool } from './tool'

test('advertises object parameters without weakening per-action validation', async () => {
  const tool = createWatchTool('.', () => undefined, noopPermissionService)
  const schema = JSON.parse(JSON.stringify(tool.parameters))
  expect(schema.type).toBe('object')
  expect(schema.required).toEqual(['action'])
  expect(schema).not.toHaveProperty('anyOf')
  expect(schema).not.toHaveProperty('oneOf')
  await expect(tool.execute('call', { action: 'cancel' }, undefined, undefined, {} as never)).rejects.toThrow('id')
})
