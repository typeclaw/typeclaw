import { describe, expect, test } from 'bun:test'

import { parseDockerPortOutput, resolveHostPort, resolveTuiToken } from './docker-discovery'

describe('parseDockerPortOutput', () => {
  test('prefers the IPv4 mapping over IPv6', () => {
    expect(parseDockerPortOutput('0.0.0.0:49160\n:::49160\n')).toBe(49160)
  })

  test('falls back to the first line when no IPv4 mapping exists', () => {
    expect(parseDockerPortOutput('[::]:8080\n')).toBe(8080)
  })

  test('returns null on empty output', () => {
    expect(parseDockerPortOutput('')).toBeNull()
    expect(parseDockerPortOutput('\n  \n')).toBeNull()
  })

  test('returns null on an out-of-range port', () => {
    expect(parseDockerPortOutput('0.0.0.0:99999')).toBeNull()
  })
})

describe('resolveHostPort', () => {
  test('parses the host port from a successful docker port call', async () => {
    const exec = async () => ({ stdout: '0.0.0.0:49160\n:::49160\n', exitCode: 0 })
    expect(await resolveHostPort('agent', exec)).toBe(49160)
  })

  test('throws when the container is not running', async () => {
    const exec = async () => ({ stdout: '', exitCode: 1 })
    await expect(resolveHostPort('agent', exec)).rejects.toThrow('not running')
  })
})

describe('resolveTuiToken', () => {
  test('returns the trimmed token label', async () => {
    const exec = async () => ({ stdout: 'secret-token\n', exitCode: 0 })
    expect(await resolveTuiToken('agent', exec)).toBe('secret-token')
  })

  test('throws when the label is absent', async () => {
    const exec = async () => ({ stdout: '<no value>\n', exitCode: 0 })
    await expect(resolveTuiToken('agent', exec)).rejects.toThrow('no TUI token')
  })
})
