import { describe, expect, test } from 'bun:test'

import { GUARD_AGENT_BROWSER_SSRF, checkAgentBrowserSsrfGuard } from './agent-browser-ssrf'

function check(command: string, extra: Record<string, unknown> = {}) {
  return checkAgentBrowserSsrfGuard({ tool: 'bash', args: { command, ...extra } })
}

describe('agent-browser SSRF guard', () => {
  test('blocks the canonical home-router scenario (192.168.x.x)', () => {
    const result = check('agent-browser navigate http://192.168.0.1')
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('private_ipv4')
    expect(result?.reason).toContain(GUARD_AGENT_BROWSER_SSRF)
  })

  test('blocks bare-IP navigation without an http:// scheme', () => {
    expect(check('agent-browser navigate 192.168.0.1')?.block).toBe(true)
    expect(check('agent-browser navigate 10.0.0.1:8080/admin')?.block).toBe(true)
  })

  test('blocks loopback in every encoding the SSRF classifier knows', () => {
    expect(check('agent-browser navigate http://127.0.0.1/')?.block).toBe(true)
    expect(check('agent-browser navigate http://localhost/')?.block).toBe(true)
    expect(check('agent-browser navigate http://2130706433/')?.block).toBe(true)
    expect(check('agent-browser navigate http://0x7f000001/')?.block).toBe(true)
    expect(check('agent-browser navigate http://[::1]/')?.block).toBe(true)
  })

  test('blocks cloud metadata endpoints', () => {
    expect(check('agent-browser navigate http://169.254.169.254/latest/meta-data/iam/')?.block).toBe(true)
    expect(check('agent-browser navigate http://metadata.google.internal/computeMetadata/v1/')?.block).toBe(true)
  })

  test('blocks RFC1918 across 10/8 and 172.16/12', () => {
    expect(check('agent-browser navigate http://10.0.0.1')?.block).toBe(true)
    expect(check('agent-browser navigate http://172.20.1.1')?.block).toBe(true)
  })

  test('blocks reserved-suffix hostnames a curious agent might try', () => {
    expect(check('agent-browser navigate http://printer.local')?.block).toBe(true)
    expect(check('agent-browser navigate http://nas.home/files')?.block).toBe(true)
    expect(check('agent-browser navigate http://service.internal')?.block).toBe(true)
  })

  test('allows navigation to public sites', () => {
    expect(check('agent-browser navigate https://example.com')).toBeUndefined()
    expect(check('agent-browser navigate https://news.ycombinator.com')).toBeUndefined()
    expect(check('agent-browser navigate http://1.1.1.1')).toBeUndefined()
  })

  test('sees through single quotes, double quotes, and backticks', () => {
    expect(check(`agent-browser navigate 'http://192.168.0.1'`)?.block).toBe(true)
    expect(check(`agent-browser navigate "http://10.0.0.1"`)?.block).toBe(true)
    expect(check('agent-browser navigate `http://172.16.0.1`')?.block).toBe(true)
  })

  test('catches the URL when it hides later in a chained command', () => {
    expect(check('cd /tmp && agent-browser navigate http://192.168.0.1')?.block).toBe(true)
    expect(check('agent-browser dashboard start && agent-browser navigate http://192.168.0.1')?.block).toBe(true)
  })

  test('catches the URL when wrapped through bunx/npx', () => {
    expect(check('bunx agent-browser navigate http://192.168.0.1')?.block).toBe(true)
    expect(check('npx agent-browser navigate http://192.168.0.1')?.block).toBe(true)
    expect(check('npx --yes agent-browser navigate http://192.168.0.1')?.block).toBe(true)
    expect(check('npx --package=foo --yes agent-browser navigate http://192.168.0.1')?.block).toBe(true)
  })

  test('catches the URL when called by absolute path', () => {
    expect(check('/usr/local/bin/agent-browser navigate http://192.168.0.1')?.block).toBe(true)
    expect(check('./node_modules/.bin/agent-browser navigate http://192.168.0.1')?.block).toBe(true)
  })

  test('does not match unrelated scripts that happen to contain the substring', () => {
    expect(check('echo my-agent-browser-helper http://192.168.0.1')).toBeUndefined()
    expect(check('cat /tmp/agent-browser-notes.txt')).toBeUndefined()
  })

  test('does not apply to non-bash tools', () => {
    expect(
      checkAgentBrowserSsrfGuard({
        tool: 'webfetch',
        args: { url: 'http://192.168.0.1', command: 'agent-browser navigate http://192.168.0.1' },
      }),
    ).toBeUndefined()
  })

  test('handles non-string commands gracefully', () => {
    expect(checkAgentBrowserSsrfGuard({ tool: 'bash', args: { command: 42 } })).toBeUndefined()
    expect(checkAgentBrowserSsrfGuard({ tool: 'bash', args: {} })).toBeUndefined()
  })

  test('respects acknowledgeGuards opt-out', () => {
    expect(
      check('agent-browser navigate http://192.168.0.1', {
        acknowledgeGuards: { [GUARD_AGENT_BROWSER_SSRF]: true },
      }),
    ).toBeUndefined()
  })

  test('does not opt out on an unrelated guard ack', () => {
    expect(
      check('agent-browser navigate http://192.168.0.1', {
        acknowledgeGuards: { ssrf: true },
      })?.block,
    ).toBe(true)
  })

  test('reason text spells out the prompt-injection threat model', () => {
    const result = check('agent-browser navigate http://192.168.0.1')
    expect(result?.reason).toContain('prompt injection')
  })

  test('exposes guard name constant', () => {
    expect(GUARD_AGENT_BROWSER_SSRF).toBe('agentBrowserSsrf')
  })

  test('skips clean dashboard/skills/version subcommands', () => {
    expect(check('agent-browser dashboard start')).toBeUndefined()
    expect(check('agent-browser skills get core')).toBeUndefined()
    expect(check('agent-browser --version')).toBeUndefined()
  })
})
