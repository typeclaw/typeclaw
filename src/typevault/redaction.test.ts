import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient, parseEntryName } from 'typevault'

import { reconcileTypevault } from './lifecycle'
import { vaultSecretValues } from './redaction'
import { ensureRoleTiers, typevaultDir, typevaultEnv } from './vault'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test('a secret stays redacted after its entry is overwritten or deleted, and runtime and text fields never are', async () => {
  // given: an enabled vault with a login (secret password, public username)
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-typevault-redaction-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'secrets.json'), '{"version":2,"providers":{},"channels":{},"mcp":{}}\n')
  await reconcileTypevault(dir, true)
  await ensureRoleTiers(dir, ['owner', 'trusted', 'member', 'guest'])
  const vault = await createClient({ direct: true, global: true, dir: typevaultDir(dir), env: typevaultEnv(dir) })
  const login = parseEntryName('typevault://shop/login')
  const store = (password: string) =>
    vault.set({
      name: login,
      tier: 'member',
      fields: { username: { type: 'text', value: 'public-username' }, password: { type: 'secret', value: password } },
    })
  await store('first-password-value')
  const initial = await vaultSecretValues(dir)

  // when: the password is replaced, then the entry is deleted
  await store('second-password-value')
  const afterOverwrite = await vaultSecretValues(dir)
  await vault.remove(login)
  const afterDelete = await vaultSecretValues(dir)

  // then
  expect(initial).toEqual(['first-password-value'])
  expect([...afterOverwrite].sort()).toEqual(['first-password-value', 'second-password-value'])
  expect([...afterDelete].sort()).toEqual(['first-password-value', 'second-password-value'])
})
