import type { ChannelRouter } from '@/channels/router'

import type { WatchWake, WatchWakeTarget } from './types'

export async function deliverChannelWakes(
  router: Pick<ChannelRouter, 'route' | 'getRecoveryAccountIdentity'>,
  target: Extract<WatchWakeTarget, { kind: 'channel' }>,
  wakes: readonly (WatchWake & { key: string })[],
) {
  const accountIdentity = await router.getRecoveryAccountIdentity(target.key.adapter, target.key.workspace)
  if (!accountIdentity) {
    console.warn(`[watch] ${target.key.adapter}: channel account is not ready; retrying delivery`)
    return 'failed' as const
  }
  let queued = false
  const deniedKeys: string[] = []
  for (const wake of wakes) {
    // Deduplicate individual verdicts, not the batch: another result can
    // join the pending slot between a crash and its replay.
    const receipt = await router.route({
      ...target.key,
      accountIdentity,
      room: target.room,
      isDm: target.isDm ?? false,
      authorId: target.requester.authorId,
      authorAdapter: target.requester.authorAdapter,
      authorName: target.requester.authorName ?? target.requester.authorId,
      watch: true,
      watchResult: wake,
      eventKind: 'watch',
      externalMessageId: `watch:${wake.watchId}:${wake.key}`,
      text: wake.summary,
      ts: Date.now(),
      authorIsBot: false,
      isBotMention: true,
      suppressSticky: true,
      replyToBotMessageId: null,
      replyToOtherMessageId: null,
      mentionsOthers: false,
    })
    if (receipt.kind === 'denied') {
      console.info(`[watch] ${wake.watchId}: channel wake denied; not posted`)
      deniedKeys.push(wake.key)
      continue
    }
    if (receipt.kind !== 'accepted' && receipt.kind !== 'duplicate')
      throw new Error(`Watch inbound was not admitted: ${receipt.kind}`)
    if (receipt.kind === 'accepted' || (!receipt.outcome && !receipt.watchStarted)) queued = true
  }
  if (queued) return 'queued' as const
  return deniedKeys.length ? { deniedKeys } : ('delivered' as const)
}
