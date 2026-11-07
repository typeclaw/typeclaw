import type { KakaoMember, KakaoMentionInput } from 'agent-messenger/kakaotalk'

const WORD_CONTINUATION = /[\p{Script=Latin}\p{N}_]/u

// Turns `@<nickname>` tags the agent wrote into native KakaoTalk mentions for
// the chat's members. The SDK's `buildMentions` gives each `@` to the longest
// REQUESTED name that matches there and throws when a requested name wins no
// `@`. So a target is requested only when it wins an `@` among every member
// name, and a nickname two members share is never requested (its tag cannot
// pick one). Because the SDK only sees requested names, a shorter target could
// still claim an `@` whose real winner was such an ambiguous name; any target
// that would is dropped too, leaving that text untagged rather than mis-tagged.
export function resolveKakaoMentions(text: string, members: readonly KakaoMember[]): KakaoMentionInput[] {
  if (!text.includes('@')) return []
  const idByName = new Map<string, string | null>()
  for (const m of members) {
    if (m.nickname === '') continue
    idByName.set(m.nickname, idByName.has(m.nickname) ? null : m.user_id)
  }
  const allNames = [...idByName.keys()]
  const intendedWinners = atPositions(text).map((i) => longestTagAt(text, i, allNames))
  const requested = new Set(intendedWinners.filter((n): n is string => n !== undefined && idByName.get(n) !== null))

  for (let changed = true; changed; ) {
    changed = false
    atPositions(text).forEach((i, k) => {
      const sdkWinner = longestTagAt(text, i, [...requested])
      if (sdkWinner !== undefined && sdkWinner !== intendedWinners[k]) {
        requested.delete(sdkWinner)
        changed = true
      }
    })
  }

  return [...requested].map((name) => ({ user_id: idByName.get(name)!, name }))
}

function atPositions(text: string): number[] {
  const positions: number[] = []
  for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) positions.push(i)
  return positions
}

function longestTagAt(text: string, at: number, names: readonly string[]): string | undefined {
  let best: string | undefined
  for (const n of names) {
    if (best !== undefined && n.length <= best.length) continue
    if (text.startsWith(n, at + 1) && endsTag(text, at + 1 + n.length, n)) best = n
  }
  return best
}

// A Latin/digit-final name followed by another Latin/digit is a longer word,
// not a tag. Anything else may follow, since Korean particles attach directly
// to a name (`@연규님`).
function endsTag(text: string, end: number, name: string): boolean {
  const next = text[end]
  if (next === undefined) return true
  const last = [...name].at(-1) ?? ''
  return !(WORD_CONTINUATION.test(last) && WORD_CONTINUATION.test(next))
}
