import { fileURLToPath } from 'node:url'

import { SessionManager, type ExtensionToolContext } from '@earendil-works/pi-coding-agent'

import { shellQuote } from '@/sandbox/quote'

import { CodemodeKernel } from './kernel'
import type { KernelLaunch } from './process'
import { CodemodeError } from './protocol'

export function testKernel(cwd: string): CodemodeKernel {
  return new CodemodeKernel(async () => testLaunch(cwd))
}

export function testLaunch(cwd: string, fingerprint = 'test'): KernelLaunch {
  return {
    command: `${shellQuote(process.execPath)} --no-install ${shellQuote(fileURLToPath(new URL('./entry.ts', import.meta.url)))}`,
    cwd,
    env: { PATH: process.env.PATH ?? '' },
    fingerprint,
    cleanup: async () => {},
  }
}

export function testContext(cwd: string): ExtensionToolContext {
  const unsupported = (): never => {
    throw new CodemodeError('refused', 'unexpected UI or model access in tool test')
  }
  return {
    get ui() {
      return unsupported()
    },
    get modelRegistry() {
      return unsupported()
    },
    mode: 'print',
    hasUI: false,
    cwd,
    sessionManager: SessionManager.inMemory(cwd),
    model: undefined,
    scopedModels: [],
    signal: undefined,
    tools: [],
    isIdle: () => false,
    isProjectTrusted: () => false,
    abort: unsupported,
    hasPendingMessages: () => false,
    shutdown: unsupported,
    getContextUsage: () => undefined,
    compact: unsupported,
    getSystemPrompt: () => '',
    executeTool: unsupported,
  }
}
