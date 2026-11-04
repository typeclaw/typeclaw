import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildGitCredentialEnv } from './git-credential-env'

const git = Bun.which('git')
const gitExecutable = git ?? 'git'

// Linux-only by design, not convenience: the control case proves the leak by
// having git-remote-ext run `sh -c … > <path>`, and a Windows path through that
// redirection never lands the side-effect file, so the control would assert
// nothing. Brokered git runs only in the Linux container stage anyway.
const unsupportedHost = git === null || process.platform === 'win32'

test.skipIf(unsupportedHost)('blocks local https-to-ext rewrites from inheriting the brokered token', () => {
  const root = mkdtempSync(join(tmpdir(), 'typeclaw-git-protocol-'))
  const repo = join(root, 'repo')
  const pwned = join(root, 'pwned')
  const run = (args: string[], credentialEnv?: Record<string, string>) => {
    const env = { ...process.env, ...credentialEnv }
    if (credentialEnv !== undefined && !('GIT_ALLOW_PROTOCOL' in credentialEnv)) delete env.GIT_ALLOW_PROTOCOL
    return Bun.spawnSync([gitExecutable, ...args], { timeout: 30_000, cwd: repo, env, stderr: 'pipe', stdout: 'pipe' })
  }

  try {
    expect(
      Bun.spawnSync([gitExecutable, 'init', repo], { timeout: 30_000, stderr: 'pipe', stdout: 'pipe' }).exitCode,
    ).toBe(0)
    expect(run(['config', '--local', 'protocol.ext.allow', 'always']).exitCode).toBe(0)
    expect(
      run(['config', '--local', `url.ext::sh -c echo% PWNED% >% ${pwned} ignored-.insteadOf`, 'https://github.com/'])
        .exitCode,
    ).toBe(0)

    const protectedEnv = buildGitCredentialEnv('tok', '/nonexistent-askpass')
    const blocked = run(['ls-remote', 'https://github.com/acme/widgets.git'], protectedEnv)
    expect(blocked.exitCode).not.toBe(0)
    expect(new TextDecoder().decode(blocked.stderr)).toMatch(/transport ['"]ext['"] not allowed/i)
    expect(existsSync(pwned)).toBe(false)

    const controlEnv = buildGitCredentialEnv('tok', '/nonexistent-askpass')
    delete controlEnv.GIT_ALLOW_PROTOCOL
    run(['ls-remote', 'https://github.com/acme/widgets.git'], controlEnv)
    expect(existsSync(pwned)).toBe(true)
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test.skipIf(unsupportedHost)(
  'defaults to no proxy, verified TLS, and the system CA while suppressing hostile repository config',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'typeclaw-git-http-config-'))
    const repo = join(root, 'repo')
    const run = (args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync([gitExecutable, ...args], {
        timeout: 30_000,
        cwd: repo,
        env: { ...process.env, ...env },
        stderr: 'pipe',
        stdout: 'pipe',
      })
    const text = (result: ReturnType<typeof run>): string => new TextDecoder().decode(result.stdout).trim()

    try {
      expect(
        Bun.spawnSync([gitExecutable, 'init', repo], { timeout: 30_000, stderr: 'pipe', stdout: 'pipe' }).exitCode,
      ).toBe(0)
      const url = 'https://github.com/acme/widgets.git'
      expect(run(['config', '--local', `http.${url}.proxy`, 'http://attacker.invalid:8080']).exitCode).toBe(0)
      expect(run(['config', '--local', `http.${url}.sslVerify`, 'false']).exitCode).toBe(0)
      expect(run(['config', '--local', `http.${url}.sslCAInfo`, '/repo/attacker-ca.pem']).exitCode).toBe(0)
      expect(run(['config', '--local', 'remote.origin.proxy', 'http://attacker.invalid:8080']).exitCode).toBe(0)
      const helperMarker = join(root, 'credential-helper-ran')
      const helper = `!sh -c 'printf %s "$TYPECLAW_GIT_TOKEN" > "${helperMarker}"' -`
      expect(run(['config', '--local', 'credential.useHttpPath', 'true']).exitCode).toBe(0)
      expect(run(['config', '--local', `credential.${url}.helper`, helper]).exitCode).toBe(0)

      const credentialInput = Buffer.from('protocol=https\nhost=github.com\npath=acme/widgets.git\n\n')
      Bun.spawnSync([gitExecutable, 'credential', 'fill'], {
        timeout: 30_000,
        cwd: repo,
        env: { ...process.env, TYPECLAW_GIT_TOKEN: 'control-token', GIT_TERMINAL_PROMPT: '0' },
        stdin: credentialInput,
        stderr: 'pipe',
        stdout: 'pipe',
      })
      expect(existsSync(helperMarker)).toBe(true)
      rmSync(helperMarker)

      const env = buildGitCredentialEnv([{ repoSlug: 'acme/widgets', token: 'tok' }], '/nonexistent-askpass', {
        trustedEnv: {},
        expectedRemote: 'origin',
      })
      expect(text(run(['config', '--get-urlmatch', 'credential.helper', url], env))).toBe('')
      expect(text(run(['config', '--get-urlmatch', 'http.proxy', url], env))).toBe('')
      expect(text(run(['config', '--get-urlmatch', 'http.sslVerify', url], env))).toBe('true')
      expect(text(run(['config', '--get-urlmatch', 'http.sslCAInfo', url], env))).toBe(
        '/etc/ssl/certs/ca-certificates.crt',
      )
      expect(text(run(['config', '--get', 'remote.origin.proxy'], env))).toBe('')
      Bun.spawnSync([gitExecutable, 'credential', 'fill'], {
        timeout: 30_000,
        cwd: repo,
        env: { ...process.env, ...env },
        stdin: credentialInput,
        stderr: 'pipe',
        stdout: 'pipe',
      })
      expect(existsSync(helperMarker)).toBe(false)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  },
)

test.skipIf(unsupportedHost)(
  'trusted operator proxy, custom CA, and no-proxy settings override repository config',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'typeclaw-git-trusted-http-'))
    const repo = join(root, 'repo')
    const run = (args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync([gitExecutable, ...args], {
        timeout: 30_000,
        cwd: repo,
        env: { ...process.env, ...env },
        stderr: 'pipe',
        stdout: 'pipe',
      })
    const text = (args: string[], env: Record<string, string>): string =>
      new TextDecoder().decode(run(args, env).stdout).trim()

    try {
      expect(
        Bun.spawnSync([gitExecutable, 'init', repo], { timeout: 30_000, stderr: 'pipe', stdout: 'pipe' }).exitCode,
      ).toBe(0)
      const url = 'https://github.com/acme/widgets.git'
      expect(run(['config', '--local', `http.${url}.proxy`, 'http://repo.invalid:8080']).exitCode).toBe(0)
      expect(run(['config', '--local', `http.${url}.sslVerify`, 'false']).exitCode).toBe(0)
      expect(run(['config', '--local', `http.${url}.sslCAInfo`, '/repo/attacker-ca.pem']).exitCode).toBe(0)
      expect(run(['config', '--local', 'remote.origin.proxy', 'http://repo.invalid:8080']).exitCode).toBe(0)

      const env = buildGitCredentialEnv([{ repoSlug: 'acme/widgets', token: 'tok' }], '/nonexistent-askpass', {
        expectedRemote: 'origin',
        trustedEnv: {
          HTTPS_PROXY: 'http://operator-proxy.example:8443',
          https_proxy: 'http://ignored-lowercase.example:8443',
          HTTP_PROXY: 'http://ignored-http.example:8080',
          GIT_SSL_CAINFO: '/opt/operator/ca.pem',
          SSL_CERT_FILE: '/opt/ignored/ssl-cert.pem',
          CURL_CA_BUNDLE: '/opt/ignored/curl-ca.pem',
          NO_PROXY: 'github.com,.example.com',
          no_proxy: 'localhost,127.0.0.1',
        },
      })

      expect(text(['config', '--get-urlmatch', 'http.proxy', url], env)).toBe('http://operator-proxy.example:8443')
      expect(text(['config', '--get-urlmatch', 'http.sslVerify', url], env)).toBe('true')
      expect(text(['config', '--get-urlmatch', 'http.sslCAInfo', url], env)).toBe('/opt/operator/ca.pem')
      expect(text(['config', '--get', 'remote.origin.proxy'], env)).toBe('http://operator-proxy.example:8443')
      expect(env).not.toHaveProperty('NO_PROXY')
      expect(env).not.toHaveProperty('no_proxy')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  },
)

test.skipIf(unsupportedHost)(
  'binds trusted transport overrides to case-preserving HTTPS and rewritten SSH push URLs',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'typeclaw-git-case-http-'))
    const repo = join(root, 'repo')
    const run = (args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync([gitExecutable, ...args], {
        timeout: 30_000,
        cwd: repo,
        env: { ...process.env, ...env },
        stderr: 'pipe',
        stdout: 'pipe',
      })
    const text = (args: string[], env: Record<string, string>): string =>
      new TextDecoder().decode(run(args, env).stdout).trim()

    try {
      expect(
        Bun.spawnSync([gitExecutable, 'init', repo], { timeout: 30_000, stderr: 'pipe', stdout: 'pipe' }).exitCode,
      ).toBe(0)
      const mixedCaseUrl = 'https://github.com/Acme/Widgets.git'
      for (const key of ['proxy', 'sslCAInfo', 'sslVerify']) {
        const hostile = key === 'sslVerify' ? 'false' : key === 'proxy' ? 'http://repo.invalid:8080' : '/repo/ca.pem'
        expect(run(['config', '--local', `http.${mixedCaseUrl}.${key}`, hostile]).exitCode).toBe(0)
      }

      const env = buildGitCredentialEnv(
        [
          { repoSlug: 'acme/widgets', token: 'first' },
          { repoSlug: 'acme/other', token: 'second' },
        ],
        '/nonexistent-askpass',
        {
          pushUrls: [mixedCaseUrl, 'git@github.com:Acme/Other.git'],
          trustedEnv: {
            HTTPS_PROXY: 'http://operator.example:8443',
            GIT_SSL_CAINFO: '/operator/ca.pem',
          },
        },
      )

      for (const url of [mixedCaseUrl, 'https://github.com/Acme/Other.git']) {
        expect(text(['config', '--get-urlmatch', 'http.proxy', url], env)).toBe('http://operator.example:8443')
        expect(text(['config', '--get-urlmatch', 'http.sslCAInfo', url], env)).toBe('/operator/ca.pem')
        expect(text(['config', '--get-urlmatch', 'http.sslVerify', url], env)).toBe('true')
      }
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  },
)
