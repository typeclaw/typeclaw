// Insulates our code from agent-messenger's strict-mode upstream TS source
// (no `dist/` declarations on npm yet) by re-exporting under a type-augmented
// surface. Runtime uses the real package; TypeScript sees our richer types.
//
// DELETE WHEN: agent-messenger publishes `dist/platforms/slackbot/
// index.d.ts`. Drop this file and import directly from
// 'agent-messenger/slackbot' in adapters/slack-bot.ts.

import { SlackBotClient as RawClient, SlackBotListener as RawListener } from 'agent-messenger/slackbot'

export type SlackPostedMessage = {
  ts: string
  text: string
  user?: string
  username?: string
  type: string
  thread_ts?: string
}

export type SlackTestAuth = {
  user_id: string
  team_id: string
  bot_id?: string
  user?: string
  team?: string
}

export type SlackSocketMessageEvent = {
  type: 'message'
  subtype?: string
  channel: string
  channel_type?: string
  user?: string
  bot_id?: string
  text?: string
  ts: string
  thread_ts?: string
  event_ts?: string
  edited?: { user: string; ts: string }
  hidden?: boolean
  // Client-generated UUID present on user-authored messages. Stable across
  // network retries of the same user gesture (the Slack client reuses it
  // when a send fails and is retried), so it is a reliable secondary dedup
  // key for the case where one user action surfaces as two events with
  // different `ts` values. Absent on bot messages and most system events.
  client_msg_id?: string
  [key: string]: unknown
}

export type SlackSocketAppMentionEvent = {
  type: 'app_mention'
  channel: string
  user: string
  text: string
  ts: string
  thread_ts?: string
  event_ts?: string
  // Carried verbatim into the promoted message event when present so the
  // dedupe ring can use it. Slack's `app_mention` envelope does not always
  // populate this in practice, but typing it keeps the promotion lossless
  // if Slack starts sending it.
  client_msg_id?: string
  [key: string]: unknown
}

export type SlackSocketAck = (responsePayload?: Record<string, unknown>) => void

export type SlackSocketEventsApiEnvelope<E> = {
  ack: SlackSocketAck
  envelope_id: string
  body: {
    team_id?: string
    api_app_id?: string
    event: E
    event_id?: string
    event_time?: number
    [key: string]: unknown
  }
  event: E
}

export type SlackBotListenerConnected = {
  app_id?: string
  num_connections?: number
}

export type SlackBotListenerEventMap = {
  message: [args: SlackSocketEventsApiEnvelope<SlackSocketMessageEvent>]
  app_mention: [args: SlackSocketEventsApiEnvelope<SlackSocketAppMentionEvent>]
  connected: [info: SlackBotListenerConnected]
  disconnected: []
  error: [error: Error]
}

export type SlackFile = {
  id: string
  name: string
  title: string
  mimetype: string
  size: number
  url_private: string
  created: number
  user: string
  channels?: string[]
}

export interface SlackBotClient {
  login(credentials?: { token: string }): Promise<this>
  testAuth(): Promise<SlackTestAuth>
  postMessage(channel: string, text: string, options?: { thread_ts?: string }): Promise<SlackPostedMessage>
  setAssistantStatus(channel: string, threadTs: string, status: string): Promise<void>
  uploadFile(
    channel: string,
    file: Buffer,
    filename: string,
    options?: { thread_ts?: string; title?: string; initial_comment?: string },
  ): Promise<SlackFile>
}

export interface SlackBotListener {
  start(): Promise<void>
  stop(): void
  on<K extends keyof SlackBotListenerEventMap>(event: K, listener: (...args: SlackBotListenerEventMap[K]) => void): this
  off<K extends keyof SlackBotListenerEventMap>(
    event: K,
    listener: (...args: SlackBotListenerEventMap[K]) => void,
  ): this
}

export const SlackBotClient = RawClient as unknown as new () => SlackBotClient
export const SlackBotListener = RawListener as unknown as new (
  client: SlackBotClient,
  options: { appToken: string; debugReconnects?: boolean },
) => SlackBotListener
