export type ReviewAuthor = { id: number; user: string }

export type ReviewAuthorship =
  | { kind: 'self-posted'; postedReviewId: number }
  | { kind: 'exists-not-mine'; reviewsByOthers: ReviewAuthor[] }
  | { kind: 'none' }

export function classifyReviewAuthorship(input: {
  reviews: readonly ReviewAuthor[]
  postedReviewIdsThisSession: readonly number[]
}): ReviewAuthorship {
  const posted = new Set(input.postedReviewIdsThisSession)
  const proven = input.reviews.find((review) => posted.has(review.id))
  if (proven) return { kind: 'self-posted', postedReviewId: proven.id }

  if (input.reviews.length === 0) return { kind: 'none' }

  return { kind: 'exists-not-mine', reviewsByOthers: [...input.reviews] }
}
