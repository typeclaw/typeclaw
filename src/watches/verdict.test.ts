import { expect, test } from 'bun:test'

import { parseProbeOutput } from './verdict'
test('judge accepts exit and last-line JSON forms, but non-contract exits remain failures', () => {
  const parse = (code: number, text: string) => parseProbeOutput(code, text, 'bad input', 'judge', undefined)
  for (const [code, verdict] of [
    [0, 'quiet'],
    [10, 'wake'],
    [20, 'done'],
    [30, 'done'],
  ] as const)
    expect(parse(code, '결과')).toMatchObject({ verdict, summary: '결과' })
  expect(parse(20, 'closed').wake).toBe(false)
  expect(parse(30, 'closed').wake).toBe(true)
  expect(parse(0, 'progress\n{"verdict":"wake","next":"5m","summary":"action"}\n')).toEqual({
    verdict: 'wake',
    nextMs: 300_000,
    summary: 'action',
  })
  expect(() => parse(1, '{"verdict":"quiet"}')).toThrow('bad input')
  const status = 'Checking\n{"status":"review required"}'
  expect(parse(10, status)).toEqual({ verdict: 'wake', summary: status })
  expect(() => parse(10, '{"verdict":"pending"}')).toThrow('verdict')
})
test('diff establishes a quiet baseline and ignores JSON verdicts on later changes', () => {
  const before = '{"verdict":"done"}\n',
    after = 'new\n'
  expect(parseProbeOutput(0, before, '', 'diff', undefined)).toMatchObject({ verdict: 'quiet', state: before })
  expect(parseProbeOutput(0, before, '', 'diff', before).verdict).toBe('quiet')
  expect(parseProbeOutput(0, after, '', 'diff', before).summary).toContain(`-${before}+${after}`)
})
