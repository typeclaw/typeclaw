import type { PermissionGap } from './event-permissions'

export type GithubAuthType = 'pat' | 'app'

// What kind of outbound API the adapter was trying to call when it got a
// permission-failure response. Each value maps to a distinct GitHub App
// permission family (and, for PATs, a distinct scope), so each surfaces a
// different remediation message.
export type OutboundEndpointKind =
  | 'issue-comment'
  | 'pr-review-reply'
  | 'discussion-comment'
  | 'issue-reaction'
  | 'pr-review-comment-reaction'

// The repository permissions a GitHub App created from a manifest asks for.
// Keys are GitHub's manifest/REST permission names; they must stay in sync with
// githubRequiredPermissionsNote below and the App permissions table in
// docs/content/docs/reference/github.mdx.
export const GITHUB_APP_MANIFEST_PERMISSIONS = {
  actions: 'write',
  checks: 'write',
  contents: 'read',
  discussions: 'write',
  issues: 'write',
  metadata: 'read',
  pull_requests: 'write',
  repository_hooks: 'write',
  statuses: 'read',
} as const

// The required-permissions checklist shown verbatim during interactive GitHub
// channel setup (both `typeclaw init` and `typeclaw channel add github`). Kept
// here — the single owner of GitHub permission copy — so the init and
// channel-add flows can't drift apart (they did once: Actions was added to one
// and not the other). The labels mirror github.com's UI strings so a user can
// grep their settings page for the exact text. `includeWebhookNote` appends the
// "TypeClaw will create and manage the repository webhooks for you" reassurance,
// shown only on the first-setup prompts (not the rotate/switch prompts).
export function githubRequiredPermissionsNote(includeWebhookNote: boolean): string {
  const webhooks = includeWebhookNote
    ? 'Webhooks read/write (TypeClaw will create and manage the repository webhooks for you).'
    : 'Webhooks read/write.'
  return [
    'Required permissions: Issues read/write, Pull requests read/write, Discussions read/write (if used),',
    `Actions read/write, Commit statuses read, Metadata read, and ${webhooks}`,
    'For the typeclaw/review PR check: Checks read/write (GitHub App) or Commit statuses read/write (PAT).',
  ].join('\n')
}

// Parses webhook-register errors of the shape `list hooks failed: <status> <body>`.
// Returns the status code when it matches the two shapes GitHub emits for
// missing access on the list-hooks endpoint:
//   - 404 Not Found: the token cannot see the repo at all (private repo
//     gated behind missing repository access — GitHub returns 404 instead of
//     403 to avoid leaking the existence of private repos).
//   - 403 Forbidden: the token sees the repo but lacks webhook-management
//     permission, OR is blocked by an org SSO/SAML authorization gate.
// Returns null for any other error (network, malformed slug, create-hook
// failures, etc.) so the guidance only fires on the actual symptom.
export function parseListHooksPermissionStatus(error: string): number | null {
  const match = error.match(/^list hooks failed: (404|403)\b/)
  if (match === null) return null
  return Number(match[1])
}

// The labels below intentionally mirror github.com's current UI verbatim so a
// user can grep their settings page for the exact string. If GitHub renames
// any of these in a future redesign, update both here and the
// `permissionGuidance` tests in lifecycle.test.ts.
//
//   Fine-grained PAT:
//     Settings → Developer settings → Personal access tokens → Fine-grained tokens
//     "Resource owner", "Repository access", "Repository permissions" → "Webhooks" → "Read and write", "Metadata" → "Read-only"
//   GitHub App:
//     Settings → Developer settings → GitHub Apps → <app> → Permissions & events
//     "Repository permissions" → "Webhooks" → "Read and write"
//     Install/configure on the org: <app settings> → Install App / Configure → "Repository access"
//   Classic PAT (legacy, still supported by GitHub but we don't surface it in
//     channel-add prompts):
//     Settings → Developer settings → Personal access tokens (classic)
//     Scope: "admin:repo_hook" (or full "repo" for private repositories)
export function buildPermissionGuidance(
  authType: GithubAuthType,
  failures: ReadonlyArray<{ repo: string; status: number }>,
): string {
  const repoList = failures.map((f) => `${f.repo} (${f.status})`).join(', ')
  const lines: string[] = [
    `[github] webhook setup needs more access for: ${repoList}.`,
    '  - 404 from GitHub means the token cannot see the repo (GitHub hides private repos behind 404 instead of 403).',
    '  - 403 means the token sees the repo but lacks webhook permission, or is blocked by org SAML/SSO.',
    '',
  ]
  if (authType === 'pat') {
    lines.push(
      '  Fix (fine-grained personal access token):',
      '    1. Open https://github.com/settings/personal-access-tokens and edit the token TypeClaw is using.',
      '    2. Under "Resource owner", select the org that owns the failing repos (e.g. the org in the slug above).',
      '    3. Under "Repository access", choose "Only select repositories" and add every failing repo (or pick "All repositories").',
      '    4. Under "Repository permissions", set "Webhooks" to "Read and write" and "Metadata" to "Read-only".',
      '    5. Save. If the org enforces SAML SSO, click "Configure SSO" next to the token and authorize the org.',
      '',
      '  Or (classic personal access token): grant the "admin:repo_hook" scope (or "repo" for private repos),',
      '  and on a SAML-protected org click "Authorize" next to the token.',
    )
  } else {
    lines.push(
      '  Fix (GitHub App):',
      '    1. Open https://github.com/settings/apps and edit the app TypeClaw is using.',
      '    2. Under "Permissions & events" → "Repository permissions", set "Webhooks" to "Read and write". Save.',
      '    3. From the app page, click "Install App" (or "Configure" if already installed) and select the org that owns the failing repos.',
      '    4. Under "Repository access", choose "Only select repositories" and add every failing repo (or pick "All repositories").',
      '    5. If the app permissions changed in step 2, install owners must accept the updated permissions from the install page before the new access takes effect.',
    )
  }
  return lines.join('\n')
}

// Always GitHub App: PATs don't have per-installation permission grants
// (their access is gated by token scopes, surfaced by the existing 404/403
// flow in webhook-register).
export function buildAppPermissionPreflightGuidance(gaps: ReadonlyArray<PermissionGap>): string {
  const lines = [
    `[github] GitHub App installation is missing permissions for ${gaps.length} configured event ${gaps.length === 1 ? 'family' : 'families'}:`,
  ]
  for (const gap of gaps) {
    const eventList = gap.events.join(', ')
    const grantedLabel = gap.granted === null ? 'none' : gap.granted
    const needLabel = gap.needsWrite ? 'Read and write' : 'Read-only'
    lines.push(`  - ${gap.uiLabel}: granted=${grantedLabel}, need=${needLabel} (covers: ${eventList})`)
  }
  lines.push(
    '',
    '  Fix:',
    '    1. Open https://github.com/settings/apps and edit the app TypeClaw is using.',
    '    2. Under "Permissions & events" → "Repository permissions", set each missing permission above to the listed level. Save.',
    '    3. Open the install page (Install App / Configure for the org) and accept the updated permissions request — the new access only takes effect after the install owner accepts.',
    '    4. If the org enforces SAML SSO, ensure the App is authorized for the org from the org settings → Third-party Apps page.',
    '',
    '  Webhooks already received will continue to deliver, but payload fields and reply attempts that require the missing permission will fail with 403 ("Resource not accessible by integration") until the install is reaccepted.',
  )
  return lines.join('\n')
}

// The label and (for App auth) the level appear verbatim on github.com so
// users can grep their settings page for the exact strings. The PAT scope
// names are GitHub's canonical token-scope identifiers, also verbatim.
const OUTBOUND_PERMISSION_FOR_KIND: Record<
  OutboundEndpointKind,
  { label: string; level: 'Read and write'; patScope: string; patFineGrained: string }
> = {
  'issue-comment': {
    label: 'Issues',
    level: 'Read and write',
    patScope: 'repo (or public_repo for public repos)',
    patFineGrained: 'Issues',
  },
  'pr-review-reply': {
    label: 'Pull requests',
    level: 'Read and write',
    patScope: 'repo',
    patFineGrained: 'Pull requests',
  },
  'discussion-comment': {
    label: 'Discussions',
    level: 'Read and write',
    patScope: 'repo',
    patFineGrained: 'Discussions',
  },
  // Reactions on an issue/PR body or an issue comment go through the Issues
  // permission family; reactions on a PR review comment go through Pull requests.
  'issue-reaction': {
    label: 'Issues',
    level: 'Read and write',
    patScope: 'repo (or public_repo for public repos)',
    patFineGrained: 'Issues',
  },
  'pr-review-comment-reaction': {
    label: 'Pull requests',
    level: 'Read and write',
    patScope: 'repo',
    patFineGrained: 'Pull requests',
  },
}

// Decorate an outbound-API failure with the precise github.com permission a
// user needs to enable. Called only on the 403 + "Resource not accessible by
// integration" combination — other 403s (org SSO, suspended install) need
// different remediation and would be mis-described here.
export function buildOutboundPermissionGuidance(options: {
  authType: GithubAuthType
  endpointKind: OutboundEndpointKind
}): string {
  const perm = OUTBOUND_PERMISSION_FOR_KIND[options.endpointKind]
  if (options.authType === 'app') {
    return [
      '',
      `  Fix (GitHub App): the App needs "${perm.label}" → "${perm.level}".`,
      '    1. Open https://github.com/settings/apps and edit the app TypeClaw is using.',
      `    2. Under "Permissions & events" → "Repository permissions", set "${perm.label}" to "${perm.level}". Save.`,
      '    3. Open the install page (Install App / Configure for the org) and accept the updated permissions request — the new access only takes effect after the install owner accepts.',
    ].join('\n')
  }
  return [
    '',
    `  Fix (fine-grained personal access token): grant "${perm.patFineGrained}" → "Read and write" on the failing repo.`,
    '    1. Open https://github.com/settings/personal-access-tokens and edit the token TypeClaw is using.',
    `    2. Under "Repository permissions", set "${perm.patFineGrained}" to "Read and write". Save.`,
    `    3. If the org enforces SAML SSO, click "Configure SSO" next to the token and authorize the org.`,
    '',
    `  Or (classic personal access token): grant the "${perm.patScope}" scope; SAML-protected orgs additionally need "Authorize" next to the token.`,
  ].join('\n')
}

// 403 with this exact body is GitHub's signal that the call would succeed
// with the right permissions. Other 403 bodies (e.g. "OAuth token… needs to
// be authorized for this organization", suspended installation) need
// different remediation, so the decoration matcher is intentionally narrow.
const INTEGRATION_PERMISSION_DENIAL = 'Resource not accessible by integration'

export function isOutboundPermissionDenial(status: number, body: string): boolean {
  return status === 403 && body.includes(INTEGRATION_PERMISSION_DENIAL)
}
