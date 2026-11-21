import { describe, expect, test } from 'bun:test'

import { CellOutput, CODEMODE_LIMITS, CodemodeError, FrameLines, encodeFrame, kernelFrameSchema } from './protocol'

describe('codemode bridge boundary', () => {
  test('reassembles split UTF-8 JSON lines', () => {
    const reader = new FrameLines()
    const bytes = Buffer.from(encodeFrame({ type: 'output', cellId: 'one', text: '한글' }))
    const first = reader.push(bytes.subarray(0, bytes.length - 3))
    const last = reader.push(bytes.subarray(bytes.length - 3))
    expect(first).toEqual([])
    expect(last).toHaveLength(1)
    expect(last[0]).toContain('한글')
  })

  test('rejects an unterminated frame flood', () => {
    const reader = new FrameLines()
    expect(() => reader.push(Buffer.alloc(CODEMODE_LIMITS.frameBytes + 1, 65))).toThrow(CodemodeError)
  })

  test.each([
    { type: 'unknown' },
    { type: 'tool-call', cellId: 'one', id: 'one', name: 'read', args: [] },
    { type: 'done', cellId: 'one', unexpected: true },
  ])('rejects malformed host-bound messages: %j', (message) => {
    const result = kernelFrameSchema.safeParse(message)
    expect(result.success).toBe(false)
  })

  test('rejects oversized host replies before writing them', () => {
    const frame = { type: 'tool-result', id: 'one', value: 'x'.repeat(CODEMODE_LIMITS.frameBytes) } as const
    expect(() => encodeFrame(frame)).toThrow(CodemodeError)
  })
})

describe('codemode output limits', () => {
  test('retains filtered output below the limit', () => {
    const output = new CellOutput()
    output.append('selected: 42\n')
    expect(output.render()).toBe('selected: 42\n')
    expect(output.truncated).toBe(false)
  })

  test('caps multibyte output without splitting a code point', () => {
    const output = new CellOutput()
    output.append('한'.repeat(CODEMODE_LIMITS.outputBytes))
    expect(output.truncated).toBe(true)
    expect(output.render()).not.toContain('�')
    expect(Buffer.byteLength(output.render())).toBeLessThan(CODEMODE_LIMITS.outputBytes + 100)
  })

  test('caps repeated short lines as well as bytes', () => {
    const output = new CellOutput()
    output.append('x\n'.repeat(CODEMODE_LIMITS.outputLines + 1))
    expect(output.truncated).toBe(true)
    expect(output.render().split('x\n')).toHaveLength(CODEMODE_LIMITS.outputLines + 1)
  })
})
