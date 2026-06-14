import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  detectGithubChannelAuthState,
  getGithubChannelAuthState,
  resetGithubChannelAuthStateCacheForTests,
} from './channel-misconfig'

function agentDirWith(files: { typeclawJson?: string; secretsJson?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'typeclaw-misconfig-unit-'))
  if (files.typeclawJson !== undefined) writeFileSync(join(dir, 'typeclaw.json'), files.typeclawJson)
  if (files.secretsJson !== undefined) writeFileSync(join(dir, 'secrets.json'), files.secretsJson)
  return dir
}

const githubChannel = JSON.stringify({ channels: { github: { repos: ['o/r'] } } })

afterEach(() => resetGithubChannelAuthStateCacheForTests())

describe('detectGithubChannelAuthState', () => {
  it('returns not-configured when typeclaw.json is absent', () => {
    expect(detectGithubChannelAuthState(agentDirWith({}))).toBe('not-configured')
  })

  it('returns not-configured when channels.github is absent', () => {
    const dir = agentDirWith({ typeclawJson: JSON.stringify({ channels: { slack: {} } }) })
    expect(detectGithubChannelAuthState(dir)).toBe('not-configured')
  })

  it('returns configured-without-credentials when channel exists but no secrets.json', () => {
    expect(detectGithubChannelAuthState(agentDirWith({ typeclawJson: githubChannel }))).toBe(
      'configured-without-credentials',
    )
  })

  it('returns configured-without-credentials when secrets.json has no github auth', () => {
    const dir = agentDirWith({ typeclawJson: githubChannel, secretsJson: JSON.stringify({ version: 2, channels: {} }) })
    expect(detectGithubChannelAuthState(dir)).toBe('configured-without-credentials')
  })

  it('returns configured-with-credentials for a valid PAT auth block', () => {
    const dir = agentDirWith({
      typeclawJson: githubChannel,
      secretsJson: JSON.stringify({
        version: 2,
        channels: { github: { auth: { type: 'pat', token: 'ghp_x' }, webhookSecret: 'whsec_x' } },
      }),
    })
    expect(detectGithubChannelAuthState(dir)).toBe('configured-with-credentials')
  })

  it('returns configured-with-credentials for a valid App auth block', () => {
    const dir = agentDirWith({
      typeclawJson: githubChannel,
      secretsJson: JSON.stringify({
        version: 2,
        channels: { github: { auth: { type: 'app', appId: 1, privateKey: 'x' }, webhookSecret: 'whsec_x' } },
      }),
    })
    expect(detectGithubChannelAuthState(dir)).toBe('configured-with-credentials')
  })

  it('returns indeterminate when the github block is present but schema-invalid (missing webhookSecret)', () => {
    const dir = agentDirWith({
      typeclawJson: githubChannel,
      secretsJson: JSON.stringify({ version: 2, channels: { github: { auth: { type: 'pat', token: 'ghp_x' } } } }),
    })
    expect(detectGithubChannelAuthState(dir)).toBe('indeterminate')
  })

  it('returns indeterminate when secrets.json is malformed', () => {
    const dir = agentDirWith({ typeclawJson: githubChannel, secretsJson: '{ broken' })
    expect(detectGithubChannelAuthState(dir)).toBe('indeterminate')
  })

  it('returns not-configured when typeclaw.json is malformed (cannot confirm a github channel)', () => {
    expect(detectGithubChannelAuthState(agentDirWith({ typeclawJson: '{ broken' }))).toBe('not-configured')
  })
})

describe('getGithubChannelAuthState (memoized)', () => {
  it('caches the first computed state per agentDir', () => {
    const dir = agentDirWith({ typeclawJson: githubChannel })
    expect(getGithubChannelAuthState(dir)).toBe('configured-without-credentials')
    // Adding creds after the first read must NOT change the memoized answer.
    writeFileSync(
      join(dir, 'secrets.json'),
      JSON.stringify({ version: 2, channels: { github: { auth: { type: 'pat', token: 'ghp_x' } } } }),
    )
    expect(getGithubChannelAuthState(dir)).toBe('configured-without-credentials')
  })
})
