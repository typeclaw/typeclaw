import type { SecuritySeverity } from '../permissions'
import type { SecurityBlock } from '../policy'
import { outboundTexts } from './outbound-text'

export const GUARD_OUTBOUND_SECRET = 'outboundSecret'
// Classified `high` (audience-leak axis): bypass posts credential-shaped
// text to a chat channel whose readership is a third-party audience
// outside the operator's control loop. Channel readers, push-notification
// previews, search indexes, and other bots in the channel all see the
// secret before the operator can intervene. Owner-in-public-channel is
// the canonical motivating case: even owner asking the agent to "post the
// deploy status" should not be able to silently include a stack-trace
// `Bearer ghp_...` line. The whole point of the high tier is that
// audience-leak guards require per-call ack from every role, including
// owner — see AGENTS.md `## Permissions` rules of thumb.
export const GUARD_OUTBOUND_SECRET_SEVERITY: SecuritySeverity = 'high'

const SIGNATURE_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: 'aws_access_key_id', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { kind: 'aws_secret_access_key', pattern: /(?:aws[_-]?secret|aws_secret_access_key)["'\s:=]+[A-Za-z0-9/+=]{40}\b/i },
  { kind: 'github_personal_access_token', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_oauth_token', pattern: /\bgho_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_user_to_server_token', pattern: /\bghu_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_server_to_server_token', pattern: /\bghs_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_refresh_token', pattern: /\bghr_[A-Za-z0-9]{36}\b/ },
  { kind: 'github_app_token', pattern: /\bghp_[A-Za-z0-9]{255,}\b/ },
  { kind: 'github_fine_grained_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { kind: 'slack_user_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'slack_webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/ },
  { kind: 'discord_bot_token', pattern: /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,}\b/ },
  { kind: 'openai_api_key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'anthropic_api_key', pattern: /\bsk-ant-(?:api|admin)\d{2,}-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'fireworks_api_key', pattern: /\bfw_[A-Za-z0-9]{20,}\b/ },
  { kind: 'stripe_secret_key', pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/ },
  { kind: 'stripe_restricted_key', pattern: /\brk_(?:live|test)_[A-Za-z0-9]{24,}\b/ },
  { kind: 'twilio_account_sid', pattern: /\bAC[a-f0-9]{32}\b/ },
  { kind: 'sendgrid_api_key', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { kind: 'square_access_token', pattern: /\bsq0atp-[A-Za-z0-9_-]{22,}\b/ },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    kind: 'pem_private_key_block',
    pattern: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED|ANY)?\s*PRIVATE\s+KEY-----/,
  },
  { kind: 'pem_certificate_request', pattern: /-----BEGIN\s+CERTIFICATE\s+REQUEST-----/ },
  { kind: 'putty_private_key', pattern: /PuTTY-User-Key-File-\d:/ },
  {
    kind: 'env_assignment_with_secret_key',
    pattern:
      /\b(?:[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|AUTH))\s*=\s*["']?[A-Za-z0-9+/_=:.,!@#$%^&*()-]{12,}["']?/,
  },
]

const PROCESS_ENV_TARGETS: ReadonlyArray<string> = [
  'FIREWORKS_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MINIMAX_API_KEY',
  'DEEPSEEK_API_KEY',
  'UPSTAGE_API_KEY',
  'MOONSHOT_API_KEY',
  'MOONSHOT_CODING_API_KEY',
  'INCEPTION_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_USER_TOKEN',
  'SLACK_APP_TOKEN',
  'DISCORD_BOT_TOKEN',
  'NOTION_TOKEN',
  'STRIPE_SECRET_KEY',
  'TYPECLAW_HOSTD_TOKEN',
]

const ENV_KEY_RECON_TARGETS: ReadonlyArray<string> = [
  ...PROCESS_ENV_TARGETS,
  'TYPECLAW_HOSTD_BROKER_TOKEN',
  'TYPECLAW_HOSTD_URL',
  'TYPECLAW_CONTAINER_NAME',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'KUBECONFIG',
  'DOCKER_AUTH_CONFIG',
]

const ENV_KEY_RECON_THRESHOLD = 3

// Names are fixed literals, so these boundary regexes are constant. Compile
// once at module load, not ~30 RegExps per outbound message (guard is per-send).
const ENV_KEY_RECON_MATCHERS: ReadonlyArray<readonly [name: string, pattern: RegExp]> = ENV_KEY_RECON_TARGETS.map(
  (name) => [name, new RegExp(`\\b${name}\\b`)] as const,
)

export type OutboundSecretMatch = {
  kind: string
  source: 'signature' | 'process_env' | 'env_key_recon'
}

export function findOutboundSecrets(text: string, env: NodeJS.ProcessEnv = process.env): OutboundSecretMatch[] {
  const hits: OutboundSecretMatch[] = []
  const seen = new Set<string>()

  for (const { kind, pattern } of SIGNATURE_PATTERNS) {
    if (pattern.test(text)) {
      const dedup = `signature:${kind}`
      if (!seen.has(dedup)) {
        seen.add(dedup)
        hits.push({ kind, source: 'signature' })
      }
    }
  }

  for (const name of PROCESS_ENV_TARGETS) {
    const value = env[name]
    if (typeof value !== 'string' || value.length < 16) continue
    if (text.includes(value)) {
      const dedup = `env:${name}`
      if (!seen.has(dedup)) {
        seen.add(dedup)
        hits.push({ kind: name, source: 'process_env' })
      }
    }
  }

  const reconNames = findReconEnvKeys(text)
  if (reconNames.length >= ENV_KEY_RECON_THRESHOLD) {
    for (const name of reconNames) {
      const dedup = `recon:${name}`
      if (!seen.has(dedup)) {
        seen.add(dedup)
        hits.push({ kind: name, source: 'env_key_recon' })
      }
    }
  }

  return hits
}

function findReconEnvKeys(text: string): string[] {
  const out: string[] = []
  for (const [name, pattern] of ENV_KEY_RECON_MATCHERS) {
    if (pattern.test(text)) out.push(name)
  }
  return out
}

export function checkOutboundSecretGuard(options: {
  tool: string
  args: Record<string, unknown>
  env?: NodeJS.ProcessEnv
}): SecurityBlock | undefined {
  const { tool, args } = options
  const env = options.env ?? process.env
  for (const value of outboundTexts(tool, args)) {
    const matches = findOutboundSecrets(value, env)
    if (matches.length === 0) continue

    const summary = matches.map(renderMatch).join(', ')
    const reconOnly = matches.every((m) => m.source === 'env_key_recon')
    const lead = reconOnly
      ? `Guard \`${GUARD_OUTBOUND_SECRET}\` blocked ${tool}: outbound text lists ${matches.length} known sensitive env-var names (${summary}) - this is a recon-shaped leak even with values masked.`
      : `Guard \`${GUARD_OUTBOUND_SECRET}\` blocked ${tool}: outbound text contains likely credentials (${summary}).`
    return {
      block: true,
      reason: [
        lead,
        'Posting secrets - or even the names of which secrets exist - to a channel persists them in chat history and exposes them to every reader.',
        'Intentional disclosure requires an operator-configured security bypass permission.',
      ].join(' '),
    }
  }
  return undefined
}

function renderMatch(m: OutboundSecretMatch): string {
  if (m.source === 'process_env') return `process.env.${m.kind}`
  if (m.source === 'env_key_recon') return `${m.kind} (env-key recon)`
  return m.kind
}
