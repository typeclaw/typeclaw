import { describe, expect, test } from 'bun:test'

import { isSecretEnvName, resolveExposableEnvNames } from './env-exposure'

describe('resolveExposableEnvNames', () => {
  test('exposes a recognized safe config pointer declared in .env', () => {
    const names = resolveExposableEnvNames(['AGENT_MESSENGER_CONFIG_DIR'], {
      AGENT_MESSENGER_CONFIG_DIR: '/agent/workspace/.config/agent-messenger',
    })
    expect(names).toEqual(['AGENT_MESSENGER_CONFIG_DIR'])
  })

  test('does NOT expose an arbitrary non-secret .env var (allowlist, not denylist)', () => {
    // .env is a documented credential store; DATABASE_URL is a real credential
    // that must NOT reach model bash just because its name is not secret-shaped.
    const names = resolveExposableEnvNames(['DATABASE_URL', 'MY_TOOL_HOME'], {
      DATABASE_URL: 'postgres://u:p@host/db',
      MY_TOOL_HOME: '/y',
    })
    expect(names).toEqual([])
  })

  test('exposes an operator-allowed name via sandbox.env.allow', () => {
    const names = resolveExposableEnvNames(['MY_TOOL_HOME'], { MY_TOOL_HOME: '/y' }, ['MY_TOOL_HOME'])
    expect(names).toEqual(['MY_TOOL_HOME'])
  })

  test('withholds a secret-named var even if the operator allows it (deny wins)', () => {
    const names = resolveExposableEnvNames(['MY_SERVICE_TOKEN'], { MY_SERVICE_TOKEN: 'sk-x' }, ['MY_SERVICE_TOKEN'])
    expect(names).toEqual([])
  })

  test('withholds known provider api keys even when operator-allowed', () => {
    const names = resolveExposableEnvNames(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'], {
      OPENAI_API_KEY: 'sk-x',
      ANTHROPIC_API_KEY: 'sk-y',
    })
    expect(names).toEqual([])
  })

  test('withholds sandbox-owned defaults even if operator-allowed', () => {
    const names = resolveExposableEnvNames(
      ['PATH', 'HOME', 'BUN_TMPDIR', 'BUN_INSTALL', 'LANG'],
      {
        PATH: '/evil/bin',
        HOME: '/evil',
        BUN_TMPDIR: '/evil',
        BUN_INSTALL: '/evil',
        LANG: 'x',
      },
      ['PATH', 'HOME', 'BUN_TMPDIR', 'BUN_INSTALL', 'LANG'],
    )
    expect(names).toEqual([])
  })

  test('withholds process-hijack env vars even if operator-allowed', () => {
    const names = resolveExposableEnvNames(
      ['LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'GIT_CONFIG_GLOBAL'],
      { LD_PRELOAD: '/x.so', NODE_OPTIONS: '--require /x', BASH_ENV: '/x', GIT_CONFIG_GLOBAL: '/x' },
      ['LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'GIT_CONFIG_GLOBAL'],
    )
    expect(names).toEqual([])
  })

  test('only exposes names DECLARED in .env, never hydrated process.env secrets', () => {
    // given a channel token hydrated into process.env from secrets.json but NOT in .env
    const containerEnv = {
      AGENT_MESSENGER_CONFIG_DIR: '/agent/workspace/.config/agent-messenger',
      DISCORD_BOT_TOKEN: 'hydrated-from-secrets-json',
    }
    // when only the config pointer is declared in .env
    const names = resolveExposableEnvNames(['AGENT_MESSENGER_CONFIG_DIR'], containerEnv)
    // then the hydrated token never surfaces
    expect(names).toEqual(['AGENT_MESSENGER_CONFIG_DIR'])
  })

  test('skips allowed names that are absent or empty in the container env', () => {
    const names = resolveExposableEnvNames(['AGENT_MESSENGER_CONFIG_DIR', 'GWS_CONFIG_HOME'], { GWS_CONFIG_HOME: '' })
    expect(names).toEqual([])
  })

  test('withholds configured MCP/tunnel secret env names even if operator-allowed', () => {
    const names = resolveExposableEnvNames(
      ['MY_MCP_KEY', 'AGENT_MESSENGER_CONFIG_DIR'],
      { MY_MCP_KEY: 'a', AGENT_MESSENGER_CONFIG_DIR: '/x' },
      ['MY_MCP_KEY'],
      ['MY_MCP_KEY'],
    )
    expect(names).toEqual(['AGENT_MESSENGER_CONFIG_DIR'])
  })

  test('deduplicates repeated declared names', () => {
    const names = resolveExposableEnvNames(['AGENT_MESSENGER_CONFIG_DIR', 'AGENT_MESSENGER_CONFIG_DIR'], {
      AGENT_MESSENGER_CONFIG_DIR: '/x',
    })
    expect(names).toEqual(['AGENT_MESSENGER_CONFIG_DIR'])
  })
})

describe('isSecretEnvName', () => {
  test('matches known and pattern-based secret names case-insensitively', () => {
    expect(isSecretEnvName('OPENAI_API_KEY')).toBe(true)
    expect(isSecretEnvName('GH_TOKEN')).toBe(true)
    expect(isSecretEnvName('my_token')).toBe(true)
    expect(isSecretEnvName('SESSION_COOKIE')).toBe(true)
    expect(isSecretEnvName('AGENT_MESSENGER_CONFIG_DIR')).toBe(false)
  })
})
