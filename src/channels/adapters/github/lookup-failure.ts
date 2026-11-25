// GitHub uses 403 for both access denials and throttling. Endpoint-specific
// absence policies must never turn a rate limit into definitive missing work.
export function classifyGithubLookupFailure(response: Response, text: string): 'rate-limit' | 'denied' | 'transient' {
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has('retry-after') ||
        response.headers.get('x-ratelimit-remaining') === '0' ||
        /rate limit/i.test(text)))
  )
    return 'rate-limit'
  if (response.status === 401 || response.status === 403 || response.status === 404) return 'denied'
  return 'transient'
}
