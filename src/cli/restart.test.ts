import { describe, expect, test } from 'bun:test'

import type { Controller, RestartOptions, StartResult } from '@/container'

import { runRestartCommand, type RestartCommandEvent } from './restart'

// The CLI must leave streamOutput at its true default so `docker build` keeps
// streaming; asserting its absence is what pins the production configuration.
const streamingOption = 'streamOutput'

describe('runRestartCommand', () => {
  test('renders collected warnings after both spinners settle on success with default streaming', async () => {
    const events: RestartCommandEvent[] = []
    let received: RestartOptions | undefined
    const restart: Controller['restart'] = async (options) => {
      received = options
      options.onWarning?.('Archived logs from the dead container.')
      options.onStopped?.({ ok: true, containerName: 'agent', running: true })
      return {
        ok: true,
        stop: { ok: true, containerName: 'agent', running: true },
        start: successfulStart(['Unsafe Dockerfile line was removed.']),
      }
    }

    const result = await runRestartCommand(commandOptions, { restart, onEvent: (event) => events.push(event) })

    expect(result).toEqual({ ok: true })
    expect(received).toBeDefined()
    expect(streamingOption in received!).toBe(false)
    expect(events).toEqual([
      { kind: 'stop-spinner-start', message: 'Stopping container...' },
      { kind: 'stop-spinner-stop', message: 'Stopped agent.' },
      { kind: 'start-spinner-start', message: 'Starting container...' },
      { kind: 'start-spinner-stop', message: 'Started.' },
      { kind: 'warnings', warnings: ['Archived logs from the dead container.'] },
      { kind: 'warnings', warnings: ['Unsafe Dockerfile line was removed.'] },
      { kind: 'success', output: expect.any(String) },
    ])
    expect(events.at(-1)?.kind).toBe('success')
  })

  test('errors the stop spinner before rendering warnings when restart fails before onStopped', async () => {
    const events: RestartCommandEvent[] = []
    let received: RestartOptions | undefined
    const restart: Controller['restart'] = async (options) => {
      received = options
      options.onWarning?.('Archived logs from the dead container.')
      return { ok: false, reason: 'stop failed' }
    }

    const result = await runRestartCommand(commandOptions, { restart, onEvent: (event) => events.push(event) })

    expect(result).toEqual({ ok: false })
    expect(received).toBeDefined()
    expect(streamingOption in received!).toBe(false)
    expect(events).toEqual([
      { kind: 'stop-spinner-start', message: 'Stopping container...' },
      { kind: 'stop-spinner-error', message: 'stop failed' },
      { kind: 'warnings', warnings: ['Archived logs from the dead container.'] },
    ])
    expect(events.some((event) => event.kind === 'start-spinner-error')).toBe(false)
    expect(events.some((event) => event.kind === 'success')).toBe(false)
  })

  test('errors the start spinner before rendering warnings when restart fails after onStopped', async () => {
    const events: RestartCommandEvent[] = []
    const restart: Controller['restart'] = async (options) => {
      options.onWarning?.('Archived logs from the dead container.')
      options.onStopped?.({ ok: true, containerName: 'agent', running: false })
      return { ok: false, reason: 'start failed' }
    }

    const result = await runRestartCommand(commandOptions, { restart, onEvent: (event) => events.push(event) })

    expect(result).toEqual({ ok: false })
    expect(events).toEqual([
      { kind: 'stop-spinner-start', message: 'Stopping container...' },
      { kind: 'stop-spinner-stop', message: 'Already stopped.' },
      { kind: 'start-spinner-start', message: 'Starting container...' },
      { kind: 'start-spinner-error', message: 'start failed' },
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
