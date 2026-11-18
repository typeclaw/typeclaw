export type SecuritySeverity = 'low' | 'medium' | 'high'

export const SECURITY_PERMISSIONS = {
  bypassSecretExfilBash: 'security.bypass.secretExfilBash',
  bypassGitExfil: 'security.bypass.gitExfil',
  bypassSecretExfilRead: 'security.bypass.secretExfilRead',
  bypassSsrf: 'security.bypass.ssrf',
  bypassSessionSearchSecrets: 'security.bypass.sessionSearchSecrets',
  bypassSystemPromptLeak: 'security.bypass.systemPromptLeak',
  bypassOutboundSecret: 'security.bypass.outboundSecret',
  bypassGitRemoteTainted: 'security.bypass.gitRemoteTainted',
  bypassRolePromotion: 'security.bypass.rolePromotion',
  bypassCronPromotion: 'security.bypass.cronPromotion',
  bypassPluginAddition: 'security.bypass.pluginAddition',
  bypassNoticeTarget: 'security.bypass.noticeTarget',
  // Severity-tier bypasses. Tiers classify guards on a two-axis policy:
  //   high   — bypass sends data to a third-party audience outside the
  //            operator's control loop (channel readers, remote git host).
  //            NO role auto-bypasses; ack required from every role.
  //   medium — bypass produces silent attacker-favorable state in model
  //            context (env dump, .env contents, IAM creds, secret-shaped
  //            session-search hits). Owner bypasses, trusted does not.
  //   low    — bypass produces a noisy, immediately-recoverable side
  //            effect. Owner and trusted bypass. No inhabitants today.
  // Per-guard permissions above continue to work as explicit grants —
  // `tool.before` accepts EITHER the tier OR the per-guard string (OR
  // check). This lets operators knowingly re-open a single high-tier
  // guard for one role without widening the whole tier.
  bypassLow: 'security.bypass.low',
  bypassMedium: 'security.bypass.medium',
  bypassHigh: 'security.bypass.high',
} as const

export type SecurityPermission = (typeof SECURITY_PERMISSIONS)[keyof typeof SECURITY_PERMISSIONS]

export const SEVERITY_PERMISSION: Record<SecuritySeverity, string> = {
  low: SECURITY_PERMISSIONS.bypassLow,
  medium: SECURITY_PERMISSIONS.bypassMedium,
  high: SECURITY_PERMISSIONS.bypassHigh,
}

// Per-guard permission strings whose guards are classified `high`.
// Plumbed through to the owner-wildcard expander's `ownerWildcardExclusions`
// parameter at boot; the bundled security plugin currently passes `[]` so
// owner DOES auto-bypass every high-tier per-guard string, but third-party
// plugins (or a future tightening of the bundled defaults) can use this
// constant to exclude high-tier strings from the wildcard expansion.
// Keep this list in sync with the `'high'` classifications in
// `policies/*.ts` — the drift-guard test in `permissions.test.ts` will
// fail if a guard's severity constant disagrees with its membership here.
export const HIGH_TIER_PER_GUARD_PERMISSIONS: readonly string[] = [
  SECURITY_PERMISSIONS.bypassGitRemoteTainted,
  SECURITY_PERMISSIONS.bypassOutboundSecret,
  SECURITY_PERMISSIONS.bypassSystemPromptLeak,
]
