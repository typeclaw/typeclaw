import { describe, expect, test } from 'bun:test'

import {
  GUARD_GLOBAL_INSTALL,
  GUARD_NON_BUN_PACKAGE_MANAGER,
  GUARD_NON_BUN_PACKAGE_RUNNER,
  checkBunHygieneGuard,
  checkGlobalInstallGuard,
  checkNonBunPackageManagerGuard,
  checkNonBunPackageRunnerGuard,
} from './policy'

function bash(command: string, extra: Record<string, unknown> = {}) {
  return checkBunHygieneGuard({ tool: 'bash', args: { command, ...extra } })
}

describe('checkBunHygieneGuard — global installs', () => {
  test.each([
    'npm install -g typescript',
    'npm i -g typescript',
    'npm install --global typescript',
    'npm -g install typescript',
    'pnpm add -g typescript',
    'pnpm add --global typescript',
    'yarn global add typescript',
    'bun add -g typescript',
    'bun install -g typescript',
    'bun add --global typescript',
    'npm install -gD typescript',
    'sudo npm install -g typescript',
    'env FOO=bar npm install -g typescript',
  ])('blocks %p', (command) => {
    const result = bash(command)
    expect(result?.kind).toBe('acknowledgement-required')
    expect(result?.reason).toContain(GUARD_GLOBAL_INSTALL)
  })

  test('block reason guides toward bun add / bunx', () => {
    const result = bash('npm install -g typescript')
    expect(result?.reason).toContain('bun add')
    expect(result?.reason).toContain('bunx')
  })

  test('reports globalInstall without reading acknowledgement arguments', () => {
    expect(bash('npm install -g typescript')?.kind).toBe('acknowledgement-required')
  })
})

describe('checkBunHygieneGuard — non-bun package managers', () => {
  test.each([
    'npm install',
    'npm run build',
    'pnpm install',
    'yarn',
    'yarn add lodash',
    'cd app && npm install',
    'echo done; npm run build',
  ])('blocks %p', (command) => {
    const result = bash(command)
    expect(result?.kind).toBe('acknowledgement-required')
    expect(result?.reason).toContain(GUARD_NON_BUN_PACKAGE_MANAGER)
  })

  test.each(['npx create-next-app', 'pnpx cowsay hi', 'cd app && npx tsc', 'echo done; npx tsc'])(
    'blocks non-bun runner %p',
    (command) => {
      const result = bash(command)
      expect(result?.kind).toBe('acknowledgement-required')
      expect(result?.reason).toContain(GUARD_NON_BUN_PACKAGE_RUNNER)
    },
  )

  test('reports nonBunPackageManager without reading acknowledgement arguments', () => {
    expect(bash('npm install')?.kind).toBe('acknowledgement-required')
  })

  // A global install is the more specific violation: acknowledging it must not
  // also require acknowledging nonBunPackageManager for the same command.
  test('global install takes precedence over the non-bun guard', () => {
    expect(bash('npm install -g typescript')?.reason).toContain(GUARD_GLOBAL_INSTALL)
    expect(
      checkNonBunPackageManagerGuard({ tool: 'bash', args: { command: 'npm install -g typescript' } }),
    ).toBeUndefined()
  })

  // The global-install verdict subsumes the manager verdict only within its own
  // segment. Regression guard: classify() used to return early on the first
  // global install, which dropped every later segment's verdict — so a lone
  // globalInstall acknowledgement silently ran the runner segment too.
  test('acknowledging a compound command global install still surfaces its runner violation', () => {
    expect(bash('bun add -g foo && npx tsc')?.reason).toContain(GUARD_GLOBAL_INSTALL)

    expect(checkGlobalInstallGuard({ tool: 'bash', args: { command: 'bun add -g foo && npx tsc' } })?.reason).toContain(
      GUARD_GLOBAL_INSTALL,
    )
    expect(
      checkNonBunPackageRunnerGuard({ tool: 'bash', args: { command: 'bun add -g foo && npx tsc' } })?.reason,
    ).toContain(GUARD_NON_BUN_PACKAGE_RUNNER)
  })

  // Same scoping rule for a manager in a different segment: the global install
  // clears its own segment, not the separate `pnpm install`.
  test('acknowledging a global install still surfaces a manager violation elsewhere', () => {
    expect(
      checkNonBunPackageManagerGuard({ tool: 'bash', args: { command: 'npm install -g typescript && pnpm install' } })
        ?.reason,
    ).toContain(GUARD_NON_BUN_PACKAGE_MANAGER)
  })

  test('non-bun manager takes precedence over a non-bun runner', () => {
    expect(bash('npm install && npx tsc')?.reason).toContain(GUARD_NON_BUN_PACKAGE_MANAGER)

    expect(
      checkNonBunPackageRunnerGuard({ tool: 'bash', args: { command: 'npm install && npx tsc' } })?.reason,
    ).toContain(GUARD_NON_BUN_PACKAGE_RUNNER)
  })
})

describe('checkBunHygieneGuard — non-bun package runners', () => {
  test('block reason explains bunx and the exact bypass', () => {
    const result = bash('npx tsc')
    expect(result?.reason).toContain(GUARD_NON_BUN_PACKAGE_RUNNER)
    expect(result?.reason).toContain('Bun-native equivalent')
    expect(result?.reason).toContain('absent from the default image')
    expect(result?.reason).toContain('`bunx <pkg>`')
    expect(result?.reason).toContain(`acknowledgeGuards.bun-hygiene.${GUARD_NON_BUN_PACKAGE_RUNNER}: true`)
  })

  test('reports nonBunPackageRunner without reading acknowledgement arguments', () => {
    expect(bash('npx tsc')?.kind).toBe('acknowledgement-required')
  })

  test.each(['\\npx tsc', '"npx" tsc', 'FOO=bar npx tsc', 'sudo npx tsc'])('blocks obfuscated runner %p', (command) => {
    expect(bash(command)?.reason).toContain(GUARD_NON_BUN_PACKAGE_RUNNER)
  })
})

describe('checkBunHygieneGuard — escaped/quoted evasion', () => {
  // The shell strips quotes and backslash escapes before resolving the binary,
  // so these all run the real npm/npx and must be caught despite obfuscation.
  test.each(['\\npm install', '"npm" install', "'npm' install", "'pnpm' install", 'cd app && \\npm install'])(
    'blocks obfuscated non-bun manager %p',
    (command) => {
      const result = bash(command)
      expect(result?.kind).toBe('acknowledgement-required')
      expect(result?.reason).toContain(GUARD_NON_BUN_PACKAGE_MANAGER)
    },
  )

  test.each([
    'np\\m install -g typescript',
    '\\npm install -g typescript',
    '"npm" install -g typescript',
    "'pnpm' add --global typescript",
  ])('blocks obfuscated global install %p', (command) => {
    const result = bash(command)
    expect(result?.kind).toBe('acknowledgement-required')
    expect(result?.reason).toContain(GUARD_GLOBAL_INSTALL)
  })
})

describe('checkBunHygieneGuard — option placement in global installs', () => {
  // Options between the manager and its subcommand/flag must still resolve to
  // globalInstall (the specific guard), not fall through to nonBunPackageManager.
  test.each([
    'npm --prefix /tmp install -g typescript',
    'npm --loglevel warn install -g foo',
    'npm install --foo-bar baz -g typescript',
    'pnpm --dir /x add -g foo',
    'bun --cwd /x add -g foo',
    'pnpm add --reporter silent -g foo',
  ])('attributes %p to globalInstall', (command) => {
    const result = bash(command)
    expect(result?.kind).toBe('acknowledgement-required')
    expect(result?.reason).toContain(GUARD_GLOBAL_INSTALL)
  })
})

describe('checkBunHygieneGuard — leading assignment / preamble words', () => {
  // `FOO=bar npm install` runs npm with FOO set, so the manager must be found
  // behind a bare `VAR=val` assignment, not just behind `sudo` / `env`.
  test.each([
    ['FOO=bar npm install', GUARD_NON_BUN_PACKAGE_MANAGER],
    ['FOO=bar BAR=baz npm install -g typescript', GUARD_GLOBAL_INSTALL],
    ['command npm install', GUARD_NON_BUN_PACKAGE_MANAGER],
    ['exec npm install -g x', GUARD_GLOBAL_INSTALL],
    // Optioned wrappers: the wrapper's own flags (and any flag arguments they
    // consume) must be skipped so the manager behind them is still found.
    ['env -i npm install', GUARD_NON_BUN_PACKAGE_MANAGER],
    ['sudo -u nobody pnpm add foo', GUARD_NON_BUN_PACKAGE_MANAGER],
    ['env -i npm install -g typescript', GUARD_GLOBAL_INSTALL],
    ['sudo -u nobody npm install -g x', GUARD_GLOBAL_INSTALL],
    ['stdbuf -oL npm install', GUARD_NON_BUN_PACKAGE_MANAGER],
    ['env FOO=bar -i BAR=baz npm install', GUARD_NON_BUN_PACKAGE_MANAGER],
    ['sudo -E npm install', GUARD_NON_BUN_PACKAGE_MANAGER],
  ])('sees through preamble in %p', (command, guard) => {
    expect(bash(command)?.reason).toContain(guard)
  })

  // The wrapper's consumed argument must not be mistaken for the command word:
  // `sudo -u nobody ls` runs ls (allowed), not a manager.
  test.each(['nice -n 10 echo hi', 'sudo -u nobody ls -g', 'env -i sh', 'stdbuf -oL cat x'])(
    'does not block wrapped non-manager command %p',
    (command) => {
      expect(bash(command)).toBeUndefined()
    },
  )

  test.each(['nice -n 10 npx create-next-app', 'sudo -u nobody pnpx cowsay hi'])(
    'blocks wrapped non-bun runner %p',
    (command) => {
      expect(bash(command)?.reason).toContain(GUARD_NON_BUN_PACKAGE_RUNNER)
    },
  )
})

describe('checkBunHygieneGuard — newline is a command separator', () => {
  // `npm install` and `-g typescript` on separate lines are two commands; the
  // `-g` does NOT make the install global. Misclassifying as globalInstall would
  // let a globalInstall ack wrongly bypass the npm-install line.
  test.each(['npm install\n-g typescript', 'npm install\n--global x', 'npm install\nrm -rf x'])(
    'classifies %p as a plain non-bun manager, not a global install',
    (command) => {
      expect(bash(command)?.reason).toContain(GUARD_NON_BUN_PACKAGE_MANAGER)
    },
  )
})

describe('checkBunHygieneGuard — backslash-newline line continuation', () => {
  // `\<newline>` is a shell line continuation (removed, text joined), so these
  // are single commands. The `-g`/`--global` after the break must still count,
  // unlike a real newline which separates commands.
  test.each([
    'npm install \\\n-g typescript',
    'npm install -g \\\ntypescript',
    'npm \\\n  install -g typescript',
    'npm install \\\n  --global typescript',
    'npm install \\\r\n-g typescript',
  ])('treats %p as one command and blocks the global install', (command) => {
    expect(bash(command)?.reason).toContain(GUARD_GLOBAL_INSTALL)
  })

  test('a real newline still separates commands (not a global install)', () => {
    expect(bash('npm install\n-g typescript')?.reason).toContain(GUARD_NON_BUN_PACKAGE_MANAGER)
  })
})

describe('checkBunHygieneGuard — yarn global add is order-sensitive', () => {
  test('blocks the real `yarn global add` sequence', () => {
    expect(bash('yarn global add typescript')?.reason).toContain(GUARD_GLOBAL_INSTALL)
  })

  // `yarn add global foo` installs a package literally named `global`; it is a
  // local install, not `yarn global add`. Both tokens present but not adjacent.
  test.each(['yarn add global foo', 'yarn add foo global'])('does not treat %p as a global install', (command) => {
    expect(bash(command)?.reason).toContain(GUARD_NON_BUN_PACKAGE_MANAGER)
  })
})

describe('checkBunHygieneGuard — explicit falsy --global is not a global install', () => {
  test.each(['npm install --global=false lodash', 'npm install --global=0 lodash', 'npm install --global=off lodash'])(
    'treats %p as a local install',
    (command) => {
      expect(bash(command)?.reason).toContain(GUARD_NON_BUN_PACKAGE_MANAGER)
    },
  )

  test('still blocks an explicit truthy --global', () => {
    expect(bash('npm install --global=true lodash')?.reason).toContain(GUARD_GLOBAL_INSTALL)
  })
})

describe('checkBunHygieneGuard — subshell / command substitution', () => {
  test.each(['(npm install -g x)', '$(npm i -g x)', '`npm install -g x`'])(
    'detects the manager inside %p',
    (command) => {
      expect(bash(command)?.reason).toContain(GUARD_GLOBAL_INSTALL)
    },
  )
})

describe('checkBunHygieneGuard — command substitution inside double quotes', () => {
  // Bash executes `$(...)` and backtick substitutions inside double quotes, so
  // the manager inside them must be detected.
  test.each([
    ['echo "$(npm install)"', GUARD_NON_BUN_PACKAGE_MANAGER],
    ['echo "$(npm install -g x)"', GUARD_GLOBAL_INSTALL],
    ['echo "`npm install`"', GUARD_NON_BUN_PACKAGE_MANAGER],
    ['echo "`npm install -g x`"', GUARD_GLOBAL_INSTALL],
    ['X="$(npm i -g foo)"', GUARD_GLOBAL_INSTALL],
    ['echo "$(echo $(npm i -g x))"', GUARD_GLOBAL_INSTALL],
  ])('detects the manager inside %p', (command, guard) => {
    expect(bash(command)?.reason).toContain(guard)
  })

  // The outer double quote must resume after the substitution closes, so a
  // trailing real command is not swallowed.
  test('still sees a command after the substitution closes', () => {
    expect(bash('echo "$(date)" && npm install -g x')?.reason).toContain(GUARD_GLOBAL_INSTALL)
  })

  // Single quotes do NOT substitute in Bash, so these stay inert.
  test.each(["echo '$(npm install)'", "echo '`npm install -g x`'"])('leaves single-quoted %p inert', (command) => {
    expect(bash(command)).toBeUndefined()
  })

  // A plain double-quoted string that merely mentions a manager (no `$(`/
  // backtick) must not be misclassified.
  test.each(['echo "install npm globally please"', 'echo "use npm or yarn"', 'echo "price is $5"', 'echo "$HOME"'])(
    'does not block plain double-quoted text %p',
    (command) => {
      expect(bash(command)).toBeUndefined()
    },
  )
})

describe('checkBunHygieneGuard — allowed commands', () => {
  test.each([
    'bun install',
    'bun add lodash',
    'bun add -d typescript',
    'bunx tsc',
    'bunx create-next-app my-app',
    'bun x cowsay hi',
    'bun run build',
    'ls -g',
    './npm-wrapper.sh',
    'echo "npm install -g foo"',
    'cat npm-debug.log',
    'git commit -m "switch from npm to bun"',
    'my-npm-tool --global',
    'grep -rn npx src/',
  ])('allows %p', (command) => {
    expect(bash(command)).toBeUndefined()
  })

  test.each(['npx tsc', 'npx create-next-app my-app', 'pnpx cowsay hi'])('blocks non-bun runner %p', (command) => {
    expect(bash(command)?.reason).toContain(GUARD_NON_BUN_PACKAGE_RUNNER)
  })
})

describe('checkBunHygieneGuard — non-bash tools', () => {
  test('ignores non-bash tools', () => {
    expect(checkBunHygieneGuard({ tool: 'write', args: { command: 'npm install -g x' } })).toBeUndefined()
  })

  test('ignores missing command arg', () => {
    expect(checkBunHygieneGuard({ tool: 'bash', args: {} })).toBeUndefined()
  })
})
