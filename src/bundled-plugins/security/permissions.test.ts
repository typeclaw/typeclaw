import { describe, expect, test } from 'bun:test'

import { HIGH_TIER_PER_GUARD_PERMISSIONS, SECURITY_PERMISSIONS, SEVERITY_PERMISSION } from './permissions'
import { GUARD_CRON_PROMOTION_SEVERITY } from './policies/cron-promotion'
import { GUARD_GIT_EXFIL_SEVERITY, GUARD_GIT_REMOTE_TAINTED_SEVERITY } from './policies/git-exfil'
import { GUARD_NOTICE_TARGET_SEVERITY } from './policies/notice-target'
import { GUARD_OUTBOUND_SECRET_SEVERITY } from './policies/outbound-secret-scan'
import { GUARD_PLUGIN_ADDITION_SEVERITY } from './policies/plugin-addition'
import { GUARD_ROLE_PROMOTION_SEVERITY } from './policies/role-promotion'
import { GUARD_SECRET_EXFIL_BASH_SEVERITY } from './policies/secret-exfil-bash'
import { GUARD_SECRET_EXFIL_READ_SEVERITY } from './policies/secret-exfil-read'
import { GUARD_SESSION_SEARCH_SECRETS_SEVERITY } from './policies/session-search-secrets'
import { GUARD_SSRF_SEVERITY } from './policies/ssrf'
import { GUARD_SYSTEM_PROMPT_LEAK_SEVERITY } from './policies/system-prompt-leak'

describe('security tier surface', () => {
  test('SEVERITY_PERMISSION maps each tier to a distinct dotted string', () => {
    const values = Object.values(SEVERITY_PERMISSION)
    expect(new Set(values).size).toBe(values.length)
    expect(SEVERITY_PERMISSION.low).toBe('security.bypass.low')
    expect(SEVERITY_PERMISSION.medium).toBe('security.bypass.medium')
    expect(SEVERITY_PERMISSION.high).toBe('security.bypass.high')
  })

  test('tier strings are present in SECURITY_PERMISSIONS so collectDeclaredPermissions picks them up', () => {
    const all = Object.values(SECURITY_PERMISSIONS)
    expect(all).toContain('security.bypass.low')
    expect(all).toContain('security.bypass.medium')
    expect(all).toContain('security.bypass.high')
  })

  test('HIGH_TIER_PER_GUARD_PERMISSIONS lists exactly the high-tier per-guard strings', () => {
    expect([...HIGH_TIER_PER_GUARD_PERMISSIONS].sort()).toEqual(
      [
        SECURITY_PERMISSIONS.bypassGitRemoteTainted,
        SECURITY_PERMISSIONS.bypassOutboundSecret,
        SECURITY_PERMISSIONS.bypassSystemPromptLeak,
      ].sort(),
    )
  })
})

describe('per-guard severity classification', () => {
  test('high-tier guards (audience-leak axis): outboundSecret, systemPromptLeak, gitRemoteTainted', () => {
    expect(GUARD_OUTBOUND_SECRET_SEVERITY).toBe('high')
    expect(GUARD_SYSTEM_PROMPT_LEAK_SEVERITY).toBe('high')
    expect(GUARD_GIT_REMOTE_TAINTED_SEVERITY).toBe('high')
  })

  test('medium-tier guards (silent-attack + operator-reviewable-state axes): secretExfilBash, secretExfilRead, ssrf, sessionSearchSecrets, gitExfil, rolePromotion, cronPromotion, pluginAddition, noticeTarget', () => {
    expect(GUARD_SECRET_EXFIL_BASH_SEVERITY).toBe('medium')
    expect(GUARD_SECRET_EXFIL_READ_SEVERITY).toBe('medium')
    expect(GUARD_SSRF_SEVERITY).toBe('medium')
    expect(GUARD_SESSION_SEARCH_SECRETS_SEVERITY).toBe('medium')
    expect(GUARD_GIT_EXFIL_SEVERITY).toBe('medium')
    expect(GUARD_ROLE_PROMOTION_SEVERITY).toBe('medium')
    expect(GUARD_CRON_PROMOTION_SEVERITY).toBe('medium')
    expect(GUARD_PLUGIN_ADDITION_SEVERITY).toBe('medium')
    expect(GUARD_NOTICE_TARGET_SEVERITY).toBe('medium')
  })

  test('no guards are classified low today (tier reserved for noisy, immediately-recoverable side effects)', () => {
    const severities = [
      GUARD_GIT_EXFIL_SEVERITY,
      GUARD_GIT_REMOTE_TAINTED_SEVERITY,
      GUARD_SECRET_EXFIL_BASH_SEVERITY,
      GUARD_SECRET_EXFIL_READ_SEVERITY,
      GUARD_SSRF_SEVERITY,
      GUARD_OUTBOUND_SECRET_SEVERITY,
      GUARD_SYSTEM_PROMPT_LEAK_SEVERITY,
      GUARD_SESSION_SEARCH_SECRETS_SEVERITY,
      GUARD_ROLE_PROMOTION_SEVERITY,
      GUARD_CRON_PROMOTION_SEVERITY,
      GUARD_PLUGIN_ADDITION_SEVERITY,
    ]
    expect(severities.filter((s) => s === 'low')).toEqual([])
  })

  test('high-tier per-guard exports are exactly the entries in HIGH_TIER_PER_GUARD_PERMISSIONS (drift guard)', () => {
    const highTierGuardSeverities = [
      { perm: SECURITY_PERMISSIONS.bypassGitRemoteTainted, sev: GUARD_GIT_REMOTE_TAINTED_SEVERITY },
      { perm: SECURITY_PERMISSIONS.bypassOutboundSecret, sev: GUARD_OUTBOUND_SECRET_SEVERITY },
      { perm: SECURITY_PERMISSIONS.bypassSystemPromptLeak, sev: GUARD_SYSTEM_PROMPT_LEAK_SEVERITY },
    ]
    const declared = new Set(HIGH_TIER_PER_GUARD_PERMISSIONS)
    for (const { perm, sev } of highTierGuardSeverities) {
      expect(sev).toBe('high')
      expect(declared.has(perm)).toBe(true)
    }
    expect(declared.size).toBe(highTierGuardSeverities.length)
  })
})
