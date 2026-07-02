import { describe, expect, test } from 'bun:test'

import { loadTask, loadTaskSuite } from './task'

const FIXTURES = `${import.meta.dir}/fixtures`

describe('loadTask', () => {
  test('reads instruction and metadata from a task dir', async () => {
    const task = await loadTask(`${FIXTURES}/example-task`)

    expect(task.id).toBe('example-task')
    expect(task.instruction).toContain('output.txt')
    expect(task.verifyCommand).toEqual(['bash', 'verify.sh'])
    expect(task.timeoutMs).toBe(30000)
  })

  test('throws when the instruction file is missing', async () => {
    await expect(loadTask(`${FIXTURES}/does-not-exist`)).rejects.toThrow()
  })
})

describe('loadTaskSuite', () => {
  test('loads every task directory under the suite, sorted', async () => {
    const tasks = await loadTaskSuite(FIXTURES)

    expect(tasks.map((t) => t.id)).toEqual(['example-task'])
  })
})
