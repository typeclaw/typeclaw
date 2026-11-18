import type { ChannelRouter } from '@/channels/router'
import type { LastWordsNoticeTarget } from '@/config/config'

import {
  previousUnnoticedDeath,
  readLastWords,
  recordNotice,
  withLastWordsLock,
  writeLastWords,
  type LastWords,
  type LastWordsEntry,
  type LastWordsNotice,
  type LastWordsRun,
} from './file'

export type SendLastWordsNoticeOptions = {
  agentDir: string
  run: LastWordsRun
  // Read after the current run is on disk, right before delivery, so a live
  // reload that changes or clears the target in the meantime is honored.
  target: () => LastWordsNoticeTarget | undefined
  router: Pick<ChannelRouter, 'send' | 'openDm'>
  // The current run's entry must be on disk first: the previous run is found
  // relative to it.
  ready?: Promise<void>
  now?: () => Date
  log?: (line: string) => void
}

// The outcome is stamped on the dead run either way, so a target that keeps
// failing does not retry the same death on every boot.
export async function sendLastWordsNotice(options: SendLastWordsNoticeOptions): Promise<void> {
  const { agentDir, run, router } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((line: string) => console.warn(line))
  try {
    await options.ready
    const target = options.target()
    if (target === undefined) return
    const died = previousUnnoticedDeath(readLastWords(agentDir), run)
    if (died === null) return
    // A reload can revoke or replace the target while the DM is looked up or
    // the text is reviewed, so it is rechecked after each wait; a stale send is
    // cancelled and left unstamped for the next boot.
    const stillTarget = (): boolean => JSON.stringify(options.target()) === JSON.stringify(target)
    const notice = await deliver(router, target, stillTarget, renderLastWordsNotice(died), now).catch(
      (error: unknown): LastWordsNotice => ({
        failedAt: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    if (notice === null) return
    if ('error' in notice) log(`[last-words] notice to ${describeTarget(target)} failed: ${notice.error}`)
    await withLastWordsLock(agentDir, async () =>
      writeLastWords(agentDir, recordNotice(readLastWords(agentDir), died.run, notice)),
    )
  } catch (error) {
    log(`[last-words] notice failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// The notice names kinds of work, never session keys: those can carry private
// repository, PR, or conversation identifiers, and the operator who needs them
// has the full words in the runtime-private file.
export function renderLastWordsNotice(entry: LastWordsEntry): string {
  const lines = [
    `I stopped unexpectedly at ${formatInstant(entry.death?.finishedAt ?? entry.writtenAt)} and have restarted.`,
    `Cause: ${entry.death?.reason ?? `exit code ${entry.death?.exitCode ?? 'unknown'}`}`,
  ]
  const words = entry.words
  if (words !== null) {
    const facts: string[] = []
    const { currentMb, limitMb } = words.memory
    if (currentMb !== null) facts.push(`memory ${currentMb}${limitMb === null ? '' : ` of ${limitMb}`} MB`)
    if (words.turns.length > 0) facts.push(`working on ${describeTurns(words.turns)}`)
    const [largest] = words.children
    if (largest !== undefined) facts.push(`largest helper process: ${largest.kind} ${largest.rssMb} MB`)
    if (facts.length > 0) lines.push(`At the time: ${facts.join('; ')}.`)
  }
  lines.push('Details are in .typeclaw/last-words/last-words.json in the agent folder.')
  return lines.join('\n')
}

// Transport-only: the notice is not a reply, so it must not touch the turn
// accounting of a conversation that happens to be active at the destination.
async function deliver(
  router: SendLastWordsNoticeOptions['router'],
  target: LastWordsNoticeTarget,
  stillTarget: () => boolean,
  text: string,
  now: () => Date,
): Promise<LastWordsNotice | null> {
  const failed = (error: string): LastWordsNotice => ({ failedAt: now().toISOString(), error })
  let destination: { workspace: string; chat: string; thread?: string }
  if ('user' in target) {
    const dm = await router
      .openDm(target.adapter, {
        user: target.user,
        ...(target.workspace !== undefined ? { workspace: target.workspace } : {}),
      })
      .catch((error: unknown) => {
        if (!stillTarget()) return null
        throw error
      })
    if (dm === null || !stillTarget()) return null
    if (!dm.ok) return failed(dm.error)
    destination = { workspace: dm.workspace, chat: dm.chat }
  } else {
    destination = {
      workspace: target.workspace,
      chat: target.chat,
      ...(target.thread !== undefined ? { thread: target.thread } : {}),
    }
  }
  const result = await router.send(
    { adapter: target.adapter, ...destination, text },
    { source: 'system', outputKind: 'meta', transportOnly: true, deliverIf: stillTarget },
  )
  if (!result.ok && result.code === 'cancelled') return null
  return result.ok ? { sentAt: now().toISOString(), target: describeTarget(target) } : failed(result.error)
}

function describeTurns(turns: LastWords['turns']): string {
  const byOrigin = new Map<string, number>()
  for (const turn of turns) byOrigin.set(turn.origin, (byOrigin.get(turn.origin) ?? 0) + 1)
  const counts = [...byOrigin].map(([origin, count]) => `${count} ${origin} turn${count === 1 ? '' : 's'}`)
  const tools = [...new Set(turns.flatMap((turn) => (turn.tool === undefined ? [] : [turn.tool])))]
  return `${counts.join(', ')}${tools.length === 0 ? '' : ` (running ${tools.join(', ')})`}`
}

function describeTarget(target: LastWordsNoticeTarget): string {
  return 'user' in target
    ? `${target.adapter} user ${target.user}`
    : `${target.adapter} ${target.workspace}/${target.chat}${target.thread === undefined ? '' : `/${target.thread}`}`
}

function formatInstant(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`
}
