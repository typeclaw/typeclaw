import { z } from 'zod'

import { GITHUB_API_BASE, githubJsonHeaders } from '@/channels/adapters/github/auth-pat'
import { describeError } from '@/channels/describe-error'
import { canonicalGithubRepo } from '@/channels/github-repo'

import type { BundledProbeContext } from '../types'

export const githubParams = z.object({
  repo: z
    .string()
    .trim()
    .regex(/^[a-z\d-]+\/[a-z\d_.-]+$/i)
    .transform(canonicalGithubRepo)
    .refine((repo) => !['', '.', '..'].includes(repo.split('/')[1] ?? '')),
  number: z
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1),
})

export type GithubParams = z.infer<typeof githubParams>
export type GithubContext = BundledProbeContext<GithubParams>

export const githubTarget = ({ repo, number }: GithubParams): string => `${repo}#${number}`

class GithubProbeError extends Error {}

const errorPayload = z.object({
  message: z.string(),
  type: z.string().optional(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
})
const envelope = z.object({ errors: z.array(errorPayload).optional(), data: z.unknown() })

export async function githubQuery<T>(
  ctx: GithubContext,
  query: string,
  field: 'issue' | 'pullRequest',
  schema: z.ZodType<T>,
  optionalFields: readonly string[] = [],
): Promise<T> {
  const target = githubTarget(ctx.params)
  const credential = await ctx.resolveTokenForRepo(ctx.params.repo).catch((cause: unknown) => {
    throw new GithubProbeError(`GitHub watch ${target}: token resolution failed: ${describeError(cause)}`, { cause })
  })
  if (credential.kind === 'unavailable') {
    throw new GithubProbeError(`GitHub watch ${target}: token unavailable: ${credential.reason}`)
  }
  if (credential.token.trim() === '') throw new GithubProbeError(`GitHub watch ${target}: resolved token is empty`)
  const [owner, name] = ctx.params.repo.split('/')
  const response = await ctx
    .fetch(`${GITHUB_API_BASE}/graphql`, {
      method: 'POST',
      headers: githubJsonHeaders(credential.token),
      body: JSON.stringify({ query, variables: { owner, name, number: ctx.params.number } }),
      signal: ctx.signal,
      redirect: 'error',
    })
    .catch((cause: unknown) => {
      throw new GithubProbeError(`GitHub watch ${target}: request failed: ${describeError(cause)}`, { cause })
    })
  if (!response.ok) {
    const body = await response.text()
    const retryAfter = response.headers.get('retry-after')
    const hint = retryAfter === null ? '' : ` (retry-after: ${retryAfter})`
    throw new GithubProbeError(`GitHub watch ${target}: HTTP ${response.status}${hint}: ${oneLine(body).slice(0, 300)}`)
  }
  const json: unknown = await response.json().catch((cause: unknown) => {
    throw new GithubProbeError(`GitHub watch ${target}: invalid JSON`, { cause })
  })
  const parsed = envelope.safeParse(json)
  if (!parsed.success)
    throw new GithubProbeError(`GitHub watch ${target}: malformed GraphQL response`, { cause: parsed.error })
  // GitHub answers with partial data and a FORBIDDEN error when the token lacks the
  // permission for one nested field. The caller names the fields it can do without.
  const fatal = parsed.data.errors?.filter(
    ({ type, path }) =>
      type !== 'FORBIDDEN' || !path?.some((segment) => typeof segment === 'string' && optionalFields.includes(segment)),
  )
  if (fatal?.length) {
    const messages = fatal.map(({ message }) => oneLine(message)).join('; ')
    throw new GithubProbeError(`GitHub watch ${target}: GraphQL error: ${messages.slice(0, 400)}`)
  }
  const data = z.object({ repository: z.object({ [field]: schema }) }).safeParse(parsed.data.data)
  const row = data.success ? data.data.repository[field] : undefined
  if (row === undefined) {
    throw new GithubProbeError(`GitHub watch ${target}: missing or malformed ${field} data`, {
      cause: data.success ? undefined : data.error,
    })
  }
  return row
}

export const connection = <T>(node: z.ZodType<T>) =>
  z.object({
    nodes: z
      .array(node.nullable())
      .nullish()
      .transform((nodes) => nodes?.filter((item) => item !== null) ?? []),
  })

export const authoredSchema = z.object({
  author: z.object({ login: z.string(), __typename: z.string() }).nullable(),
  viewerDidAuthor: z.boolean(),
})
type Authored = z.infer<typeof authoredSchema>

export function isSelf(row: Authored, selfLogin: string | undefined): boolean {
  if (row.viewerDidAuthor) return true
  const actor = row.author?.login.toLowerCase()
  const self = selfLogin?.toLowerCase()
  if (actor === undefined || self === undefined) return false
  // A human can own the bare slug of an App, so only strip the suffix for Bot actors.
  return (
    actor === self ||
    (row.author?.__typename === 'Bot' && actor.replace(/\[bot\]$/, '') === self.replace(/\[bot\]$/, ''))
  )
}

export const timestamp = z.iso.datetime({ offset: true }).transform(Date.parse)
const commentSchema = authoredSchema.extend({ id: z.string(), createdAt: timestamp })
type Comment = z.infer<typeof commentSchema>
export const commentConnection = connection(commentSchema)

export const cursorSchema = z.object({ at: z.number(), ids: z.array(z.string()) })
type Cursor = z.infer<typeof cursorSchema>

export function collectComments(rows: readonly Comment[], cursor: Cursor | null, ctx: GithubContext) {
  const floor = cursor?.at ?? ctx.startedAt ?? null
  const seen = new Set(cursor?.ids)
  const fresh = new Map<string, Comment>()
  const at = rows.reduce((latest, row) => Math.max(latest, row.createdAt), floor ?? 0)
  const ids = new Set(at === cursor?.at ? seen : [])
  for (const row of rows) {
    if (row.createdAt === at) ids.add(row.id)
    if (
      floor !== null &&
      (row.createdAt > floor || (row.createdAt === floor && !seen.has(row.id))) &&
      !isSelf(row, ctx.selfLogin)
    ) {
      fresh.set(row.id, row)
    }
  }
  return { cursor: { at, ids: [...ids] }, fresh: [...fresh.values()] }
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function names(values: readonly string[]): string {
  const unique = [...new Set(values)]
  const listed = unique
    .slice(0, 8)
    .map((value) => oneLine(value).slice(0, 60))
    .join(', ')
  return unique.length > 8 ? `${listed}, +${unique.length - 8} more` : listed
}

export const authorName = (row: Authored): string => (row.author === null ? 'unknown author' : `@${row.author.login}`)

export function commentSummary(rows: readonly Comment[], label: string): string {
  return `${rows.length} ${label}${rows.length === 1 ? '' : 's'} (${names(rows.map(authorName))})`
}
