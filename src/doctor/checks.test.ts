import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfigSync } from '@/config'
import { resolveBaseImageVersion } from '@/init/cli-version'
import { buildDockerfile, DOCKERFILE } from '@/init/dockerfile'
import { buildGitignore, GITIGNORE_FILE } from '@/init/gitignore'

import {
  buildStaticChecks,
  detectWindowsBindMountIssues,
  macosMaxFiles,
  parseLaunchctlMaxFilesSoft,
  windowsBindMount,
  windowsSecretPerms,
  wslDriveMount,
  type MacosMaxFilesDeps,
  type WindowsBindMountDeps,
  type WindowsSecretPermsDeps,
  type WslDriveMountDeps,
} from './checks'
import type { CheckContext } from './types'

const agentCtx: CheckContext = { cwd: '/mnt/c/work/agent', hasAgentFolder: true }
const linuxCtx: CheckContext = { cwd: '/home/dev/agent', hasAgentFolder: true }

function deps(overrides: Partial<WslDriveMountDeps> = {}): WslDriveMountDeps {
  return {
    detect: () => ({ isWsl: true, version: 2 }),
    isWindowsDriveMount: (p) => p.startsWith('/mnt/'),
    typeclawHome: () => '/home/dev/.typeclaw',
    ...overrides,
  }
}

describe('wslDriveMount', () => {
  test('passes when not running under WSL', async () => {
    const check = wslDriveMount(deps({ detect: () => ({ isWsl: false, version: null }) }))
    const result = await check.run(agentCtx)
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not running under WSL')
  })

  test('passes when agent folder and home are on the Linux filesystem', async () => {
    const check = wslDriveMount(deps())
    const result = await check.run(linuxCtx)
    expect(result.status).toBe('ok')
  })

  test('warns when the agent folder is on a Windows-drive mount', async () => {
    const check = wslDriveMount(deps())
    const result = await check.run(agentCtx)
    expect(result.status).toBe('warning')
    expect(result.details).toContain('agent folder: /mnt/c/work/agent')
    expect(result.fix?.description).toContain('Linux filesystem')
  })

  test('warns when ~/.typeclaw is on a Windows-drive mount even if agent folder is fine', async () => {
    const winHome = '/mnt/c/work/.typeclaw'
    const check = wslDriveMount(deps({ typeclawHome: () => winHome }))
    const result = await check.run(linuxCtx)
    expect(result.status).toBe('warning')
    expect(result.details).toContain(`hostd home: ${winHome}`)
  })

  test('does not inspect the agent folder when there is none', async () => {
    const check = wslDriveMount(deps())
    const result = await check.run({ cwd: '/mnt/c/work/agent', hasAgentFolder: false })
    expect(result.status).toBe('ok')
  })
})

describe('windowsSecretPerms', () => {
  function winDeps(overrides: Partial<WindowsSecretPermsDeps> = {}): WindowsSecretPermsDeps {
    return {
      isWindows: () => true,
      typeclawHome: () => 'C:\\Users\\dev\\.typeclaw',
      ...overrides,
    }
  }

  test('passes when not on native Windows', async () => {
    const check = windowsSecretPerms({ isWindows: () => false })
    const result = await check.run(linuxCtx)
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not running on native Windows')
  })

  test('warns on native Windows that file modes are not enforced', async () => {
    const check = windowsSecretPerms(winDeps())
    const result = await check.run({ cwd: 'C:\\work\\agent', hasAgentFolder: true })
    expect(result.status).toBe('warning')
    expect(result.details).toContain('agent folder: C:\\work\\agent')
    expect(result.details?.some((d) => d.includes('NTFS'))).toBe(true)
  })

  test('reports the hostd home even without an agent folder', async () => {
    const check = windowsSecretPerms(winDeps())
    const result = await check.run({ cwd: 'C:\\work\\agent', hasAgentFolder: false })
    expect(result.status).toBe('warning')
    expect(result.details).toContain('hostd home: C:\\Users\\dev\\.typeclaw')
  })

  test('is registered in the static check set', () => {
    expect(buildStaticChecks().some((c) => c.name === 'hostd.windows-secret-perms')).toBe(true)
  })
})

describe('macosMaxFiles', () => {
  const hostCtx: CheckContext = { cwd: '/tmp/agent', hasAgentFolder: true }

  function macDeps(overrides: Partial<MacosMaxFilesDeps> = {}): MacosMaxFilesDeps {
    return {
      isMacOS: () => true,
      readLaunchctlMaxFiles: async () => '\tmaxfiles    256            unlimited      \n',
      ...overrides,
    }
  }

  test('passes when not running on macOS', async () => {
    const check = macosMaxFiles(macDeps({ isMacOS: () => false }))
    const result = await check.run(hostCtx)
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not running on macOS')
  })

  test('warns on the macOS default 256 soft limit', async () => {
    const check = macosMaxFiles(macDeps())
    const result = await check.run(hostCtx)
    expect(result.status).toBe('warning')
    expect(result.message).toContain('256')
    expect(result.details?.some((d) => d.includes('too many open files'))).toBe(true)
    expect(result.fix?.description).toContain('relaunch')
  })

  test('passes when the soft limit is comfortably high', async () => {
    const check = macosMaxFiles(macDeps({ readLaunchctlMaxFiles: async () => '\tmaxfiles    10240    unlimited\n' }))
    const result = await check.run(hostCtx)
    expect(result.status).toBe('ok')
    expect(result.message).toContain('10240')
  })

  test('passes when the soft limit is unlimited', async () => {
    const check = macosMaxFiles(
      macDeps({ readLaunchctlMaxFiles: async () => '\tmaxfiles    unlimited    unlimited\n' }),
    )
    const result = await check.run(hostCtx)
    expect(result.status).toBe('ok')
  })

  test('degrades to info when the limit cannot be read', async () => {
    const check = macosMaxFiles(macDeps({ readLaunchctlMaxFiles: async () => null }))
    const result = await check.run(hostCtx)
    expect(result.status).toBe('info')
    expect(result.status).not.toBe('error')
  })

  test('degrades to info on unparseable output', async () => {
    const check = macosMaxFiles(macDeps({ readLaunchctlMaxFiles: async () => 'garbage output\n' }))
    const result = await check.run(hostCtx)
    expect(result.status).toBe('info')
  })

  test('is registered in the static check set', () => {
    expect(buildStaticChecks().some((c) => c.name === 'hostd.macos-maxfiles')).toBe(true)
  })
})

describe('parseLaunchctlMaxFilesSoft', () => {
  test('parses the real launchctl output shape', () => {
    expect(parseLaunchctlMaxFilesSoft('\tmaxfiles    256            unlimited      \n')).toBe(256)
  })

  test('parses unlimited as Infinity', () => {
    expect(parseLaunchctlMaxFilesSoft('\tmaxfiles    unlimited    unlimited\n')).toBe(Number.POSITIVE_INFINITY)
  })

  test('returns null when there is no maxfiles line', () => {
    expect(parseLaunchctlMaxFilesSoft('\tcpu    unlimited    unlimited\n')).toBeNull()
  })

  test('returns null on a non-numeric soft field', () => {
    expect(parseLaunchctlMaxFilesSoft('\tmaxfiles    notanumber    unlimited\n')).toBeNull()
  })
})

describe('windowsBindMount', () => {
  function winDeps(overrides: Partial<WindowsBindMountDeps> = {}): WindowsBindMountDeps {
    return { isWindows: () => true, ...overrides }
  }

  test('passes when not on native Windows', async () => {
    const check = windowsBindMount({ isWindows: () => false })
    const result = await check.run({ cwd: '\\\\nas\\share\\agent', hasAgentFolder: true })
    expect(result.status).toBe('ok')
    expect(result.message).toContain('not running on native Windows')
  })

  test('passes for a clean local path', async () => {
    const check = windowsBindMount(winDeps())
    const result = await check.run({ cwd: 'C:\\agents\\my-agent', hasAgentFolder: true })
    expect(result.status).toBe('ok')
  })

  test('warns on a UNC/network path', async () => {
    const check = windowsBindMount(winDeps())
    const result = await check.run({ cwd: '\\\\nas\\share\\agent', hasAgentFolder: true })
    expect(result.status).toBe('warning')
    expect(result.details?.some((d) => d.includes('UNC'))).toBe(true)
  })

  test('warns on a OneDrive path', async () => {
    const check = windowsBindMount(winDeps())
    const result = await check.run({ cwd: 'C:\\Users\\dev\\OneDrive\\agent', hasAgentFolder: true })
    expect(result.status).toBe('warning')
    expect(result.details?.some((d) => d.toLowerCase().includes('onedrive'))).toBe(true)
  })

  test('is registered in the static check set', () => {
    expect(buildStaticChecks().some((c) => c.name === 'container.windows-bind-mount')).toBe(true)
  })
})

describe('detectWindowsBindMountIssues', () => {
  test('flags UNC paths', () => {
    expect(detectWindowsBindMountIssues('\\\\nas\\share\\agent')).toHaveLength(1)
  })

  test('flags OneDrive business folders', () => {
    expect(detectWindowsBindMountIssues('C:\\Users\\dev\\OneDrive - Acme\\agent')).toHaveLength(1)
  })

  test('flags paths over the MAX_PATH limit', () => {
    expect(detectWindowsBindMountIssues(`C:\\${'a'.repeat(300)}`)).toHaveLength(1)
  })

  test('passes clean local paths', () => {
    expect(detectWindowsBindMountIssues('C:\\agents\\my-agent')).toEqual([])
  })
})

describe('managed-template checks tolerate CRLF line endings', () => {
  function findCheck(name: string) {
    const check = buildStaticChecks().find((c) => c.name === name)
    if (!check) throw new Error(`missing check ${name}`)
    return check
  }

  function makeAgentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'typeclaw-crlf-test-'))
    writeFileSync(join(dir, 'typeclaw.json'), JSON.stringify({}), 'utf8')
    return dir
  }

  const ctx = (cwd: string): CheckContext => ({ cwd, hasAgentFolder: true })

  test('.gitignore with CRLF is not reported as divergent', async () => {
    const cwd = makeAgentDir()
    const lf = buildGitignore({ append: [] })
    writeFileSync(join(cwd, GITIGNORE_FILE), lf.replace(/\n/g, '\r\n'), 'utf8')

    const result = await findCheck('agent-folder.gitignore-managed').run(ctx(cwd))
    expect(result.status).toBe('ok')
  })

  test('Dockerfile with CRLF is not reported as divergent', async () => {
    const cwd = makeAgentDir()
    const lf = buildDockerfile(loadConfigSync(cwd).docker.file, {
      baseImageVersion: resolveBaseImageVersion(cwd),
    })
    writeFileSync(join(cwd, DOCKERFILE), lf.replace(/\n/g, '\r\n'), 'utf8')

    const result = await findCheck('agent-folder.dockerfile-managed').run(ctx(cwd))
    expect(result.status).toBe('ok')
  })
})

describe('agent file ownership checks', () => {
  function findCheck(checks: ReturnType<typeof buildStaticChecks>, name: string) {
    const check = checks.find((candidate) => candidate.name === name)
    if (!check) throw new Error(`missing check ${name}`)
    return check
  }

  test('reports agent-managed paths owned by another POSIX user', async () => {
    // given
    const cwd = mkdtempSync(join(tmpdir(), 'typeclaw-owner-test-'))
    writeFileSync(join(cwd, 'typeclaw.json'), JSON.stringify({}), 'utf8')
    const foreignUid = typeof process.getuid === 'function' ? process.getuid() + 1 : 1
    const check = findCheck(
      buildStaticChecks({ platform: 'linux', currentUid: () => foreignUid }),
      'agent-folder.file-ownership',
    )

    // when
    const result = await check.run({ cwd, hasAgentFolder: true })

    // then
    expect(result.status).toBe('error')
    expect(result.message).toContain('typeclaw.json')
    expect(result.details?.join('\n')).toContain('sudo chown -R "$(id -u):$(id -g)"')
  })

  test('skips POSIX ownership checks on native Windows', async () => {
    // given
    const cwd = mkdtempSync(join(tmpdir(), 'typeclaw-owner-test-'))
    writeFileSync(join(cwd, 'typeclaw.json'), JSON.stringify({}), 'utf8')
    const check = findCheck(
      buildStaticChecks({ platform: 'win32', currentUid: () => 1 }),
      'agent-folder.file-ownership',
    )

    // when
    const result = await check.run({ cwd, hasAgentFolder: true })

    // then
    expect(result.status).toBe('ok')
  })
})
