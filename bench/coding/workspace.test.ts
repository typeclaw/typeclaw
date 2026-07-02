import { describe, expect, test } from 'bun:test'

import { type DockerRun, makeContainerWorkspaceProvider } from './workspace'

describe('makeContainerWorkspaceProvider', () => {
  test('seeds a fresh unique container path per run: rm -> mkdir -> cp contents', async () => {
    const calls: string[][] = []
    const docker: DockerRun = async (args) => {
      calls.push(args)
    }
    const provider = makeContainerWorkspaceProvider('agent', '/host/task', '/tmp', docker)

    const ws = await provider.prepare(2)

    expect(ws.path).toBe('/tmp/bench-run-2')
    expect(calls).toEqual([
      ['exec', 'agent', 'rm', '-rf', '/tmp/bench-run-2'],
      ['exec', 'agent', 'mkdir', '-p', '/tmp/bench-run-2'],
      ['cp', '/host/task/.', 'agent:/tmp/bench-run-2'],
    ])
  })

  test('cleanup removes the run workspace', async () => {
    const calls: string[][] = []
    const docker: DockerRun = async (args) => {
      calls.push(args)
    }
    const provider = makeContainerWorkspaceProvider('agent', '/host/task', '/tmp', docker)

    const ws = await provider.prepare(0)
    calls.length = 0
    await ws.cleanup?.()

    expect(calls).toEqual([['exec', 'agent', 'rm', '-rf', '/tmp/bench-run-0']])
  })
})
