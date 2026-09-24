import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import type { ChannelRouter } from '@/channels/router'
import type { AdapterId } from '@/channels/schema'
import type { ReactionRef } from '@/channels/types'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { TOOL_RESULT_PREFIX } from './channel-reply'

export type ChannelReactOrigin = {
  adapter: AdapterId
  workspace: string
  chat: string
  thread: string | null
}

export type CreateChannelReactToolOptions = {
  router: ChannelRouter
  origin: ChannelReactOrigin
  // Resolved at execute time, not captured: the target is the message that
  // triggered THIS turn. The tool is built once at session creation, whose
  // origin snapshot carries no reactionRef, so a static capture would deny
  // every call.
  getReactionRef: () => ReactionRef | undefined
  logger?: ChannelToolLogger
}

export function createChannelReactTool({
  router,
  origin,
  getReactionRef,
  logger = consoleChannelLogger,
}: CreateChannelReactToolOptions) {
  return defineTool({
    name: 'channel_react',
    label: 'Channel React',
    description:
      'React to the message that triggered this turn with an emoji that fits its content or tone — a lightweight, ' +
      'human touch that posts no comment. Works on GitHub (issue/PR/comment), Slack, and Discord. ' +
      'Pick the reaction a thoughtful teammate would leave: :+1: to agree or approve, :rocket: for something ' +
      'shipping or exciting, :tada: to celebrate, :heart: to show appreciation, :eyes: to signal "I am looking at this", ' +
      ':laugh: for something funny. Use it when a reaction adds genuine social signal — not on every message. ' +
      'The reaction is only applied if you ALSO reply to this message in the same turn (via `channel_reply`/' +
      '`channel_send`); if you stay silent or `skip_response`, the reaction is dropped. So do not use a reaction ' +
      'as a standalone response to a message you are only observing — react to the messages you actually answer. ' +
      'Pass the bare emoji name, no colons.',
    parameters: Type.Object({
      emoji: Type.String({
        description:
          'Bare emoji name, no surrounding colons. Choose one that matches the message: ' +
          'e.g. "+1", "rocket", "tada", "heart", "eyes", "laugh".',
        minLength: 1,
      }),
    }),

    async execute(_toolCallId, params) {
      const deny = (error: string) => {
        logger.warn(formatChannelToolFailure('channel_react', error))
        const details: { ok: boolean; error?: string } = { ok: false, error }
        return {
          content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}channel_react denied: ${error}` }],
          details,
        }
      }

      const reactionRef = getReactionRef()
      if (reactionRef === undefined) return deny('this conversation has no message to react to')

      const result = await router.queueReactionAfterReply({
        adapter: origin.adapter,
        workspace: origin.workspace,
        chat: origin.chat,
        thread: origin.thread,
        reactionRef,
        emoji: params.emoji,
      })

      if (!result.ok) return deny(`${origin.adapter}:${origin.workspace}/${origin.chat}: ${result.error}`)

      const details: { ok: boolean; error?: string } = { ok: true }
      return {
        content: [
          {
            type: 'text' as const,
            text: `${TOOL_RESULT_PREFIX}will react with :${params.emoji}: on ${origin.adapter}:${origin.workspace}/${origin.chat} if you reply this turn`,
          },
        ],
        details,
      }
    },
  })
}
