import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

export type SessionFactory = {
  createPersisted(): SessionManager
  sessionDir(): string
}

export type CreateSessionFactoryOptions = {
  agentDir: string
}

export function createSessionFactory({ agentDir }: CreateSessionFactoryOptions): SessionFactory {
  const dir = join(agentDir, 'sessions')
  mkdirSync(dir, { recursive: true })

  return {
    createPersisted: () => SessionManager.create(agentDir, dir),
    sessionDir: () => dir,
  }
}
