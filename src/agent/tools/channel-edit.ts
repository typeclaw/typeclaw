import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import {
  containsKimiToolDelimiter,
  isNoReplySignal,
  isUpstreamEmptyResponseSentinel,
  stripThinkBlocks,
  type ChannelRouter,
} from '@/channels/router'
import { ADAPTER_IDS, type AdapterId } from '@/channels/schema'
import type { EditMessageResult } from '@/channels/types'

import { type ChannelToolLogger, consoleChannelLogger, formatChannelToolFailure } from './channel-log'
import { renderOutboundEcho, TOOL_RESULT_PREFIX } from './channel-reply'
import { fenceToolResult } from './runtime-notice'

export type CreateChannelEditToolOptions = {
  router: ChannelRouter
  logger?: ChannelToolLogger
}

export function createChannelEditTool({ router, logger = consoleChannelLogger }: CreateChannelEditToolOptions) {
  return defineTool({
    name: 'channel_edit',
    label: 'Channel Edit',
    description:
      'Edit the text of a message you already posted to an external messenger channel, replacing its body in place. ' +
      'Pass the `message_id` a prior `channel_send` returned (Slack thread ts, Discord message id), plus the same ' +
      'adapter/workspace/chat you sent it to, and the new `text`. Use this to fix a typo, correct a wrong answer, ' +
      'or append a result to a status message you posted earlier — not to carry on a conversation (send a new ' +
      'message for that). Editing is supported on "slack-bot", "slack", "discord-bot", "discord", "telegram-bot", ' +
      '"webex", "webex-bot", and "teams" (chats/DMs only — Teams team-channel posts cannot be edited); an adapter ' +
      'that does not implement editing at all returns ' +
      '{ ok: false, error, code: "not-supported" }. You can only edit messages YOU authored; editing someone ' +
      'else\'s returns code "permission-denied". On success returns { ok: true }; a missing/deleted target returns ' +
      'code "not-found". Code "adapter-unavailable" is distinct from "not-supported": the adapter DOES support ' +
      'editing but is not currently running (e.g. it failed to start on an expired token) — re-authenticating and ' +
      'retrying may fix it, so do not treat it as permanently unsupported.',
    parameters: Type.Object({
      adapter: Type.Union(
        ADAPTER_IDS.map((a) => Type.Literal(a)),
        {
          description:
            'Adapter id. Editing is supported on "slack-bot", "slack", "discord-bot", "discord", "telegram-bot", ' +
            '"webex", "webex-bot", and "teams" (Teams chats/DMs only — not team-channel posts).',
        },
      ),
      workspace: Type.String({
        description:
          'Discord guild id or Slack team id (e.g. "T0ACME"); use "@dm" for direct-message channels on either platform.',
        minLength: 1,
      }),
      chat: Type.String({
        description:
          'Channel id the message lives in. Discord channel id (numeric snowflake) or Slack channel id (e.g. "C0CHANNEL", "D0DMID").',
        minLength: 1,
      }),
      thread: Type.Optional(
        Type.String({
          description:
            'Optional thread id the message lives in. Context only — the edit is addressed by `message_id`, so this is not required.',
          minLength: 1,
        }),
      ),
      message_id: Type.String({
        description:
          'Platform-native id of the message to edit, as returned by a prior `channel_send` (Slack thread ts, Discord message id).',
        minLength: 1,
      }),
      text: Type.String({
        description: 'The new message body that fully replaces the current text.',
        minLength: 1,
      }),
    }),

    async execute(_toolCallId, params) {
      const adapter = params.adapter as AdapterId
      type DenyCode = NonNullable<(EditMessageResult & { ok: false })['code']>
      const deny = (error: string, code?: DenyCode) => {
        logger.warn(formatChannelToolFailure('channel_edit', error))
        const details: { ok: false; error: string; code?: DenyCode } =
          code !== undefined ? { ok: false, error, code } : { ok: false, error }
        return {
          content: [{ type: 'text' as const, text: `${TOOL_RESULT_PREFIX}channel_edit denied: ${error}` }],
          details,
        }
      }

      const contentError = editTextGuardError(params.text)
      if (contentError) return deny(contentError)

      // Strip leaked `<think>` blocks before the edit reaches the router/adapter,
      // exactly as the send path normalizes text. A replacement that is ONLY a
      // think block leaves nothing to post, so deny rather than blank the message.
      const text = stripThinkBlocks(params.text)
      if (text === '') return deny('the replacement text is empty after removing reasoning blocks')

      const result = await router.editMessage({
        adapter,
        workspace: params.workspace,
        chat: params.chat,
        ...(params.thread !== undefined ? { thread: params.thread } : {}),
        messageId: params.message_id,
        text,
      })

      if (!result.ok) {
        return deny(`${adapter}:${params.workspace}/${params.chat}: ${result.error}`, result.code)
      }

      const echo = renderOutboundEcho(text, undefined)
      const receipt = `edited ${adapter}:${params.workspace}/${params.chat} message ${params.message_id}: ${echo}`
      return {
        content: [{ type: 'text' as const, text: fenceToolResult(receipt) }],
        details: { ok: true },
      }
    },
  })
}

// Same content guards channel_send runs, minus the send-only flood/dup/resolve
// logic: an edit is a mutation of an existing post, so the only shared risk is
// forwarding a control signal (NO_REPLY), the upstream empty-response sentinel
// (leaks thinking/signature), or raw provider tool-call delimiters as the new
// body. Blocked BEFORE the router call so the string never reaches the chat.
function editTextGuardError(text: string): string {
  if (isNoReplySignal(text)) {
    return '`NO_REPLY` is the silent-turn signal, not a message body. To edit a message, pass the replacement text.'
  }
  if (isUpstreamEmptyResponseSentinel(text)) {
    return (
      'refusing to forward an upstream `(Empty response: ...)` sentinel; ' +
      "that string is a provider-SDK debug dump containing the model's thinking content and signature, not a message body."
    )
  }
  if (containsKimiToolDelimiter(text)) {
    return (
      'refusing to forward raw provider tool-call control tokens; these are chat-template ' +
      'delimiters that should have been parsed into a real tool call upstream.'
    )
  }
  return ''
}
