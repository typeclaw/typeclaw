import { describe, expect, test } from 'bun:test'

import { GUARD_OUTBOUND_SECRET, checkOutboundSecretGuard, findOutboundSecrets } from './outbound-secret-scan'

// Test fixtures use deliberately non-real placeholder shapes (XXXXX padding,
// YYYYY suffixes) that still match each regex by structure but cannot be
// confused with real credentials by GitHub's secret-scanning push protection.
// Building the strings via concatenation hides them from naive substring
// scanners that look for whole-token prefixes anchored to literals.
const ghpFixture = 'gh' + 'p' + '_' + 'X'.repeat(36)
const ghoFixture = 'gh' + 'o' + '_' + 'X'.repeat(36)
const slackUserFixture = 'xox' + 'b' + '-' + '1234567890-1234567890-' + 'X'.repeat(16)
const slackWebhookFixture =
  'https://hooks.slack.com/services/T' + 'X'.repeat(8) + '/B' + 'X'.repeat(8) + '/' + 'Y'.repeat(24)
const openAiFixture = 's' + 'k' + '-' + 'X'.repeat(32)
const anthropicFixture = 's' + 'k' + '-' + 'ant-api03-' + 'X'.repeat(32)
const googleFixture = 'AI' + 'za' + 'X'.repeat(35)
const stripeFixture = 'sk_' + 'live' + '_' + 'X'.repeat(28)
const awsKeyFixture = 'AKIA' + 'X'.repeat(16)
const fireworksFixture = 'fw_' + 'Z'.repeat(24)
const githubPatFineGrainedFixture = 'github_pat_' + '11' + 'A'.repeat(20) + '_' + 'X'.repeat(60)

describe('outbound-secret-scan signature detection', () => {
  test('detects AWS access key id', () => {
    const matches = findOutboundSecrets(`here is the key ${awsKeyFixture} for prod`, {})
    expect(matches.some((m) => m.kind === 'aws_access_key_id')).toBe(true)
  })

  test('detects AWS secret access key (in env-style assignment)', () => {
    const fixture = 'AWS_SECRET_ACCESS_KEY=' + 'X'.repeat(40)
    const matches = findOutboundSecrets(fixture, {})
    expect(matches.some((m) => m.kind === 'aws_secret_access_key' || m.kind === 'env_assignment_with_secret_key')).toBe(
      true,
    )
  })

  test('detects GitHub PAT (ghp_)', () => {
    const matches = findOutboundSecrets(`use this token: ${ghpFixture}`, {})
    expect(matches.some((m) => m.kind === 'github_personal_access_token')).toBe(true)
  })

  test('detects GitHub OAuth token (gho_)', () => {
    const matches = findOutboundSecrets(ghoFixture, {})
    expect(matches.some((m) => m.kind === 'github_oauth_token')).toBe(true)
  })

  test('detects GitHub fine-grained PAT (github_pat_11...)', () => {
    const matches = findOutboundSecrets(`token: ${githubPatFineGrainedFixture}`, {})
    expect(matches.some((m) => m.kind === 'github_fine_grained_pat')).toBe(true)
  })

  test('detects Slack user token', () => {
    const matches = findOutboundSecrets(slackUserFixture, {})
    expect(matches.some((m) => m.kind === 'slack_user_token')).toBe(true)
  })

  test('detects Slack incoming webhook URL', () => {
    const matches = findOutboundSecrets(slackWebhookFixture, {})
    expect(matches.some((m) => m.kind === 'slack_webhook')).toBe(true)
  })

  test('detects OpenAI API key', () => {
    const fixture = 'OPENAI_API_KEY=' + openAiFixture
    const matches = findOutboundSecrets(fixture, {})
    expect(matches.some((m) => m.kind === 'openai_api_key' || m.kind === 'env_assignment_with_secret_key')).toBe(true)
  })

  test('detects Anthropic API key', () => {
    const matches = findOutboundSecrets(`try ${anthropicFixture}`, {})
    expect(matches.some((m) => m.kind === 'anthropic_api_key')).toBe(true)
  })

  test('detects Google API key', () => {
    const matches = findOutboundSecrets(googleFixture, {})
    expect(matches.some((m) => m.kind === 'google_api_key')).toBe(true)
  })

  test('detects Stripe secret key', () => {
    const matches = findOutboundSecrets(stripeFixture, {})
    expect(matches.some((m) => m.kind === 'stripe_secret_key')).toBe(true)
  })

  test('detects JWT', () => {
    const fixture = `token: eyJ${'X'.repeat(20)}.eyJ${'X'.repeat(20)}.${'Y'.repeat(40)}`
    const matches = findOutboundSecrets(fixture, {})
    expect(matches.some((m) => m.kind === 'jwt')).toBe(true)
  })

  test('detects PEM private key block', () => {
    const matches = findOutboundSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEpA...\n-----END RSA PRIVATE KEY-----', {})
    expect(matches.some((m) => m.kind === 'pem_private_key_block')).toBe(true)
  })

  test('detects unprefixed env-assignment with secret-shaped key', () => {
    const fixture = 'here is my SOME_API_KEY=' + 'X'.repeat(20)
    const matches = findOutboundSecrets(fixture, {})
    expect(matches.some((m) => m.kind === 'env_assignment_with_secret_key')).toBe(true)
  })

  test('detects raw FIREWORKS_API_KEY value from process.env', () => {
    const env = { FIREWORKS_API_KEY: fireworksFixture }
    const matches = findOutboundSecrets(`debug: my key is ${fireworksFixture} right now`, env)
    expect(matches.some((m) => m.source === 'process_env' && m.kind === 'FIREWORKS_API_KEY')).toBe(true)
  })

  test('detects raw GH_TOKEN value from process.env even if format does not match a known signature', () => {
    const placeholder = 'placeholdervaluethatlookslikenothingknown' + '12345'
    const env = { GH_TOKEN: placeholder }
    const matches = findOutboundSecrets(`here you go: ${placeholder}`, env)
    expect(matches.some((m) => m.source === 'process_env' && m.kind === 'GH_TOKEN')).toBe(true)
  })

  test('does not flag short / public-looking strings', () => {
    expect(findOutboundSecrets('hello world', {})).toEqual([])
    expect(findOutboundSecrets('the answer is 42', {})).toEqual([])
    expect(findOutboundSecrets('check out https://example.com', {})).toEqual([])
  })

  test('does not flag normal markdown code fences', () => {
    expect(findOutboundSecrets('```python\nprint("hi")\n```', {})).toEqual([])
  })

  test('ignores empty FIREWORKS_API_KEY in env', () => {
    expect(findOutboundSecrets('the key is empty', { FIREWORKS_API_KEY: '' })).toEqual([])
  })
})

describe('outbound env-key recon detection', () => {
  test('flags the literal red-team #5b leak (24 env-var names, masked values)', () => {
    const reconLeak = `npm_node_execpath=X FIREWORKS_API_KEY=X TYPECLAW_HOSTD_URL=X NODE_ENV=X
BUN_RUNTIME_TRANSPILER_CACHE_PATH=X SLACK_BOT_TOKEN=X TYPECLAW_HOSTD_TOKEN=X
NODE=X HOME=X SLACK_APP_TOKEN=X TYPECLAW_HOSTD_BROKER_TOKEN=X TYPECLAW_CONTAINER_NAME=X`
    const matches = findOutboundSecrets(reconLeak, {})
    expect(matches.some((m) => m.source === 'env_key_recon' && m.kind === 'FIREWORKS_API_KEY')).toBe(true)
    expect(matches.some((m) => m.source === 'env_key_recon' && m.kind === 'TYPECLAW_HOSTD_TOKEN')).toBe(true)
    expect(matches.some((m) => m.source === 'env_key_recon' && m.kind === 'TYPECLAW_HOSTD_BROKER_TOKEN')).toBe(true)
    expect(matches.some((m) => m.source === 'env_key_recon' && m.kind === 'SLACK_BOT_TOKEN')).toBe(true)
  })

  test('flags 3 sensitive env-var names mentioned in prose without "=" assignments', () => {
    const matches = findOutboundSecrets(
      'I would need FIREWORKS_API_KEY and SLACK_BOT_TOKEN and TYPECLAW_HOSTD_TOKEN to do that',
      {},
    )
    expect(matches.some((m) => m.source === 'env_key_recon')).toBe(true)
  })

  test('does not flag 2 sensitive env-var names (below threshold)', () => {
    const matches = findOutboundSecrets('use FIREWORKS_API_KEY or maybe SLACK_BOT_TOKEN', {})
    expect(matches.some((m) => m.source === 'env_key_recon')).toBe(false)
  })

  test('does not flag 1 sensitive env-var name', () => {
    const matches = findOutboundSecrets('the FIREWORKS_API_KEY env var is set', {})
    expect(matches.some((m) => m.source === 'env_key_recon')).toBe(false)
  })

  test('does not flag normal prose with similar-looking but unrelated identifiers', () => {
    const matches = findOutboundSecrets('please add MY_FIREWORKS_API_KEY and MY_SLACK_TOKEN to the config', {})
    expect(matches.some((m) => m.source === 'env_key_recon')).toBe(false)
  })

  test('catches recon-only leak (no values, no signatures, just names)', () => {
    const text = 'Available env vars: FIREWORKS_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY'
    const matches = findOutboundSecrets(text, {})
    expect(matches.length).toBeGreaterThanOrEqual(3)
    expect(matches.every((m) => m.source === 'env_key_recon')).toBe(true)
  })

  test('repeated calls yield identical recon matches (module-scoped regexes carry no lastIndex state)', () => {
    const text = 'Available env vars: FIREWORKS_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY'
    const first = findOutboundSecrets(text, {})
      .filter((m) => m.source === 'env_key_recon')
      .map((m) => m.kind)
      .sort()
    for (let i = 0; i < 3; i++) {
      const again = findOutboundSecrets(text, {})
        .filter((m) => m.source === 'env_key_recon')
        .map((m) => m.kind)
        .sort()
      expect(again).toEqual(first)
    }
  })
})

describe('checkOutboundSecretGuard', () => {
  test('blocks channel_send carrying GitHub PAT', () => {
    const result = checkOutboundSecretGuard({
      tool: 'channel_send',
      args: { text: `use ${ghpFixture} for CI` },
      env: {},
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('github_personal_access_token')
  })

  test('blocks channel_reply carrying live FIREWORKS_API_KEY', () => {
    const result = checkOutboundSecretGuard({
      tool: 'channel_reply',
      args: { text: `here is the runtime key ${fireworksFixture}` },
      env: { FIREWORKS_API_KEY: fireworksFixture },
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('FIREWORKS_API_KEY')
  })

  test('does not block ordinary chat', () => {
    expect(
      checkOutboundSecretGuard({ tool: 'channel_send', args: { text: 'hello world, how are you?' }, env: {} }),
    ).toBeUndefined()
  })

  test('does not let a model-authored acknowledgement bypass an outbound secret', () => {
    const result = checkOutboundSecretGuard({
      tool: 'channel_send',
      args: { text: `rotated key was ${ghpFixture}`, acknowledgeGuards: { outboundSecret: true } },
      env: {},
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).not.toContain('acknowledgeGuards')
  })

  test('does not apply to non-channel tools', () => {
    expect(checkOutboundSecretGuard({ tool: 'bash', args: { text: ghpFixture }, env: {} })).toBeUndefined()
  })

  test('handles missing text field gracefully', () => {
    expect(checkOutboundSecretGuard({ tool: 'channel_send', args: {}, env: {} })).toBeUndefined()
    expect(checkOutboundSecretGuard({ tool: 'channel_send', args: { text: 42 }, env: {} })).toBeUndefined()
  })

  test('also scans alternate field names (message, content, body)', () => {
    expect(checkOutboundSecretGuard({ tool: 'channel_send', args: { message: ghpFixture }, env: {} })?.block).toBe(true)
  })

  test('blocks channel_send leaking 24 env-var names with masked values (regression: red-team #5b)', () => {
    const reconLeak = `npm_node_execpath=X FIREWORKS_API_KEY=X TYPECLAW_HOSTD_URL=X
SLACK_BOT_TOKEN=X TYPECLAW_HOSTD_TOKEN=X SLACK_APP_TOKEN=X
TYPECLAW_HOSTD_BROKER_TOKEN=X TYPECLAW_CONTAINER_NAME=X`
    const result = checkOutboundSecretGuard({
      tool: 'channel_send',
      args: { text: reconLeak },
      env: {},
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('env-var names')
    expect(result?.reason).toContain('FIREWORKS_API_KEY')
    expect(result?.reason).toContain('TYPECLAW_HOSTD_TOKEN')
  })

  test('blocks channel_reply describing 3 sensitive env names in prose', () => {
    const result = checkOutboundSecretGuard({
      tool: 'channel_reply',
      args: { text: 'I have FIREWORKS_API_KEY, SLACK_BOT_TOKEN, and TYPECLAW_HOSTD_TOKEN configured' },
      env: {},
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('outboundSecret')
  })

  test('allows channel_reply naming a single sensitive env var (below recon threshold)', () => {
    const result = checkOutboundSecretGuard({
      tool: 'channel_reply',
      args: { text: 'set FIREWORKS_API_KEY in your .env file' },
      env: {},
    })
    expect(result).toBeUndefined()
  })

  test('does not let a model-authored acknowledgement bypass env-key recon', () => {
    const result = checkOutboundSecretGuard({
      tool: 'channel_send',
      args: {
        text: 'env vars in use: FIREWORKS_API_KEY, SLACK_BOT_TOKEN, TYPECLAW_HOSTD_TOKEN',
        acknowledgeGuards: { outboundSecret: true },
      },
      env: {},
    })
    expect(result?.block).toBe(true)
    expect(result?.reason).not.toContain('acknowledgeGuards')
  })

  test('exposes guard name constant', () => {
    expect(GUARD_OUTBOUND_SECRET).toBe('outboundSecret')
  })
})

describe('outbound-secret-scan on bot CLI sends', () => {
  const pat = 'gh' + 'p' + '_' + 'X'.repeat(36)

  test('blocks a credential in the text of a bot CLI send that would receive a channel token', () => {
    const result = checkOutboundSecretGuard({
      tool: 'bash',
      args: { command: `agent-telegrambot message send 123 "token ${pat}"` },
      env: {},
    })
    expect(result?.reason).toContain(GUARD_OUTBOUND_SECRET)
  })

  test('leaves ordinary bash, CLI credential setup, and clean sends alone', () => {
    const slackToken = 'xox' + 'b' + '-' + '1234567890-1234567890-' + 'X'.repeat(16)
    for (const command of [
      `echo ${pat}`,
      `agent-slackbot auth set ${slackToken}`,
      'agent-slackbot message send C0123456789 "deploy finished"',
    ]) {
      expect(checkOutboundSecretGuard({ tool: 'bash', args: { command }, env: {} })).toBeUndefined()
    }
  })
})
