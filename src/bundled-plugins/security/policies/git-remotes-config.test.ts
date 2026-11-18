import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { checkGitRemotesConfigGuard } from './git-remotes-config'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function agentWith(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-git-remotes-guard-'))
  dirs.push(dir)
  await writeFile(join(dir, 'typeclaw.json'), `${JSON.stringify(config, null, 2)}\n`)
  return dir
}

function write(agentDir: string, config: unknown) {
  return checkGitRemotesConfigGuard({
    tool: 'write',
    args: { path: 'typeclaw.json', content: `${JSON.stringify(config, null, 2)}\n` },
    agentDir,
  })
}

const ORIGIN = 'https://github.com/acme/agent.git'

describe('gitRemotesConfig guard', () => {
  test('blocks adding a remote', async () => {
    const agentDir = await agentWith({})

    const result = await write(agentDir, { git: { remotes: { origin: 'https://attacker.example/x.git' } } })

    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('gitRemotesConfig')
    expect(result?.reason).toContain('`origin`')
    expect(result?.reason).not.toContain('attacker.example')
  })

  test('blocks re-pointing an existing remote', async () => {
    const agentDir = await agentWith({ git: { remotes: { origin: ORIGIN } } })

    const result = await write(agentDir, { git: { remotes: { origin: 'https://carol:pa55@attacker.example/x.git' } } })

    expect(result?.block).toBe(true)
    expect(result?.reason).not.toContain('pa55')
    expect(result?.reason).not.toContain('github.com/acme')
  })

  test('allows removing a remote, keeping remotes as they are, and unrelated edits', async () => {
    const agentDir = await agentWith({ alias: ['atlas'], git: { remotes: { origin: ORIGIN, mirror: ORIGIN } } })

    expect(await write(agentDir, { alias: ['atlas'], git: { remotes: { origin: ORIGIN } } })).toBeUndefined()
    expect(
      await write(agentDir, { alias: ['atlas', '아틀라스'], git: { remotes: { origin: ORIGIN, mirror: ORIGIN } } }),
    ).toBeUndefined()
    expect(
      await checkGitRemotesConfigGuard({
        tool: 'edit',
        args: { path: 'typeclaw.json', edits: [{ oldText: '"atlas"', newText: '"atlas", "아틀라스"' }] },
        agentDir,
      }),
    ).toBeUndefined()
  })

  test('sees typeclaw.json through the file: URI forms the file tools decode', async () => {
    const agentDir = await agentWith({})
    const content = JSON.stringify({ git: { remotes: { origin: 'https://attacker.example/x.git' } } })

    for (const ref of [
      pathToFileURL(join(agentDir, 'typeclaw.json')).href,
      `  ${pathToFileURL(join(agentDir, 'typeclaw.json')).href}`,
    ]) {
      const result = await checkGitRemotesConfigGuard({ tool: 'write', args: { path: ref, content }, agentDir })
      expect(result?.block).toBe(true)
    }
  })

  test('blocks an edit of typeclaw.json whose result it cannot preview', async () => {
    const agentDir = await agentWith({ alias: ['atlas'] })

    const result = await checkGitRemotesConfigGuard({
      tool: 'edit',
      args: { path: 'typeclaw.json', edits: [{ oldText: '"atlas" ', newText: '"atlas", "x"' }] },
      agentDir,
    })

    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('write')
  })

  test('ignores files other than typeclaw.json', async () => {
    const agentDir = await agentWith({})

    expect(
      await checkGitRemotesConfigGuard({
        tool: 'write',
        args: { path: 'workspace/typeclaw.json', content: JSON.stringify({ git: { remotes: { origin: ORIGIN } } }) },
        agentDir,
      }),
    ).toBeUndefined()
  })
})
