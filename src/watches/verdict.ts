import { createTwoFilesPatch } from 'diff'
import { z } from 'zod'

import { parseDuration } from '@/inspect/types'

import type { WatchRecord } from './store'
import type { WatchVerdict } from './types'

const jsonVerdict = z.object({
  verdict: z.enum(['quiet', 'wake', 'done']),
  wake: z.boolean().optional(),
  summary: z.string().optional(),
  next: z.string().optional(),
})
export type ProbeResult = WatchVerdict & { state?: WatchRecord['state'] }
export function duration(text: string): number {
  const parsed = parseDuration(text)
  if (!parsed.ok) throw new Error(parsed.reason)
  if (!Number.isSafeInteger(parsed.ms)) throw new Error('Duration too large')
  return parsed.ms
}
export function parseProbeOutput(
  code: number,
  stdout: string,
  stderr: string,
  mode: WatchRecord['mode'],
  previous: unknown,
): ProbeResult {
  if (!(mode === 'diff' ? code === 0 : [0, 10, 20, 30].includes(code)))
    throw new Error(`Probe exited ${code}: ${stderr.trim() || stdout.trim()}`)
  if (mode === 'diff') {
    if (typeof previous !== 'string' || previous === stdout) return { verdict: 'quiet', state: stdout }
    return { verdict: 'wake', summary: createTwoFilesPatch('previous', 'current', previous, stdout), state: stdout }
  }
  const summary = stdout.trim()
  const last = summary.split('\n').at(-1)
  if (last?.trimStart().startsWith('{')) {
    let value: unknown
    try {
      value = JSON.parse(last)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
    if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'verdict')) {
      const { next, ...result } = jsonVerdict.parse(value)
      return { ...result, ...(next === undefined ? {} : { nextMs: duration(next) }) }
    }
  }
  return {
    verdict: code === 0 ? 'quiet' : code === 10 ? 'wake' : 'done',
    summary,
    ...(code >= 20 ? { wake: code === 30 } : {}),
  }
}
