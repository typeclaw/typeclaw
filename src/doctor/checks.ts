import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import { loadConfigSync, validateConfig } from '@/config'
import {
  checkDockerAvailable,
  containerNameFromCwd,
  defaultDockerExec,
  imageTagFromCwd,
  inspectContainer,
  resolveHostPort,
  type DockerExec,
} from '@/container'
import { isDaemonReachable, send } from '@/hostd'
import { buildDockerfile, DOCKERFILE } from '@/init/dockerfile'
import { detectMissingDeps } from '@/init/ensure-deps'
import { buildGitignore, GITIGNORE_FILE } from '@/init/gitignore'

import type { DoctorCheck } from './types'

const REQUIRED_DIRS = ['workspace', 'sessions', '.agents/skills', 'mounts', 'packages'] as const

export function buildStaticChecks(opts: { dockerExec?: DockerExec } = {}): DoctorCheck[] {
  const dockerExec = opts.dockerExec ?? defaultDockerExec

  return [
    dockerDaemon(dockerExec),
    bunRuntime(),
    agentFolderInitialized(),
    agentFolderRequiredDirs(),
    agentFolderDockerfileTemplate(),
    agentFolderGitignoreTemplate(),
    agentFolderNodeModules(),
    agentFolderEnvFile(),
    agentFolderGitRepo(),
    configValid(),
    hostdHomeWritable(),
    hostdReachable(),
    hostdRegistration(),
    containerState(dockerExec),
    containerHostPort(),
  ]
}

function dockerDaemon(exec: DockerExec): DoctorCheck {
  return {
    name: 'docker.daemon-reachable',
    category: 'docker',
    description: 'Docker daemon is reachable',
    async run() {
      const result = await checkDockerAvailable(exec)
      if (result.ok) return { status: 'ok', message: 'docker info responded' }
      return {
        status: 'error',
        message: result.reason === 'binary-missing' ? 'docker binary missing on $PATH' : 'docker daemon down',
        details: [result.detail],
        fix:
          result.reason === 'binary-missing'
            ? { description: 'Install Docker (Docker Desktop, OrbStack, or docker-ce).' }
            : { description: 'Start the Docker daemon (Docker Desktop, OrbStack, or `systemctl start docker`).' },
      }
    },
  }
}

function bunRuntime(): DoctorCheck {
  return {
    name: 'runtime.bun-available',
    category: 'runtime',
    description: 'Bun runtime is available',
    async run() {
      const bun = (globalThis as { Bun?: unknown }).Bun
      if (bun === undefined) {
        return {
          status: 'error',
          message: 'Bun runtime is not available',
          fix: { description: 'Install Bun (https://bun.sh) and ensure the typeclaw CLI runs under it.' },
        }
      }
      return { status: 'ok', message: `Bun ${process.versions.bun ?? 'present'}` }
    },
  }
}

function agentFolderInitialized(): DoctorCheck {
  return {
    name: 'agent-folder.is-initialized',
    category: 'agent-folder',
    description: 'agent folder contains typeclaw.json',
    async run(ctx) {
      if (ctx.hasAgentFolder) return { status: 'ok', message: 'typeclaw.json present' }
      return {
        status: 'info',
        message: 'no typeclaw.json found in or above current directory',
        details: ['Host-stage checks unrelated to the agent folder still ran.'],
        fix: { description: 'Run `typeclaw init` in the directory you want to use as an agent folder.' },
      }
    },
  }
}

function agentFolderRequiredDirs(): DoctorCheck {
  return {
    name: 'agent-folder.required-dirs',
    category: 'agent-folder',
    description: 'required agent directories exist',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const missing = REQUIRED_DIRS.filter((d) => !existsSync(join(ctx.cwd, d)))
      if (missing.length === 0) return { status: 'ok', message: 'all required directories present' }
      return {
        status: 'warning',
        message: `${missing.length} required ${missing.length === 1 ? 'directory' : 'directories'} missing`,
        details: missing.map((d) => `missing: ${d}/`),
        fix: {
          description: `Create the missing directories: ${missing.map((d) => `${d}/`).join(', ')}. Most are gitignored, so \`typeclaw doctor --fix\` does not auto-create them; \`typeclaw start\` will scaffold them on next run.`,
        },
      }
    },
  }
}

function agentFolderDockerfileTemplate(): DoctorCheck {
  return {
    name: 'agent-folder.dockerfile-managed',
    category: 'agent-folder',
    description: 'Dockerfile matches the typeclaw template',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const dockerfilePath = join(ctx.cwd, DOCKERFILE)
      const expected = buildExpectedDockerfile(ctx.cwd)
      if (expected === null) {
        return { status: 'info', message: 'config invalid; cannot compute expected Dockerfile' }
      }
      const actual = await safeRead(dockerfilePath)
      if (actual === expected) return { status: 'ok', message: 'Dockerfile matches template' }
      return {
        status: 'info',
        message: actual === null ? 'Dockerfile missing' : 'Dockerfile diverges from template',
        details: [
          'The Dockerfile is gitignored and regenerated on every `typeclaw start` from the template.',
          'Run `typeclaw start --build` to refresh it now.',
        ],
      }
    },
  }
}

function agentFolderGitignoreTemplate(): DoctorCheck {
  return {
    name: 'agent-folder.gitignore-managed',
    category: 'agent-folder',
    description: '.gitignore matches the typeclaw template',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const gitignorePath = join(ctx.cwd, GITIGNORE_FILE)
      const expected = buildExpectedGitignore(ctx.cwd)
      if (expected === null) {
        return { status: 'info', message: 'config invalid; cannot compute expected .gitignore' }
      }
      const actual = await safeRead(gitignorePath)
      if (actual === expected) return { status: 'ok', message: '.gitignore matches template' }
      return {
        status: 'warning',
        message: actual === null ? '.gitignore missing' : '.gitignore diverges from template',
        fix: {
          description: 'Regenerate .gitignore from the typeclaw template.',
          autoFix: async () => {
            await writeAtomic(gitignorePath, expected)
            return { summary: 'refreshed .gitignore from template', changedPaths: [GITIGNORE_FILE] }
          },
        },
      }
    },
  }
}

function agentFolderNodeModules(): DoctorCheck {
  return {
    name: 'agent-folder.node-modules-complete',
    category: 'agent-folder',
    description: 'node_modules satisfies package.json dependencies',
    applies: (ctx) => ctx.hasAgentFolder && existsSync(join(ctx.cwd, 'package.json')),
    async run(ctx) {
      const missing = await detectMissingDeps(ctx.cwd)
      if (missing.length === 0) return { status: 'ok', message: 'node_modules complete' }
      return {
        status: 'error',
        message: `${missing.length} package(s) missing from node_modules`,
        details: missing.map((m) => `missing: ${m}`),
        fix: { description: 'Run `bun install` inside the agent folder.' },
      }
    },
  }
}

function agentFolderEnvFile(): DoctorCheck {
  return {
    name: 'agent-folder.env-file',
    category: 'agent-folder',
    description: '.env file is present',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      if (existsSync(join(ctx.cwd, '.env'))) return { status: 'ok', message: '.env present' }
      return {
        status: 'warning',
        message: '.env is missing',
        details: ['Channels and external API integrations will not have their secrets injected.'],
        fix: { description: 'Create a .env file with the credentials your agent needs.' },
      }
    },
  }
}

function agentFolderGitRepo(): DoctorCheck {
  return {
    name: 'agent-folder.git-repo',
    category: 'agent-folder',
    description: 'agent folder is a git repo',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      if (existsSync(join(ctx.cwd, '.git'))) return { status: 'ok', message: '.git present' }
      return {
        status: 'warning',
        message: 'agent folder is not a git repo',
        details: ['typeclaw doctor --fix cannot commit changes without a git repo.'],
        fix: { description: 'Run `git init` in the agent folder.' },
      }
    },
  }
}

function configValid(): DoctorCheck {
  return {
    name: 'config.valid',
    category: 'config',
    description: 'typeclaw.json is valid and mounts are accessible',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const result = validateConfig(ctx.cwd)
      if (result.ok) return { status: 'ok', message: 'typeclaw.json valid; mounts accessible' }
      return {
        status: 'error',
        message: result.reason,
        fix: { description: 'Edit typeclaw.json to resolve the validation error above.' },
      }
    },
  }
}

function hostdHomeWritable(): DoctorCheck {
  return {
    name: 'hostd.home-writable',
    category: 'hostd',
    description: 'hostd home (~/.typeclaw/) is writable',
    async run() {
      const home = process.env.TYPECLAW_HOME ?? join(homedir(), '.typeclaw')
      try {
        mkdirSync(home, { recursive: true })
        return { status: 'ok', message: `${home} writable` }
      } catch (err) {
        return {
          status: 'error',
          message: `cannot create ${home}: ${err instanceof Error ? err.message : String(err)}`,
          fix: { description: 'Ensure your home directory is writable, or set TYPECLAW_HOME to an alternate path.' },
        }
      }
    },
  }
}

function hostdReachable(): DoctorCheck {
  return {
    name: 'hostd.reachable',
    category: 'hostd',
    description: 'host daemon is reachable over the Unix socket',
    async run() {
      const reachable = await isDaemonReachable()
      if (reachable) return { status: 'ok', message: 'daemon socket replied to list RPC' }
      return {
        status: 'info',
        message: 'host daemon is not running',
        details: [
          'This is normal when no agent has been started yet. `typeclaw start` will spawn the daemon on demand.',
        ],
      }
    },
  }
}

function hostdRegistration(): DoctorCheck {
  return {
    name: 'hostd.registration',
    category: 'hostd',
    description: 'agent container is registered with hostd',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      if (!(await isDaemonReachable())) {
        return { status: 'skipped', message: 'hostd unreachable (covered by hostd.reachable)' }
      }
      const containerName = containerNameFromCwd(ctx.cwd)
      const reply = await send({ kind: 'status', containerName })
      if (reply.ok) return { status: 'ok', message: 'registered with hostd' }
      return {
        status: 'info',
        message: 'agent is not registered with hostd',
        details: [reply.reason],
      }
    },
  }
}

function containerState(exec: DockerExec): DoctorCheck {
  return {
    name: 'container.state',
    category: 'container',
    description: 'agent container Docker state',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const available = await checkDockerAvailable(exec)
      if (!available.ok) {
        return { status: 'skipped', message: 'docker unavailable (covered by docker.daemon-reachable)' }
      }
      const name = containerNameFromCwd(ctx.cwd)
      const state = await inspectContainer(name)
      if (!state.exists) {
        return {
          status: 'info',
          message: `container ${name} does not exist`,
          details: [`expected image tag: ${imageTagFromCwd(ctx.cwd)}`],
        }
      }
      if (state.running) return { status: 'ok', message: `container ${name} is running` }
      return {
        status: 'warning',
        message: `container ${name} is stopped`,
        fix: { description: 'Run `typeclaw start` to bring the container back up.' },
      }
    },
  }
}

function containerHostPort(): DoctorCheck {
  return {
    name: 'container.host-port-resolves',
    category: 'container',
    description: 'running container exposes its host port',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const name = containerNameFromCwd(ctx.cwd)
      const state = await inspectContainer(name)
      if (!state.exists || !state.running) {
        return { status: 'skipped', message: 'container not running' }
      }
      try {
        const port = await resolveHostPort({ cwd: ctx.cwd })
        return { status: 'ok', message: `host port ${port} -> container` }
      } catch (err) {
        return {
          status: 'warning',
          message: `cannot resolve host port: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }
}

function buildExpectedDockerfile(cwd: string): string | null {
  try {
    const cfg = loadConfigStrictForTemplate(cwd)
    if (cfg === null) return null
    return buildDockerfile(cfg.dockerfile)
  } catch {
    return null
  }
}

function buildExpectedGitignore(cwd: string): string | null {
  try {
    const cfg = loadConfigStrictForTemplate(cwd)
    if (cfg === null) return null
    return buildGitignore(cfg.gitignore)
  } catch {
    return null
  }
}

function loadConfigStrictForTemplate(
  cwd: string,
): { dockerfile: Parameters<typeof buildDockerfile>[0]; gitignore: Parameters<typeof buildGitignore>[0] } | null {
  const result = validateConfig(cwd)
  if (!result.ok) return null
  const cfg = loadConfigSync(cwd)
  return { dockerfile: cfg.dockerfile, gitignore: cfg.gitignore }
}

async function safeRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.typeclaw-doctor.tmp`
  await writeFile(tmp, content)
  renameSync(tmp, path)
}

export function relativeToCwd(cwd: string, path: string): string {
  return relative(cwd, path) || '.'
}
