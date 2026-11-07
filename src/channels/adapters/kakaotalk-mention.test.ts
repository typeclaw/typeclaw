import { describe, expect, test } from 'bun:test'

import type { KakaoMember } from 'agent-messenger/kakaotalk'

// The package does not export the SDK's own mention builder; importing it by
// path lets these tests assert the tags KakaoTalk will actually receive.
import { buildMentions } from '../../../node_modules/agent-messenger/dist/src/platforms/kakaotalk/mention.js'
import { resolveKakaoMentions } from './kakaotalk-mention'

const member = (user_id: string, nickname: string): KakaoMember => ({
  user_id,
  nickname,
  profile_image_url: null,
  full_profile_image_url: null,
  original_profile_image_url: null,
  status_message: null,
  country_iso: null,
  user_type: 100,
  open_token: null,
  open_profile_link_id: null,
  open_permission: null,
})

describe('resolveKakaoMentions', () => {
  test('tags each member whose nickname follows an @, including Korean particles after the name', () => {
    const members = [member('1', '연규'), member('2', 'Alice'), member('3', 'Bob')]

    expect(resolveKakaoMentions('@연규님 and @Alice, take a look', members)).toEqual([
      { user_id: '1', name: '연규' },
      { user_id: '2', name: 'Alice' },
    ])
  })

  test('returns nothing when the text has no @ or names no member', () => {
    const members = [member('1', 'Alice')]

    expect(resolveKakaoMentions('Alice, take a look', members)).toEqual([])
    expect(resolveKakaoMentions('mail me at a@example.com', members)).toEqual([])
  })

  test('gives an @ to the longest matching nickname so a prefix name is not tagged', () => {
    const members = [member('1', 'Kim'), member('2', 'Kimberly'), member('3', '김'), member('4', '김철수')]

    expect(resolveKakaoMentions('@Kimberly and @김철수', members)).toEqual([
      { user_id: '2', name: 'Kimberly' },
      { user_id: '4', name: '김철수' },
    ])
  })

  test('does not tag a Latin name that continues into a longer word', () => {
    expect(resolveKakaoMentions('@Kimchi time', [member('1', 'Kim')])).toEqual([])
  })

  test('skips a nickname two members share because the tag cannot pick one', () => {
    const members = [member('1', 'Alex'), member('2', 'Alex'), member('3', 'Sam')]

    expect(resolveKakaoMentions('@Alex @Sam', members)).toEqual([{ user_id: '3', name: 'Sam' }])
  })

  test('does not let a shorter name claim an @ that belongs to a skipped ambiguous name', () => {
    // given: "김" is unique, "김철수" is shared by two members
    const members = [member('1', '김'), member('2', '김철수'), member('3', '김철수'), member('4', 'Sam')]
    const text = '@김님 @김철수님 @Sam'

    // when: the resolved targets go through the SDK's real mention builder
    const targets = resolveKakaoMentions(text, members)
    const sent = buildMentions(text, targets)

    // then: "@김철수" is left untagged instead of being attributed to "김"
    expect(sent).toEqual([{ user_id: '4', at: [3], len: 3 }])
  })

  test('every resolved target is accepted by the SDK and tagged where it was written', () => {
    const members = [
      member('1', 'Kim'),
      member('2', 'Kimberly'),
      member('3', '연규'),
      member('4', '김'),
      member('5', '김철수'),
    ]
    const text = '@Kimberly @Kim @연규님 @김철수 @김'

    expect(buildMentions(text, resolveKakaoMentions(text, members))).toEqual([
      { user_id: '2', at: [1], len: 8 },
      { user_id: '1', at: [2], len: 3 },
      { user_id: '3', at: [3], len: 2 },
      { user_id: '5', at: [4], len: 3 },
      { user_id: '4', at: [5], len: 1 },
    ])
  })
})
