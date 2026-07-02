import { describe, expect, test } from 'bun:test'

import { runVerifier } from './verify'

describe('runVerifier', () => {
  test('passes when the command exits 0', async () => {
    const result = await runVerifier(['bash', '-c', 'exit 0'], process.cwd(), 5000)

    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  test('fails when the command exits non-zero', async () => {
    const result = await runVerifier(['bash', '-c', 'echo boom >&2; exit 3'], process.cwd(), 5000)

    expect(result.passed).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('boom')
  })

  test('fails on an empty command', async () => {
    const result = await runVerifier([], process.cwd(), 5000)

    expect(result.passed).toBe(false)
  })
})
