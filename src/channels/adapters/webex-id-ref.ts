import { decodeWebexId } from 'agent-messenger/webex'
import type { WebexRestIdType } from 'agent-messenger/webex'

import type { AdapterId } from '../schema'

// Webex REST ids are base64url of `ciscospark://<cluster>/<TYPE>/<uuid>`. The
// opaque blob is unreadable in `inspect` and — worst — in hand-authored
// permission rules (`webex:* author:Y2lzY29zcGFyazov...`). A `ref` is the
// decoded trailing value: a UUID for ROOM/MESSAGE, a UUID OR an email for
// PEOPLE (legacy "Hydra" accounts encode the email).
//
// `decodeWebexId` comes from agent-messenger and is null-safe on non-ids.
// `toRef` and `isWebexIdOfType` are local wrappers: upstream's own `toRef`
// THROWS on a value that is not a valid REST id (e.g. a bare uuid already in
// ref form), but every typeclaw call site feeds it values that may already be
// refs or non-webex tokens, so we need the fall-open contract instead.
//
// `ref` is for human-facing surfaces only; the canonical base64 id stays the
// wire/session currency.

export { decodeWebexId } from 'agent-messenger/webex'
export type { DecodedWebexId, WebexRestIdType } from 'agent-messenger/webex'

export function toRef(id: string): string {
  const decoded = decodeWebexId(id)
  return decoded === null ? id : decoded.uuid
}

// Refuses cross-type collisions: a decoded ROOM uuid must never satisfy an
// `author:` (PEOPLE) rule even if the trailing uuid strings happen to match.
export function isWebexIdOfType(id: string, type: WebexRestIdType): boolean {
  const decoded = decodeWebexId(id)
  return decoded !== null && decoded.type === type
}

// Gate the decode on adapter: only Webex ids are opaque base64 blobs, and
// `toRef` would otherwise run its fall-open path over ids that can never decode.
const WEBEX_ADAPTERS = new Set<AdapterId>(['webex', 'webex-bot'])

export function readableChannelId(adapter: AdapterId, id: string): string {
  return WEBEX_ADAPTERS.has(adapter) ? toRef(id) : id
}
