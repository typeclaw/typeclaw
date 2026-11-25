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
export type ProbeResult = WatchVerdict & { state?: WatchRecord['state']; eventKey?: string }
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
  digest?: string,
): ProbeResult {
  if (!(mode === 'diff' ? code === 0 : [0, 10, 20, 30].includes(code)))
    throw new Error(`Probe exited ${code}: ${stderr.trim() || stdout.trim()}`)
  if (mode === 'diff') {
    if (!digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Missing full stdout digest')
    const state = { digest, tail: stdout }
    const prior = z.object({ digest: z.string(), tail: z.string() }).safeParse(previous)
    // Older baselines have only the tail. Preserve visible diffs on upgrade
    // and establish the full-stream digest on the first post-upgrade tick.
    const before = prior.success ? prior.data.tail : typeof previous === 'string' ? previous : undefined
    if (before === undefined || (prior.success ? prior.data.digest === digest : before === stdout))
      return { verdict: 'quiet', state }
    const summary =
      before === stdout
        ? `Stdout changed outside the retained tail (SHA-256 ${digest}).`
        : createTwoFilesPatch('previous', 'current', before, stdout)
    return { verdict: 'wake', state, summary }
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
