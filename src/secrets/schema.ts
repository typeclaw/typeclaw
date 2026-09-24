import { z } from 'zod'

import { secretFieldSchema } from './resolve'

// providers.<id> for api-key credentials: the `key` field is a Secret (string
// shorthand or `{ value?, env? }` object). CredentialStore resolves this at
// request time; OAuth credentials carry stateful refresh/access tokens and
// are never env-injectable.
const apiKeyProviderSchema = z.object({
  type: z.literal('api_key'),
  key: secretFieldSchema,
})

const oauthProviderSchema = z
  .object({
    type: z.literal('oauth'),
  })
  .catchall(z.unknown())

export const providerCredentialSchema = z.discriminatedUnion('type', [apiKeyProviderSchema, oauthProviderSchema])

export const providersSchema = z.record(z.string(), providerCredentialSchema)

export const mcpCredentialSchema = z
  .object({
    client: z.unknown().optional(),
    tokens: z.unknown().optional(),
    discovery: z.unknown().optional(),
  })
  .catchall(z.unknown())

export const mcpSliceSchema = z.record(z.string(), mcpCredentialSchema)

export const githubCliSecretsSchema = z.object({ hosts: z.string().min(1) }).strict()

// Per-adapter channel slots use named fields (`botToken`, `appToken`, `token`)
// instead of env-var-name keys. The Secret union per field carries the env-var
// override. Unknown adapter ids pass through via catchall so a future
// plugin-contributed adapter doesn't fail validation.
const slackBotChannelSchema = z.object({
  botToken: secretFieldSchema.optional(),
  appToken: secretFieldSchema.optional(),
})

const discordBotChannelSchema = z.object({
  token: secretFieldSchema.optional(),
})

export const discordAccountRecordSchema = z.object({
  account_id: z.string(),
  token: z.string(),
  username: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const discordChannelBlockSchema = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.record(z.string(), discordAccountRecordSchema),
})

const telegramBotChannelSchema = z.object({
  token: secretFieldSchema.optional(),
})

const githubPatAuthSchema = z.object({
  type: z.literal('pat'),
  token: secretFieldSchema,
})

const githubAppAuthSchema = z.object({
  type: z.literal('app'),
  appId: z.number().int().positive(),
  privateKey: secretFieldSchema,
})

const githubChannelSchema = z.object({
  auth: z.discriminatedUnion('type', [githubPatAuthSchema, githubAppAuthSchema]),
  webhookSecret: secretFieldSchema,
})

const lineDeviceSchema = z.enum(['DESKTOPWIN', 'DESKTOPMAC', 'ANDROID', 'ANDROIDSECONDARY', 'IOS', 'IOSIPAD'])

// LINE persists a long-lived auth token (+ optional certificate that lets a
// later re-login skip the e-mail/PIN step on the same device). There is no
// encrypted-password / renewal-cron path the way KakaoTalk has — LINE tokens
// don't expire on a fixed short schedule, so the renewal fields are absent by
// design.
export const lineAccountRecordSchema = z.object({
  account_id: z.string(),
  auth_token: z.string(),
  certificate: z.string().optional(),
  device: lineDeviceSchema,
  display_name: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const lineChannelBlockSchema = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.record(z.string(), lineAccountRecordSchema),
})

export const instagramAccountRecordSchema = z.object({
  account_id: z.string(),
  username: z.string(),
  full_name: z.string().optional(),
  profile_pic_url: z.string().optional(),
  pk: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const instagramChannelBlockSchema = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.record(z.string(), instagramAccountRecordSchema),
})

// Encrypted password envelope produced by src/secrets/encryption.ts. Optional
// in the schema because legacy v2 accounts (pre-renewal feature) don't have
// one; the renewal cron treats a missing envelope as "reauth required" and
// degrades to logged warnings rather than crashing.
const kakaoEncryptedPasswordSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal('AES-256-GCM'),
    kid: z.string(),
    iv: z.string(),
    ciphertext: z.string(),
    authTag: z.string(),
    createdAt: z.string(),
  })
  .strict()

export const webexEncryptedPasswordSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal('AES-256-GCM'),
    kid: z.string(),
    iv: z.string(),
    ciphertext: z.string(),
    authTag: z.string(),
    createdAt: z.string(),
  })
  .strict()

export const kakaoAccountRecordSchema = z.object({
  account_id: z.string(),
  oauth_token: z.string(),
  user_id: z.string(),
  refresh_token: z.string().optional(),
  device_uuid: z.string(),
  device_type: z.union([z.literal('pc'), z.literal('tablet')]),
  auth_method: z.union([z.literal('login'), z.literal('extract')]).optional(),
  created_at: z.string(),
  updated_at: z.string(),
  // Renewal-feature additions. Both optional to preserve compatibility with
  // legacy accounts; renewal degrades to "reauth required" when either is
  // absent. See src/secrets/kakao-renewal.ts.
  email: z.string().optional(),
  encryptedPassword: kakaoEncryptedPasswordSchema.optional(),
})

export type KakaoEncryptedPassword = z.infer<typeof kakaoEncryptedPasswordSchema>

export const webexAccountRecordSchema = z.object({
  account_id: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),
  device_url: z.string().optional(),
  user_id: z.string().optional(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  email: z.string().optional(),
  encryptedPassword: webexEncryptedPasswordSchema.optional(),
})

export const webexChannelBlockSchema = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.record(z.string(), webexAccountRecordSchema),
})

const teamsAccountTypeSchema = z.union([z.literal('work'), z.literal('personal')])
export type TeamsAccountType = z.infer<typeof teamsAccountTypeSchema>
const teamsRegionSchema = z.union([z.literal('amer'), z.literal('emea'), z.literal('apac')])

// Teams user-account credentials. The short-lived `access_token` expires in
// 60-90 minutes, so a long-running adapter relies on `aad_refresh_token` (+
// client/tenant ids from the device-code login) to silently re-mint it through
// the agent-messenger SDK. The refresh trio is optional so an extracted-token
// account still parses, but such an account degrades to "reauth required" once
// the access token lapses.
export const teamsAccountRecordSchema = z.object({
  account_id: z.string(),
  access_token: z.string(),
  token_expires_at: z.string().optional(),
  account_type: teamsAccountTypeSchema,
  region: teamsRegionSchema.optional(),
  user_name: z.string().optional(),
  aad_refresh_token: z.string().optional(),
  aad_client_id: z.string().optional(),
  aad_tenant_id: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const teamsChannelBlockSchema = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.record(z.string(), teamsAccountRecordSchema),
})

export const slackAccountRecordSchema = z.object({
  account_id: z.string(),
  token: z.string(),
  cookie: z.string(),
  workspace_id: z.string(),
  workspace_name: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
})

export const slackChannelBlockSchema = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.record(z.string(), slackAccountRecordSchema),
})

export const kakaoPendingLoginRecordSchema = z.object({
  device_uuid: z.string(),
  device_type: z.union([z.literal('pc'), z.literal('tablet')]),
  email: z.string(),
  created_at: z.string(),
})

export const kakaoChannelBlockSchema = z.object({
  currentAccount: z.string().nullable(),
  accounts: z.record(z.string(), kakaoAccountRecordSchema),
  pendingLogin: kakaoPendingLoginRecordSchema.optional(),
})

export const channelsSchema = z
  .object({
    'slack-bot': slackBotChannelSchema.optional(),
    discord: discordChannelBlockSchema.optional(),
    'discord-bot': discordBotChannelSchema.optional(),
    github: githubChannelSchema.optional(),
    'telegram-bot': telegramBotChannelSchema.optional(),
    line: lineChannelBlockSchema.optional(),
    instagram: instagramChannelBlockSchema.optional(),
    kakaotalk: kakaoChannelBlockSchema.optional(),
    webex: webexChannelBlockSchema.optional(),
    teams: teamsChannelBlockSchema.optional(),
    slack: slackChannelBlockSchema.optional(),
  })
  .catchall(z.unknown())

// version 2 = providers.* with Secret-typed api-key.key + per-adapter
// channel field shapes.
export const SECRETS_FILE_VERSION = 2

export const secretsFileSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(SECRETS_FILE_VERSION),
    providers: providersSchema.default({}),
    channels: channelsSchema.default({}),
    mcp: mcpSliceSchema.default({}),
    githubCli: githubCliSecretsSchema.optional(),
  })
  .catchall(z.unknown())

export type ProviderCredential = z.infer<typeof providerCredentialSchema>
export type Providers = z.infer<typeof providersSchema>
export type McpCredential = z.infer<typeof mcpCredentialSchema>
export type McpSlice = z.infer<typeof mcpSliceSchema>
export type GithubCliSecrets = z.infer<typeof githubCliSecretsSchema>
export type Channels = z.infer<typeof channelsSchema>
export type GithubPatAuthBlock = z.infer<typeof githubPatAuthSchema>
export type GithubAppAuthBlock = z.infer<typeof githubAppAuthSchema>
export type GithubSecretsBlock = z.infer<typeof githubChannelSchema>
export type DiscordAccountRecord = z.infer<typeof discordAccountRecordSchema>
export type DiscordChannelBlock = z.infer<typeof discordChannelBlockSchema>
export type LineAccountRecord = z.infer<typeof lineAccountRecordSchema>
export type LineChannelBlock = z.infer<typeof lineChannelBlockSchema>
export type InstagramAccountRecord = z.infer<typeof instagramAccountRecordSchema>
export type InstagramChannelBlock = z.infer<typeof instagramChannelBlockSchema>
export type KakaoAccountRecord = z.infer<typeof kakaoAccountRecordSchema>
export type PendingLoginRecord = z.infer<typeof kakaoPendingLoginRecordSchema>
export type KakaoChannelBlock = z.infer<typeof kakaoChannelBlockSchema>
export type WebexAccountRecord = z.infer<typeof webexAccountRecordSchema>
export type WebexChannelBlock = z.infer<typeof webexChannelBlockSchema>
export type WebexEncryptedPassword = z.infer<typeof webexEncryptedPasswordSchema>
export type TeamsAccountRecord = z.infer<typeof teamsAccountRecordSchema>
export type TeamsChannelBlock = z.infer<typeof teamsChannelBlockSchema>
export type SlackAccountRecord = z.infer<typeof slackAccountRecordSchema>
export type SlackChannelBlock = z.infer<typeof slackChannelBlockSchema>
export type SecretsFile = z.infer<typeof secretsFileSchema>

export type ParseSecretsResult = { ok: true; file: SecretsFile } | { ok: false; reason: string }

// parseSecretsFile accepts only the current v2 envelope:
// { version: 2, providers, channels }.
export function parseSecretsFile(raw: unknown): ParseSecretsResult {
  const v2 = secretsFileSchema.safeParse(raw)
  if (v2.success) return { ok: true, file: v2.data }

  return { ok: false, reason: v2.error.issues.map(formatIssue).join('; ') }
}

function formatIssue(issue: { path: PropertyKey[]; message: string }): string {
  const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>'
  return `${path}: ${issue.message}`
}
