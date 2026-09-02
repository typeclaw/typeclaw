import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import {
  buildxAvailable,
  checkDockerAvailable,
  classifyRmStderr,
  cleanupRunCorpse,
  containerNameFromCwd,
  DOCKER_NOT_FOUND_STDERR,
  dockerBindMount,
  dockerCmd,
  dockerConfigDir,
  type DockerExec,
  imageTagFromCwd,
  isContainerNameConflict,
  isMissingDockerCredentialHelper,
  parseContainerInspectOutput,
  readCapturedStream,
  resolveDockerBinary,
  sanitizeDockerConfigJson,
  sanitizeDockerStderr,
  spawnInheritTeeStderr,
  waitForRemoval,
} from './shared'

let root: string
const beforeRemove = async () => ({ ok: true as const })
const CORPSE_ID = 'a'.repeat(64)
const LIVE_ID = 'b'.repeat(64)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-container-shared-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('containerNameFromCwd', () => {
  test('uses the folder basename', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe('coder')
  })

  test('replaces disallowed characters with dashes', async () => {
    const folder = join(root, 'my agent@v2')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe('my-agent-v2')
  })

  test('prefixes tc- when the name does not start with alphanumeric', async () => {
    const folder = join(root, '.hidden')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe('tc-.hidden')
  })

  test('produces a valid Docker name for an all-non-ASCII folder (Korean)', async () => {
    const folder = join(root, '봇')
    await mkdir(folder)

    const name = containerNameFromCwd(folder)

    expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
    expect(name).toMatch(/^tc-[0-9a-f]{8}$/)
  })

  test('disambiguates the sampled non-ASCII folder names that previously collided (the core bug)', async () => {
    // given: single-character CJK/Korean names that the old charset filter
    // collapsed to the same 'tc--' string — distinct agents, same container key.
    const bot = join(root, '봇')
    const house = join(root, '집')
    const cn = join(root, '中文')
    const jp = join(root, '日本')
    await Promise.all([mkdir(bot), mkdir(house), mkdir(cn), mkdir(jp)])

    const names = [
      containerNameFromCwd(bot),
      containerNameFromCwd(house),
      containerNameFromCwd(cn),
      containerNameFromCwd(jp),
    ]

    expect(new Set(names).size).toBe(names.length)
  })

  test('keeps surviving ASCII as a readable prefix and disambiguates by hash', async () => {
    // given: two folders that share an ASCII suffix but differ only in their
    // CJK prefix — the old filter mapped both to 'tc-------Agent'.
    const cn = join(root, '中文Agent')
    const jp = join(root, '日本Agent')
    await Promise.all([mkdir(cn), mkdir(jp)])

    const cnName = containerNameFromCwd(cn)
    const jpName = containerNameFromCwd(jp)

    expect(cnName).toMatch(/^Agent-[0-9a-f]{8}$/)
    expect(jpName).toMatch(/^Agent-[0-9a-f]{8}$/)
    expect(cnName).not.toBe(jpName)
  })

  test('is deterministic for the same non-ASCII folder name', async () => {
    const folder = join(root, '한글에이전트')
    await mkdir(folder)

    expect(containerNameFromCwd(folder)).toBe(containerNameFromCwd(folder))
  })
})

describe('imageTagFromCwd', () => {
  test('prefixes with typeclaw-', async () => {
    const folder = join(root, 'coder')
    await mkdir(folder)

    expect(imageTagFromCwd(folder)).toBe('typeclaw-coder')
  })
})

describe('checkDockerAvailable', () => {
  test('returns ok when docker info exits 0', async () => {
    const exec: DockerExec = async () => ({ exitCode: 0, stdout: '29.4.0\n', stderr: '' })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({ ok: true })
  })

  test('classifies as binary-missing when stderr is the ENOENT sentinel', async () => {
    const exec: DockerExec = async () => ({ exitCode: -1, stdout: '', stderr: DOCKER_NOT_FOUND_STDERR })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({
      ok: false,
      reason: 'binary-missing',
      detail: DOCKER_NOT_FOUND_STDERR,
    })
  })

  test('classifies any other non-zero exit as daemon-down', async () => {
    const exec: DockerExec = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
    })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({
      ok: false,
      reason: 'daemon-down',
      detail: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    })
  })

  test('falls back to a synthetic detail when stderr is empty on non-zero exit', async () => {
    const exec: DockerExec = async () => ({ exitCode: 7, stdout: '', stderr: '   ' })

    const result = await checkDockerAvailable(exec)

    expect(result).toEqual({
      ok: false,
      reason: 'daemon-down',
      detail: 'docker info exited with code 7',
    })
  })

  test('passes the right args to the exec stub', async () => {
    const calls: string[][] = []
    const exec: DockerExec = async (args) => {
      calls.push(args)
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    await checkDockerAvailable(exec)

    expect(calls).toEqual([['info', '--format', '{{.ServerVersion}}']])
  })
})

describe('dockerCmd', () => {
  test('prepends the resolved docker binary path to the args', () => {
    const cmd = dockerCmd(['info', '--format', '{{.ServerVersion}}'], () => '/usr/local/bin/docker')

    expect(cmd).toEqual(['/usr/local/bin/docker', 'info', '--format', '{{.ServerVersion}}'])
  })

  test('resolves to the absolute .exe path on Windows rather than leaving PATHEXT to Bun.spawn', () => {
    const cmd = dockerCmd(['info'], () => 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe')

    expect(cmd).toEqual(['C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe', 'info'])
  })

  test('returns null when docker is not on PATH', () => {
    expect(dockerCmd(['info'], () => null)).toBeNull()
  })
})

describe('resolveDockerBinary', () => {
  test('returns the PATH-resolved binary when Bun.which finds it', () => {
    const result = resolveDockerBinary({
      which: () => '/usr/local/bin/docker',
      platform: 'darwin',
      exists: () => {
        throw new Error('must not probe the filesystem when PATH resolves')
      },
    })

    expect(result).toBe('/usr/local/bin/docker')
  })

  test('does NOT fall back to filesystem probing on POSIX when PATH misses', () => {
    let probed = false
    const result = resolveDockerBinary({
      which: () => null,
      platform: 'linux',
      exists: () => {
        probed = true
        return true
      },
    })

    expect(result).toBeNull()
    expect(probed).toBe(false)
  })

  test('falls back to the all-users Docker Desktop install path on Windows when PATH misses', () => {
    const expected = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
    const result = resolveDockerBinary({
      which: () => null,
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: (path) => path === expected,
    })

    expect(result).toBe(expected)
  })

  test('falls back to the per-user Docker Desktop install path on Windows', () => {
    const expected = 'C:\\Users\\me\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe'
    const result = resolveDockerBinary({
      which: () => null,
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      exists: (path) => path === expected,
    })

    expect(result).toBe(expected)
  })

  test.each([
    ['Chocolatey shim', 'C:\\ProgramData\\chocolatey\\bin\\docker.exe'],
    ['Scoop shim', 'C:\\Users\\me\\scoop\\shims\\docker.exe'],
    ['standalone CLI', 'C:\\Program Files\\Docker\\docker.exe'],
    ['Rancher Desktop', 'C:\\Program Files\\Rancher Desktop\\resources\\resources\\win32\\bin\\docker.exe'],
    ['pre-3.3.1 Docker Desktop', 'C:\\Program Files\\Docker\\Docker\\resources\\docker.exe'],
  ])('falls back to the %s install path on Windows', (_label, expected) => {
    const result = resolveDockerBinary({
      which: () => null,
      platform: 'win32',
      env: {
        ProgramFiles: 'C:\\Program Files',
        ProgramData: 'C:\\ProgramData',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\me',
      },
      exists: (path) => path === expected,
    })

    expect(result).toBe(expected)
  })

  test('prefers Docker Desktop over an also-present Rancher Desktop (probe order)', () => {
    const dockerDesktop = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
    const rancher = 'C:\\Program Files\\Rancher Desktop\\resources\\resources\\win32\\bin\\docker.exe'
    const result = resolveDockerBinary({
      which: () => null,
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      exists: (path) => path === dockerDesktop || path === rancher,
    })

    expect(result).toBe(dockerDesktop)
  })

  test('returns null on Windows when docker is on neither PATH nor any known install path', () => {
    const result = resolveDockerBinary({
      which: () => null,
      platform: 'win32',
      env: {
        ProgramFiles: 'C:\\Program Files',
        ProgramData: 'C:\\ProgramData',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\me',
      },
      exists: () => false,
    })

    expect(result).toBeNull()
  })
})

describe('classifyRmStderr', () => {
  test('returns "gone" for "No such container" (case-insensitive)', () => {
    expect(classifyRmStderr('Error: No such container: ati')).toBe('gone')
    expect(classifyRmStderr('error: no such container: ati')).toBe('gone')
  })

  test('returns "in-progress" for "removal of container … is already in progress" (case-insensitive)', () => {
    expect(classifyRmStderr('Error response from daemon: removal of container ati is already in progress')).toBe(
      'in-progress',
    )
    expect(classifyRmStderr('REMOVAL OF CONTAINER X IS ALREADY IN PROGRESS')).toBe('in-progress')
  })

  test('returns null for other stderr (non-benign failures)', () => {
    expect(classifyRmStderr('permission denied')).toBeNull()
    expect(classifyRmStderr('')).toBeNull()
    expect(classifyRmStderr('docker: command not found')).toBeNull()
  })

  test('"no such container" takes precedence when both substrings somehow appear', () => {
    // given: a synthetic stderr that contains both phrases (defensive — we
    // have not seen Docker emit this, but the helper's contract should be
    // total). The 'gone' state is strictly cheaper for callers than
    // 'in-progress', so prefer it when ambiguous.
    expect(classifyRmStderr('Error: No such container: x (removal of container x was already in progress)')).toBe(
      'gone',
    )
  })
})

describe('parseContainerInspectOutput', () => {
  test.each([
    [`${CORPSE_ID}|false\n`, { ok: true, containerId: CORPSE_ID, running: false } as const],
    [`${LIVE_ID}|true\n`, { ok: true, containerId: LIVE_ID, running: true } as const],
  ])('parses exact full-ID and running-state output', (output, expected) => {
    expect(parseContainerInspectOutput(output)).toEqual(expected)
  })

  test.each([
    'short-id|false',
    `${'A'.repeat(64)}|false`,
    `${CORPSE_ID}|yes`,
    `${CORPSE_ID}|`,
    `|false`,
    `${CORPSE_ID}|false|extra`,
  ])('rejects malformed inspect output: %s', (output) => {
    expect(parseContainerInspectOutput(output).ok).toBe(false)
  })
})

describe('isContainerNameConflict', () => {
  test('detects the canonical "container name is already in use" error from docker run', () => {
    const stderr =
      'docker: Error response from daemon: Conflict. The container name "/anderson" is already in use by container "e8d39ae0eb16428c58b143b3a8ac60267ae87ce4fc0f2859022183b512287209". You have to remove (or rename) that container to be able to reuse that name.\n'
    expect(isContainerNameConflict(stderr)).toBe(true)
  })

  test('is case-insensitive', () => {
    expect(isContainerNameConflict('CONTAINER NAME "/x" IS ALREADY IN USE')).toBe(true)
  })

  test('returns false for unrelated docker run errors', () => {
    expect(isContainerNameConflict('docker: Bind for :::8973 failed: port is already allocated')).toBe(false)
    expect(isContainerNameConflict('permission denied')).toBe(false)
    expect(isContainerNameConflict('Error response from daemon: image not found')).toBe(false)
    expect(isContainerNameConflict('')).toBe(false)
  })

  test('requires BOTH "container name" and "is already in use" — neither alone is sufficient', () => {
    expect(isContainerNameConflict('container name was rejected')).toBe(false)
    expect(isContainerNameConflict('port is already in use')).toBe(false)
  })
})

describe('waitForRemoval', () => {
  test('returns true as soon as docker inspect reports the container gone', async () => {
    // given: an exec that returns "exists" twice then "no such container"
    let calls = 0
    const exec: DockerExec = async () => {
      calls += 1
      if (calls >= 3) return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      return { exitCode: 0, stdout: 'false\n', stderr: '' }
    }

    // when
    const ok = await waitForRemoval(exec, 'x', { timeoutMs: 1_000, intervalMs: 10 })

    // then
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })

  test('returns false on timeout when the container is still present', async () => {
    // given: an exec that always reports the container exists
    let calls = 0
    const exec: DockerExec = async () => {
      calls += 1
      return { exitCode: 0, stdout: 'false\n', stderr: '' }
    }

    // when: a short timeout
    const ok = await waitForRemoval(exec, 'x', { timeoutMs: 50, intervalMs: 10 })

    // then
    expect(ok).toBe(false)
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  test('issues docker inspect with the configured name', async () => {
    const seen: string[][] = []
    const exec: DockerExec = async (args) => {
      seen.push(args)
      return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
    }

    await waitForRemoval(exec, 'anderson', { timeoutMs: 100, intervalMs: 10 })

    expect(seen[0]).toEqual(['inspect', '--format', '{{.State.Running}}', 'anderson'])
  })
})

describe('cleanupRunCorpse', () => {
  test('returns "gone" when inspect reports no such container (no rm issued)', async () => {
    let rmIssued = false
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      if (args[0] === 'rm') {
        rmIssued = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x', beforeRemove)).toBe('gone')
    expect(rmIssued).toBe(false)
  })

  test('returns "removed" after removing a non-running corpse and waiting for the drain', async () => {
    // The probe uses `{{.Id}}|{{.State.Running}}` so cleanupRunCorpse can
    // issue rm by ID (closes the TOCTOU window where a peer might create
    // a different live container with the same name between probe and rm).
    let rmCalls = 0
    let inspectCalls = 0
    let rmDone = false
    let rmTarget: string | undefined
    let rmArgs: string[] | undefined
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') {
        inspectCalls++
        if (!rmDone) return { exitCode: 0, stdout: `${CORPSE_ID}|false\n`, stderr: '' }
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      }
      if (args[0] === 'rm') {
        rmCalls++
        rmArgs = args
        rmTarget = args[args.length - 1]
        rmDone = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x', beforeRemove)).toBe('removed')
    expect(rmCalls).toBe(1)
    // rm MUST target the probed ID, not the name — otherwise a same-name
    // peer created between probe and rm would be killed.
    expect(rmTarget).toBe(CORPSE_ID)
    expect(rmArgs).toEqual(['rm', CORPSE_ID])
    // probe inspect + at least one waitForRemoval inspect = 2+
    expect(inspectCalls).toBeGreaterThanOrEqual(2)
  })

  test('returns "running" and does NOT issue rm when the named container is currently running', async () => {
    let rmIssued = false
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: `${LIVE_ID}|true\n`, stderr: '' }
      if (args[0] === 'rm') {
        rmIssued = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x', beforeRemove)).toBe('running')
    expect(rmIssued).toBe(false)
  })

  test('returns "removed" when rm reports "in-progress" and inspect later confirms removal', async () => {
    let rmDone = false
    let postRmInspects = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') {
        if (!rmDone) return { exitCode: 0, stdout: `${CORPSE_ID}|false\n`, stderr: '' }
        postRmInspects++
        if (postRmInspects <= 1) return { exitCode: 0, stdout: 'false\n', stderr: '' }
        return { exitCode: 1, stdout: '', stderr: 'Error: No such container' }
      }
      if (args[0] === 'rm') {
        rmDone = true
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'Error response from daemon: removal of container x is already in progress',
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x', beforeRemove)).toBe('removed')
    expect(postRmInspects).toBeGreaterThanOrEqual(2)
  })

  test('returns "gone" when rm reports the container is already gone', async () => {
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: `${CORPSE_ID}|false\n`, stderr: '' }
      if (args[0] === 'rm') return { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x', beforeRemove)).toBe('gone')
  })

  test('returns "stuck" when rm fails with a non-benign error', async () => {
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: `${CORPSE_ID}|false\n`, stderr: '' }
      if (args[0] === 'rm') return { exitCode: 1, stdout: '', stderr: 'permission denied' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x', beforeRemove)).toBe('stuck')
  })

  test.each(['\n', `short|false\n`, `${CORPSE_ID}|unknown\n`, `${'A'.repeat(64)}|false\n`])(
    'returns "stuck" without archival or removal for malformed inspect output: %s',
    async (stdout) => {
      let archiveIssued = false
      let rmIssued = false
      const exec: DockerExec = async (args) => {
        if (args[0] === 'inspect') return { exitCode: 0, stdout, stderr: '' }
        if (args[0] === 'rm') rmIssued = true
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      const archive = async () => {
        archiveIssued = true
        return { ok: true as const }
      }

      expect(await cleanupRunCorpse(exec, 'x', archive)).toBe('stuck')
      expect(archiveIssued).toBe(false)
      expect(rmIssued).toBe(false)
    },
  )

  test('returns "stuck" when probe stdout is malformed (no ID, defensive)', async () => {
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '\n', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    expect(await cleanupRunCorpse(exec, 'x', beforeRemove)).toBe('stuck')
  })

  test('runs the pre-remove hook before rm and preserves the corpse when it fails', async () => {
    const calls: string[] = []
    const exec: DockerExec = async (args) => {
      calls.push(args[0] ?? '')
      if (args[0] === 'inspect') return { exitCode: 0, stdout: `${'b'.repeat(64)}|false\n`, stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const failArchive = async () => {
      calls.push('archive')
      return { ok: false as const, reason: 'disk full' }
    }

    const result = await cleanupRunCorpse(exec, 'x', failArchive)

    expect(result).toEqual({ archiveFailed: 'disk full' })
    expect(calls).toEqual(['inspect', 'archive'])
  })
})

describe('sanitizeDockerStderr', () => {
  test('strips the trailing "Run docker ... --help" line and surrounding blank lines', () => {
    const stderr =
      'docker: Error response from daemon: Conflict. The container name "/anderson" is already in use by container "3d54c2b59b822a611703889f0b2e2c5805889653335a99eaaecb4d090dc5e2bf". You have to remove (or rename) that container to be able to reuse that name.\n\nRun \'docker run --help\' for more information\n'

    expect(sanitizeDockerStderr(stderr)).toBe(
      'Conflict. The container name "/anderson" is already in use by container "3d54c2b59b822a611703889f0b2e2c5805889653335a99eaaecb4d090dc5e2bf". You have to remove (or rename) that container to be able to reuse that name.',
    )
  })

  test('handles --help variants for other subcommands (build, stop, rm)', () => {
    const stderr = "some build error\n\nRun 'docker build --help' for more information\n"
    expect(sanitizeDockerStderr(stderr)).toBe('some build error')
  })

  test('collapses internal newlines to "; " so the result fits on one line', () => {
    const stderr = 'first detail line\nsecond detail line\nthird detail line'
    expect(sanitizeDockerStderr(stderr)).toBe('first detail line; second detail line; third detail line')
  })

  test('preserves the daemon error body when it stands alone (no docker: prefix)', () => {
    const stderr = 'Error response from daemon: removal of container abc is already in progress\n'
    expect(sanitizeDockerStderr(stderr)).toBe('removal of container abc is already in progress')
  })

  test('preserves substrings that downstream tests assert on (permission denied, etc.)', () => {
    expect(sanitizeDockerStderr('permission denied')).toBe('permission denied')
    expect(sanitizeDockerStderr('docker: permission denied\n')).toBe('permission denied')
  })

  test('returns empty string for empty / whitespace-only input (callers fall back to their own sentinel)', () => {
    expect(sanitizeDockerStderr('')).toBe('')
    expect(sanitizeDockerStderr('   \n\n  ')).toBe('')
    expect(sanitizeDockerStderr("\n\nRun 'docker run --help' for more information\n")).toBe('')
  })

  test('leaves an already-clean single-line message untouched', () => {
    expect(sanitizeDockerStderr('some plain error')).toBe('some plain error')
  })
})

describe('buildxAvailable', () => {
  test('true when `docker buildx version` exits 0', async () => {
    const exec: DockerExec = async (args) => {
      expect(args).toEqual(['buildx', 'version'])
      return { exitCode: 0, stdout: 'buildx v0.33.0\n', stderr: '' }
    }
    expect(await buildxAvailable(exec)).toBe(true)
  })

  test('false when the buildx plugin is missing (non-zero exit)', async () => {
    const exec: DockerExec = async () => ({ exitCode: 1, stdout: '', stderr: 'unknown command "buildx"' })
    expect(await buildxAvailable(exec)).toBe(false)
  })
})

describe('isMissingDockerCredentialHelper', () => {
  test('matches the canonical Windows Docker Desktop helper-not-found build failure', () => {
    const stderr =
      'ERROR: failed to build: failed to solve: error getting credentials - err: exec: ' +
      '"docker-credential-desktop": executable file not found in %PATH%, out: ``'
    expect(isMissingDockerCredentialHelper(stderr)).toBe(true)
  })

  test('matches the Linux "executable file not found in $PATH" phrasing', () => {
    const stderr =
      'error getting credentials - err: exec: "docker-credential-secretservice": ' +
      'executable file not found in $PATH'
    expect(isMissingDockerCredentialHelper(stderr)).toBe(true)
  })

  test('matches the Windows cmd "is not recognized" phrasing', () => {
    const stderr =
      'error getting credentials - err: exec: "docker-credential-desktop.exe": ' +
      "'docker-credential-desktop' is not recognized as an internal or external command"
    expect(isMissingDockerCredentialHelper(stderr)).toBe(true)
  })

  test('does NOT match a genuine private-registry auth failure (no missing helper)', () => {
    const stderr =
      'failed to solve: failed to fetch oauth token: unexpected status from GET request ' +
      'to https://registry.example.com: 401 Unauthorized'
    expect(isMissingDockerCredentialHelper(stderr)).toBe(false)
  })

  test('does NOT match an unrelated build error', () => {
    expect(isMissingDockerCredentialHelper('ERROR: no builder instance found')).toBe(false)
  })
})

describe('dockerConfigDir', () => {
  test('prefers $DOCKER_CONFIG when set', () => {
    expect(dockerConfigDir({ DOCKER_CONFIG: '/custom/docker' }, '/home/me')).toBe('/custom/docker')
  })

  test('falls back to <home>/.docker', () => {
    expect(dockerConfigDir({}, '/home/me')).toBe(join('/home/me', '.docker'))
  })
})

describe('sanitizeDockerConfigJson', () => {
  test('strips credsStore while preserving auths, proxies, and currentContext', () => {
    const raw = JSON.stringify({
      credsStore: 'desktop',
      currentContext: 'orbstack',
      auths: { 'registry.example.com': { auth: 'base64creds' } },
      proxies: { default: { httpProxy: 'http://proxy:3128' } },
    })
    const out = sanitizeDockerConfigJson(raw)
    expect(out).not.toBeNull()
    const parsed = JSON.parse(out as string)
    expect(parsed.credsStore).toBeUndefined()
    expect(parsed.currentContext).toBe('orbstack')
    expect(parsed.auths).toEqual({ 'registry.example.com': { auth: 'base64creds' } })
    expect(parsed.proxies).toEqual({ default: { httpProxy: 'http://proxy:3128' } })
  })

  test('strips credHelpers too', () => {
    const raw = JSON.stringify({ credHelpers: { 'ghcr.io': 'desktop' }, foo: 'bar' })
    const parsed = JSON.parse(sanitizeDockerConfigJson(raw) as string)
    expect(parsed.credHelpers).toBeUndefined()
    expect(parsed.foo).toBe('bar')
  })

  test('returns null when there is nothing to strip (no creds hooks)', () => {
    expect(sanitizeDockerConfigJson(JSON.stringify({ currentContext: 'default' }))).toBeNull()
    expect(sanitizeDockerConfigJson(null)).toBeNull()
    expect(sanitizeDockerConfigJson('')).toBeNull()
  })

  test('treats malformed JSON as empty (nothing to strip)', () => {
    expect(sanitizeDockerConfigJson('{ not json')).toBeNull()
  })
})

describe('dockerBindMount', () => {
  // dockerBindMount resolve()s its src to absolute. A POSIX literal like
  // `/srv/x` is left untouched on POSIX but rewritten to `<drive>:\srv\x` on
  // Windows, so any assertion comparing against the literal diverges there.
  // Build the fixture from an already-absolute, platform-native path so
  // resolve() is a no-op and the expected string matches on every OS.
  const absSrc = (...segments: string[]): string =>
    isWindows() ? `C:\\${segments.join('\\')}` : `/${segments.join('/')}`

  test('emits a single --mount argv pair (src never collides with the dst separator)', () => {
    // given an already-absolute, platform-native source
    const src = absSrc('srv', 'agent')
    const args = dockerBindMount({ src, dst: '/agent' })

    // then the whole spec is one argv element — no `:`-splitting like `-v`
    expect(args).toEqual(['--mount', `type=bind,src=${src},dst=/agent`])
  })

  test('keeps a colon-bearing absolute source intact instead of splitting on it (the Windows drive-letter case)', () => {
    // given an already-absolute source containing a colon — the essence of a
    // Windows drive letter (`C:\...`), which `-v src:dst` would mis-split. Use
    // an absolute path so resolve() is a no-op and the test is platform-stable.
    const drivePath = isWindows() ? 'C:\\Users\\me\\agent' : '/srv/a:b'
    const args = dockerBindMount({ src: drivePath, dst: '/agent' })

    // then the colon stays inside the src= field; dst is a separate CSV key
    expect(args[0]).toBe('--mount')
    expect(args[1]?.startsWith('type=bind,')).toBe(true)
    expect(args[1]).toContain(`src=${drivePath}`)
    expect(args[1]).toContain('dst=/agent')
  })

  test('appends the readonly field only when readonly is true', () => {
    const src = absSrc('srv', 'x')
    expect(dockerBindMount({ src, dst: '/opt/models', readonly: true })[1]).toBe(
      `type=bind,src=${src},dst=/opt/models,readonly`,
    )
    expect(dockerBindMount({ src, dst: '/agent', readonly: false })[1]).not.toContain('readonly')
  })

  test('resolves a relative source to an absolute path (docker --mount rejects relative src)', () => {
    const args = dockerBindMount({ src: 'rel/dir', dst: '/agent' })
    expect(args[1]).toContain(`src=${join(process.cwd(), 'rel', 'dir')}`)
  })

  test('throws on a comma in a path because --mount cannot express it', () => {
    expect(() => dockerBindMount({ src: '/srv/a,b', dst: '/agent' })).toThrow(/comma/)
  })
})

describe('spawnInheritTeeStderr', () => {
  test('kills the child and awaits its exit when a stderr read throws', async () => {
    let killed = false
    let resolveExited: (code: number) => void = () => {}
    const exited = new Promise<number>((resolve) => {
      resolveExited = resolve
    })
    let firstRead = true
    const stderr = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (firstRead) {
          firstRead = false
          controller.enqueue(new TextEncoder().encode('some build output'))
          return
        }
        throw new Error('stderr read failed')
      },
    })
    const proc = {
      stderr,
      exited,
      kill() {
        killed = true
        resolveExited(137)
      },
    }
    const bun = { spawn: () => proc } as unknown as Parameters<typeof spawnInheritTeeStderr>[0]

    await expect(spawnInheritTeeStderr(bun, ['docker', 'build'], undefined, undefined, undefined)).rejects.toThrow(
      'stderr read failed',
    )

    // kill() resolving `exited` is what proves spawnInheritTeeStderr awaited the
    // child rather than orphaning it — the promise below only settles once kill
    // fires resolveExited.
    expect(killed).toBe(true)
    expect(await exited).toBe(137)
    expect(stderr.locked).toBe(false)
  })
})

describe('readCapturedStream', () => {
  test('drains the stream while retaining only the requested tail', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first-'))
        controller.enqueue(new TextEncoder().encode('second'))
        controller.close()
      },
    })

    expect(await readCapturedStream(stream, 6)).toBe('second')
    expect(stream.locked).toBe(false)
  })

  test('drains discarded output without retaining it', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('verbose build output'))
        controller.close()
      },
    })

    expect(await readCapturedStream(stream, 0)).toBe('')
    expect(stream.locked).toBe(false)
  })
})
