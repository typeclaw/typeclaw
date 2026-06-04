import { describe, expect, test } from 'bun:test'

import { classifyReviewAuthorship } from './review-attribution'

describe('classifyReviewAuthorship', () => {
  const self = 'dobby[bot]'

  test('a review by another account (the shared inminsoo case) is exists-not-mine', () => {
    // given: a review exists, authored by inminsoo, with no in-session POST record
    const result = classifyReviewAuthorship({
      reviews: [{ id: 4425549013, user: 'inminsoo' }],
      postedReviewIdsThisSession: [],
    })

    // then: the agent must NOT claim it
    expect(result).toEqual({ kind: 'exists-not-mine', reviewsByOthers: [{ id: 4425549013, user: 'inminsoo' }] })
  })

  test('a review WITH an in-session POST record is self-posted', () => {
    const result = classifyReviewAuthorship({
      reviews: [{ id: 99, user: self }],
      postedReviewIdsThisSession: [99],
    })

    expect(result).toEqual({ kind: 'self-posted', postedReviewId: 99 })
  })

  test('a self-login review WITHOUT an in-session POST record is still not claimable', () => {
    // given: author login matches the App, but this session never recorded the POST
    // (e.g. a different session/run of the same bot, or the legacy Actions bot, posted it)
    const result = classifyReviewAuthorship({
      reviews: [{ id: 77, user: self }],
      postedReviewIdsThisSession: [],
    })

    // then: no in-session proof => cannot claim authorship
    expect(result).toEqual({ kind: 'exists-not-mine', reviewsByOthers: [{ id: 77, user: self }] })
  })

  test('no reviews at all is none', () => {
    const result = classifyReviewAuthorship({
      reviews: [],
      postedReviewIdsThisSession: [],
    })

    expect(result).toEqual({ kind: 'none' })
  })

  test('self-posted takes precedence when both a recorded POST and other reviews exist', () => {
    const result = classifyReviewAuthorship({
      reviews: [
        { id: 1, user: 'inminsoo' },
        { id: 2, user: self },
      ],
      postedReviewIdsThisSession: [2],
    })

    expect(result).toEqual({ kind: 'self-posted', postedReviewId: 2 })
  })
})
