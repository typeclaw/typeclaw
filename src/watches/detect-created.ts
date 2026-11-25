import { z } from 'zod'

import { GITHUB_API_BASE } from '@/channels/adapters/github/auth-pat'
import { canonicalGithubRepo } from '@/channels/github-repo'

export type CreatedGithubTarget = {
  readonly kind: 'github-pr' | 'github-issue'
  readonly repo: string
  readonly number: number
}
type Kind = CreatedGithubTarget['kind']

const slug = '[a-z\\d-]+/[a-z\\d_.-]+'
const targetUrl = new RegExp(`^https://github\\.com/(${slug})/(pull|issues)/([1-9]\\d*)/?$`, 'i')
const restPath = new RegExp(`^/repos/(${slug}|\\{owner\\}/\\{repo\\})/(pulls|issues)/?$`, 'i')
const jsonObject = z.record(z.string(), z.unknown())

function parseTarget(raw: unknown, expected: Kind, repo?: string): CreatedGithubTarget[] {
  if (typeof raw !== 'string') return []
  const match = targetUrl.exec(raw.trim())
  if (match?.[1] === undefined) return []
  if (match[2] !== 'pull' && match[2] !== 'issues') return []
  const kind = match[2] === 'pull' ? 'github-pr' : 'github-issue'
  const actualRepo = canonicalGithubRepo(match[1])
  const number = Number(match[3])
  if (
    kind !== expected ||
    ['', '.', '..'].includes(actualRepo.split('/')[1] ?? '') ||
    !Number.isInteger(number) ||
    number > 2 ** 31 - 1 ||
    (repo !== undefined && repo !== actualRepo)
  )
    return []
  return [{ kind, repo: actualRepo, number }]
}

// A bash result has no per-process stdout provenance. Attribute it only to a
// lone literal invocation, not to a pipeline, wrapper, expansion, or sequence.
function literalArgs(command: string): string[] {
  const input = command.trim().replace(/\\\r?\n/g, '')
  const args: string[] = []
  const word = /(?:'[^']*'|"(?:\\["\\$`]|[^"\\$`])*"|\\[^\r\n]|[^ \t\r\n'"\\;&|<>()`${}*?[\]])+/y
  for (let i = 0; i < input.length; ) {
    if (input[i] === ' ' || input[i] === '\t') {
      i++
      continue
    }
    if (input[i] === '#' && !/[\r\n]/.test(input.slice(i))) break
    word.lastIndex = i
    const result = word.exec(input)
    if (result === null) return []
    args.push(
      result[0].replace(
        /'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/gs,
        (_, single, double, escaped) => single ?? double?.replace(/\\(["\\$`])/g, '$1') ?? escaped,
      ),
    )
    i = word.lastIndex
  }
  return args
}

const valueFlags = new Set([
  '--method',
  '--raw-field',
  '--field',
  '--header',
  '--jq',
  '--template',
  '--input',
  '--cache',
  '--hostname',
  '--repo',
])
const shortFlags = new Map([
  ['X', '--method'],
  ['f', '--raw-field'],
  ['F', '--field'],
  ['H', '--header'],
  ['q', '--jq'],
  ['t', '--template'],
  ['R', '--repo'],
])

function apiInvocation(args: readonly string[]) {
  let endpoint: string | undefined
  let method: string | undefined
  let hasFields = false
  let hasInput = false
  let query: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === undefined || arg === '' || arg === '--') return null
    let name = arg
    let value: string | undefined
    const long = /^(--[^=]+)(?:=(.*))?$/s.exec(arg)
    const short = /^-([XfFHqtR])(?:=?(.*))?$/s.exec(arg)
    if (long?.[1] !== undefined) {
      name = long[1]
      value = long[2]
    } else if (short?.[1] !== undefined) {
      name = shortFlags.get(short[1]) ?? arg
      value = short[2] || undefined
    }
    if (valueFlags.has(name)) {
      if (value === undefined) {
        value = args[++i]
        if (value === undefined) return null
      }
      if (name === '--hostname' && value.toLowerCase() !== 'github.com') return null
      if (name === '--method') method = value
      if (name === '--input') hasInput = value !== ''
      if (name === '--raw-field' || name === '--field') {
        hasFields = true
        if (value.startsWith('query=')) query = value.slice(6)
      }
    } else if (!arg.startsWith('-')) {
      if (endpoint !== undefined) return null
      endpoint = arg
    }
  }
  // With --input, the body is not present in the command and the field flags
  // become URL parameters. We can still recognize a literal REST destination.
  return { endpoint, method: method ?? (hasFields || hasInput ? 'POST' : 'GET'), query: hasInput ? undefined : query }
}

// GraphQL names are recognized only at the mutation's root selection level:
// text inside strings, comments, arguments, or nested response fields is not
// evidence that the command called a create mutation.
function mutationFields(query: string): Map<string, Kind> {
  const tokens =
    query
      .match(/"""(?:\\"""|(?!""")[\s\S])*"""|"(?:\\.|[^"\\])*"|#[^\r\n]*|[A-Za-z_][A-Za-z_0-9]*|[{}():[\]]/g)
      ?.filter((token) => !token.startsWith('#')) ?? []
  const fields = new Map<string, Kind>()
  if (tokens[0] !== 'mutation') return fields
  let depth = 0
  let root = false
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (root && depth === 1 && token !== undefined && /^[A-Za-z_]/.test(token)) {
      const alias = tokens[i + 1] === ':'
      const field = alias ? tokens[i + 2] : token
      if (alias) i += 2
      if (tokens[i + 1] === '(') {
        if (field === 'createPullRequest') fields.set(token, 'github-pr')
        if (field === 'createIssue') fields.set(token, 'github-issue')
      }
    } else if (token === '{' || token === '(' || token === '[') {
      if (token === '{' && depth === 0) root = true
      depth++
    } else if (token === '}' || token === ')' || token === ']') {
      depth--
      if (root && depth === 0) return i === tokens.length - 1 ? fields : new Map()
    }
  }
  return new Map()
}

function responseObject(output: string) {
  const body = output.trim().replace(/^HTTP\/[^\r\n]+ 2\d\d(?: [^\r\n]*)?\r?\n[\s\S]*?\r?\n\r?\n/, '')
  try {
    return jsonObject.safeParse(JSON.parse(body)).data
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

function apiTargets(args: readonly string[], output: string): CreatedGithubTarget[] {
  const invocation = apiInvocation(args)
  if (invocation?.method.toUpperCase() !== 'POST' || invocation.endpoint === undefined) return []
  const base = new URL(GITHUB_API_BASE)
  const url = URL.parse(invocation.endpoint, base)
  if (url?.origin !== base.origin || url.username !== '' || url.password !== '' || url.hash !== '') return []
  const response = responseObject(output)
  if (response === undefined) return []
  if (url.pathname === '/graphql' && invocation.query !== undefined) {
    const data = jsonObject.safeParse(response['data']).data
    if (data === undefined) return []
    return [...mutationFields(invocation.query)].flatMap(([key, kind]) => {
      const payload = jsonObject.safeParse(data[key]).data
      const resource = jsonObject.safeParse(payload?.[kind === 'github-pr' ? 'pullRequest' : 'issue']).data
      return parseTarget(resource?.['url'], kind)
    })
  }
  const path = restPath.exec(url.pathname.replace(/%7B(owner|repo)%7D/gi, '{$1}'))
  if (path?.[1] === undefined || (path[2] !== 'pulls' && path[2] !== 'issues')) return []
  const repo = path[1] === '{owner}/{repo}' ? undefined : canonicalGithubRepo(path[1])
  return parseTarget(response['html_url'], path[2] === 'pulls' ? 'github-pr' : 'github-issue', repo)
}

export function detectCreatedGithubTargets(command: string, output: string): CreatedGithubTarget[] {
  const [gh, group, action, ...rest] = literalArgs(command)
  if (gh !== 'gh') return []
  const found =
    group === 'api' && action !== undefined
      ? apiTargets([action, ...rest], output)
      : action === 'create' && (group === 'pr' || group === 'issue')
        ? output.split(/\r?\n/).flatMap((line) => parseTarget(line, group === 'pr' ? 'github-pr' : 'github-issue'))
        : []
  return [...new Map(found.map((target) => [`${target.kind}:${target.repo}#${target.number}`, target])).values()]
}
