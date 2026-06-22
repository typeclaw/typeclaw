import { describe, expect, test } from 'bun:test'

import { BUILTIN_ROLE_NAMES, BUILTIN_ROLES, OWNER_SECURITY_WILDCARD, expandOwnerWildcard } from './builtins'

describe('built-in role contract (role-tower model: owner=high, trusted=medium, member=low, guest=none)', () => {
  test('has exactly the four documented names in declaration order', () => {
    expect(BUILTIN_ROLE_NAMES).toEqual(['owner', 'trusted', 'member', 'guest'])
  })

  test('owner pre-expansion: tui match, core perms, all three tier strings (low/medium/high), wildcard sentinel', () => {
    expect(BUILTIN_ROLES.owner.match).toEqual([{ kind: 'tui' }])
    expect(BUILTIN_ROLES.owner.permissions).toContain(OWNER_SECURITY_WILDCARD)
    expect(BUILTIN_ROLES.owner.permissions).toContain('channel.respond')
    expect(BUILTIN_ROLES.owner.permissions).toContain('cron.schedule')
    expect(BUILTIN_ROLES.owner.permissions).toContain('cron.modify')
    expect(BUILTIN_ROLES.owner.permissions).toContain('security.bypass.low')
    expect(BUILTIN_ROLES.owner.permissions).toContain('security.bypass.medium')
    expect(BUILTIN_ROLES.owner.permissions).toContain('security.bypass.high')
  })

  test('owner carries all three subagent permissions (spawn / cancel / output) AND the write-capable subagent spawn permissions', () => {
    expect(BUILTIN_ROLES.owner.permissions).toContain('subagent.spawn')
    expect(BUILTIN_ROLES.owner.permissions).toContain('subagent.cancel')
    expect(BUILTIN_ROLES.owner.permissions).toContain('subagent.output')
    expect(BUILTIN_ROLES.owner.permissions).toContain('subagent.spawn.operator')
    expect(BUILTIN_ROLES.owner.permissions).toContain('subagent.spawn.deep')
  })

  test('trusted has empty default match and core perms + fs.see.private + fs.see.secrets + bypass.low + bypass.medium + subagent perms + operator-specific spawn', () => {
    expect(BUILTIN_ROLES.trusted.match).toEqual([])
    expect([...BUILTIN_ROLES.trusted.permissions].sort()).toEqual([
      'channel.respond',
      'cron.schedule',
      'fs.see.private',
      'fs.see.secrets',
      'security.bypass.low',
      'security.bypass.medium',
      'session.admin',
      'session.control',
      'subagent.cancel',
      'subagent.output',
      'subagent.spawn',
      'subagent.spawn.deep',
      'subagent.spawn.operator',
    ])
  })

  test('trusted does NOT carry bypass.high (high tier remains owner-only)', () => {
    expect([...BUILTIN_ROLES.trusted.permissions]).not.toContain('security.bypass.high')
  })

  test('member has empty default match and channel.respond + fs.see.private + bypass.low + subagent perms (no operator-specific spawn, no fs.see.secrets)', () => {
    expect(BUILTIN_ROLES.member.match).toEqual([])
    expect([...BUILTIN_ROLES.member.permissions].sort()).toEqual([
      'channel.respond',
      'fs.see.private',
      'security.bypass.low',
      'session.control',
      'subagent.cancel',
      'subagent.output',
      'subagent.spawn',
    ])
  })

  test('member carries fs.see.private but NOT fs.see.secrets (private working surface, never credentials)', () => {
    expect([...BUILTIN_ROLES.member.permissions]).toContain('fs.see.private')
    expect([...BUILTIN_ROLES.member.permissions]).not.toContain('fs.see.secrets')
  })

  test('guest carries neither fs.see grant (locked-down floor; bash sees neither private surface nor secrets)', () => {
    expect([...BUILTIN_ROLES.guest.permissions]).not.toContain('fs.see.private')
    expect([...BUILTIN_ROLES.guest.permissions]).not.toContain('fs.see.secrets')
  })

  test('session.control is owner+trusted+member but NOT guest (a respond-capable guest cannot /stop other turns)', () => {
    expect([...BUILTIN_ROLES.owner.permissions]).toContain('session.control')
    expect([...BUILTIN_ROLES.trusted.permissions]).toContain('session.control')
    expect([...BUILTIN_ROLES.member.permissions]).toContain('session.control')
    expect([...BUILTIN_ROLES.guest.permissions]).not.toContain('session.control')
  })

  test('session.admin is owner+trusted ONLY (member cannot /reload or /restart the container)', () => {
    expect([...BUILTIN_ROLES.owner.permissions]).toContain('session.admin')
    expect([...BUILTIN_ROLES.trusted.permissions]).toContain('session.admin')
    expect([...BUILTIN_ROLES.member.permissions]).not.toContain('session.admin')
    expect([...BUILTIN_ROLES.guest.permissions]).not.toContain('session.admin')
  })

  test('member does NOT carry the operator-specific spawn permission (write-capable subagents are owner+trusted only)', () => {
    expect([...BUILTIN_ROLES.member.permissions]).not.toContain('subagent.spawn.operator')
  })

  test('member does NOT carry the deep-specific spawn permission (write-capable subagents are owner+trusted only)', () => {
    expect([...BUILTIN_ROLES.member.permissions]).not.toContain('subagent.spawn.deep')
  })

  test('member does NOT carry bypass.medium or bypass.high (low tier only)', () => {
    expect([...BUILTIN_ROLES.member.permissions]).not.toContain('security.bypass.medium')
    expect([...BUILTIN_ROLES.member.permissions]).not.toContain('security.bypass.high')
  })

  test('guest has no match and no permissions', () => {
    expect(BUILTIN_ROLES.guest.match).toEqual([])
    expect([...BUILTIN_ROLES.guest.permissions]).toEqual([])
  })
})

describe('owner-wildcard runtime expansion (owner bypasses every tier including high)', () => {
  // The bundled security plugin's production wiring is `ownerWildcardExclusions: []`
  // under the role-tower model. This block asserts the wildcard expander does
  // the right thing with that production input.
  const PLUGIN_BYPASS_PERMS = [
    'security.bypass.secretExfilBash',
    'security.bypass.gitExfil',
    'security.bypass.secretExfilRead',
    'security.bypass.ssrf',
    'security.bypass.sessionSearchSecrets',
    'security.bypass.systemPromptLeak',
    'security.bypass.outboundSecret',
    'security.bypass.gitRemoteTainted',
    'security.bypass.rolePromotion',
    'security.bypass.cronPromotion',
    'security.bypass.low',
    'security.bypass.medium',
    'security.bypass.high',
  ]
  const NO_EXCLUSIONS: readonly string[] = []

  test('owner runtime perms include every plugin-contributed security.bypass.* (no exclusions in production)', () => {
    const expanded = expandOwnerWildcard(BUILTIN_ROLES.owner.permissions, PLUGIN_BYPASS_PERMS, NO_EXCLUSIONS)

    // Every per-guard string is present
    expect(expanded).toContain('security.bypass.secretExfilBash')
    expect(expanded).toContain('security.bypass.secretExfilRead')
    expect(expanded).toContain('security.bypass.ssrf')
    expect(expanded).toContain('security.bypass.sessionSearchSecrets')
    expect(expanded).toContain('security.bypass.gitExfil')
    expect(expanded).toContain('security.bypass.gitRemoteTainted')
    expect(expanded).toContain('security.bypass.outboundSecret')
    expect(expanded).toContain('security.bypass.systemPromptLeak')
    expect(expanded).toContain('security.bypass.rolePromotion')
    expect(expanded).toContain('security.bypass.cronPromotion')

    // Every tier string is present
    expect(expanded).toContain('security.bypass.low')
    expect(expanded).toContain('security.bypass.medium')
    expect(expanded).toContain('security.bypass.high')
  })

  test('third-party plugin opt-out: wildcardExclusions still excludes the named strings (parameter preserved for non-bundled plugins)', () => {
    const expanded = expandOwnerWildcard(BUILTIN_ROLES.owner.permissions, PLUGIN_BYPASS_PERMS, [
      'security.bypass.gitExfil',
    ])
    // The excluded string is dropped from the wildcard expansion. The
    // explicit tier strings on BUILTIN_ROLES.owner remain.
    expect(expanded).not.toContain('security.bypass.gitExfil')
    expect(expanded).toContain('security.bypass.high')
    expect(expanded).toContain('security.bypass.gitRemoteTainted')
  })

  test('operator override: explicit per-guard string in owner.permissions still flows through the non-sentinel branch', () => {
    // Even with exclusions, an explicit grant survives.
    const overridden = [...BUILTIN_ROLES.owner.permissions, 'security.bypass.gitExfil']
    const expanded = expandOwnerWildcard(overridden, PLUGIN_BYPASS_PERMS, ['security.bypass.gitExfil'])
    expect(expanded).toContain('security.bypass.gitExfil')
  })
})
