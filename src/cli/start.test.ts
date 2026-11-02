import { describe, expect, test } from 'bun:test'

import type { Controller, StartOptions, StartResult } from '@/container'

import { runStartCommand, type StartCommandEvent } from './start'

// The CLI must leave streamOutput at its true default so `docker build` keeps
// streaming; asserting its absence is what pins the production configuration.
const streamingOption = 'streamOutput'

describe('runStartCommand', () => {
  test('renders collected warnings after the spinner settles on success with default streaming', async () => {
    const events: StartCommandEvent[] = []
    let received: StartOptions | undefined
    const start: Controller['start'] = async (options) => {
      received = options
      options.onWarning?.('Archived logs from the dead container.')
      return successfulStart(['Unsafe Dockerfile line was removed.'])
    }

    const result = await runStartCommand(commandOptions, { start, onEvent: (event) => events.push(event) })

    expect(result).toEqual({ ok: true })
    expect(received).toBeDefined()
    expect(streamingOption in received!).toBe(false)
    expect(events).toEqual([
      { kind: 'spinner-start', message: 'Starting container...' },
      { kind: 'spinner-stop', message: 'Started.' },
      { kind: 'warnings', warnings: ['Archived logs from the dead container.'] },
      { kind: 'warnings', warnings: ['Unsafe Dockerfile line was removed.'] },
      { kind: 'success', output: expect.any(String) },
    ])
    expect(events.at(-1)?.kind).toBe('success')
  })

  test('renders collected warnings after the spinner errors on failure with default streaming', async () => {
    const events: StartCommandEvent[] = []
    let received: StartOptions | undefined
    const start: Controller['start'] = async (options) => {
      received = options
      options.onWarning?.('Archived logs from the dead container.')
      return { ok: false, reason: 'docker run failed' }
    }

    const result = await runStartCommand(commandOptions, { start, onEvent: (event) => events.push(event) })

    expect(result).toEqual({ ok: false })
    expect(received).toBeDefined()
    expect(streamingOption in received!).toBe(false)
    expect(events).toEqual([
      { kind: 'spinner-start', message: 'Starting container...' },
      { kind: 'spinner-error', message: 'docker run failed' },
      { kind: 'warnings', warnings: ['Archived logs from the dead container.'] },
    ])
    expect(events.some((event) => event.kind === 'success')).toBe(false)
  })
})

const commandOptions = {
  cwd: '/agent',
  preferredHostPort: 8973,
  forceBuild: false,
  cliEntry: '/typeclaw/src/cli/index.ts',
}

function successfulStart(dockerfileWarnings: string[]): Extract<StartResult, { ok: true }> {
  return {
    ok: true,
    plan: {
      containerName: 'agent',
      imageTag: 'typeclaw-agent',
      buildContext: '/agent',
      dockerfile: '/agent/Dockerfile',
      runArgs: [],
      needsBuild: false,
      hostPort: 8973,
      tuiToken: null,
      memoryLimitBytes: 6442450944,
      mountWarnings: [],
    },
    containerId: 'container-id',
    built: false,
    hostPort: 8973,
    tuiToken: null,
    hostd: { state: 'disabled' },
    alreadyRunning: false,
    autoUpgrade: { kind: 'skipped-no-dep' },
    skippedPlugins: [],
    dockerfileWarnings,
  }
}
