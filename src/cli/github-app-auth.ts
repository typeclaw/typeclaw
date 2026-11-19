import type { Readable, Writable } from 'node:stream'

import { isCancel, log, multiselect, note, password, select, spinner, text } from '@clack/prompts'

import {
  checkGithubAppName,
  exchangeGithubAppManifestCode,
  githubAppInstallUrl,
  startGithubAppManifestSession,
  suggestGithubAppName,
  validateGithubAppName,
  validateGithubAppOwner,
  waitForGithubAppInstallation,
  type GithubAppManifestSession,
} from '@/init/github-app-manifest'

import { openBrowserBestEffort } from './open-browser'
import { CANCEL_SYMBOL, promptPrivateKeyPem } from './prompt-pem'

export type GithubAppAuthResult = {
  auth: { type: 'app'; appId: number; privateKey: string }
  // Repositories the new App's installation can access; undefined when the
  // App already existed or the installation was not seen in time.
  repos?: string[]
}

const INSTALLATION_WAIT_MS = 15 * 60 * 1000

// Shared by `typeclaw channel add github`, `typeclaw init`, and the
// switch-to-App path of `typeclaw channel set github`. Returns null on cancel
// so each caller keeps its own cancel semantics (exit vs. wizard back-step).
// `pickRepos: false` is for `channel set`, which only replaces credentials and
// never edits the repository allowlist.
export async function promptGithubAppAuth(
  agentDir: string,
  options: { pickRepos: boolean } = { pickRepos: true },
): Promise<GithubAppAuthResult | null> {
  const mode = await select<'create' | 'existing'>({
    message: 'GitHub App',
    options: [
      { value: 'create', label: 'Create a new GitHub App for me (recommended)' },
      { value: 'existing', label: 'Use an existing GitHub App (App ID + private key)' },
    ],
    initialValue: 'create',
  })
  if (isCancel(mode)) return null
  return mode === 'create' ? await createGithubApp(agentDir, options.pickRepos) : await promptExistingGithubApp()
}

async function promptExistingGithubApp(): Promise<GithubAppAuthResult | null> {
  const appId = await text({
    message: 'GitHub App ID',
    validate: (value) => {
      const parsed = Number(value)
      if (!value) return 'App ID is required'
      return Number.isInteger(parsed) && parsed > 0 ? undefined : 'Must be a positive integer'
    },
  })
  if (isCancel(appId)) return null
  const privateKey = await promptPrivateKeyPem('GitHub App private key PEM, escaped PEM, or path to .pem file')
  if (privateKey === CANCEL_SYMBOL) return null
  return { auth: { type: 'app', appId: Number(appId), privateKey } }
}

async function createGithubApp(agentDir: string, pickRepos: boolean): Promise<GithubAppAuthResult | null> {
  note(
    [
      'TypeClaw opens GitHub with every permission the channel needs already filled in.',
      'You confirm once, then install the App on the repositories the agent should watch.',
      'The App is private, so it can only be installed on the account that owns it:',
      'pick the organization that owns those repositories, or your personal account.',
    ].join('\n'),
    'Create a GitHub App',
  )
  const owner = await text({
    message: 'Organization that will own the App (leave blank for your personal account)',
    validate: (value) => validateGithubAppOwner(value ?? ''),
  })
  if (isCancel(owner)) return null

  const name = await promptAvailableAppName(agentDir)
  if (name === null) return null

  const session = startGithubAppManifestSession({ name, ...(owner ? { owner } : {}) })
  let code: string | null
  try {
    const port = new URL(session.url).port
    note(
      [
        'Opening your browser to create the App. If it does not open, visit:',
        session.url,
        '',
        'Review the permissions and click "Create GitHub App".',
        '',
        'This page is served only on this machine. If you are connected over SSH and your',
        'browser runs elsewhere, forward the port first, then open the URL locally:',
        `  ssh -L ${port}:127.0.0.1:${port} <this-host>`,
        'Without port forwarding, cancel and register the App by hand instead:',
        'https://typeclaw.dev/docs/reference/github#create-the-app-from-a-manifest',
      ].join('\n'),
      'Confirm on GitHub',
    )
    openBrowserBestEffort(session.url)
    code = await waitForManifestCode(session)
  } finally {
    session.stop()
  }
  if (code === null) return null

  const exchange = spinner()
  exchange.start('Fetching the new App credentials')
  let credentials
  try {
    credentials = await exchangeGithubAppManifestCode(code)
    exchange.stop(`Created GitHub App ${credentials.slug} (ID ${credentials.appId})`)
  } catch (error) {
    exchange.stop('Could not fetch the App credentials')
    log.error(error instanceof Error ? error.message : String(error))
    log.info(
      'The App may exist anyway. Delete it at https://github.com/settings/apps and retry, or choose "Use an existing GitHub App" and generate a private key there.',
    )
    return null
  }

  const auth = { type: 'app' as const, appId: credentials.appId, privateKey: credentials.privateKey }
  const repos = await waitForInstallationRepos(credentials, pickRepos)
  if (repos === undefined || !pickRepos) return { auth }
  const selected = await selectRepos(repos)
  if (selected === null) return null
  return { auth, repos: selected }
}

async function promptAvailableAppName(agentDir: string): Promise<string | null> {
  let initialValue = suggestGithubAppName(agentDir)
  while (true) {
    const name = await text({
      message: 'App name (lowercase letters, digits, and hyphens; must be unique on GitHub)',
      initialValue,
      validate: (value) => validateGithubAppName(value ?? ''),
    })
    if (isCancel(name)) return null
    const status = await checkGithubAppName(name)
    if (status === 'available') return name
    if (status === 'unknown') {
      log.warn('Could not check the name with GitHub; the confirmation page will reject it if it is taken.')
      return name
    }
    log.warn(`A GitHub App named "${name}" already exists. Pick another name.`)
    initialValue = `${name}-typeclaw`
  }
}

// The pasted URL carries a one-time code that anyone can redeem for the App's
// private key, so the prompt is masked and never echoes it.
export async function waitForManifestCode(
  session: Pick<GithubAppManifestSession, 'code' | 'parsePastedInput'>,
  io: { input?: Readable; output?: Writable } = {},
): Promise<string | null> {
  const pasteController = new AbortController()
  const fromCallback = session.code.then((code) => {
    pasteController.abort()
    return code
  })
  const fromPaste = password({
    ...io,
    message: 'Waiting for GitHub. If the redirect did not reach this machine, paste the URL the browser ended on',
    signal: pasteController.signal,
    validate: (value) =>
      session.parsePastedInput(value ?? '') === null ? 'Paste the full URL from the address bar' : undefined,
  }).then((value) => {
    if (!isCancel(value)) return session.parsePastedInput(value)
    return pasteController.signal.aborted ? fromCallback : null
  })
  return await Promise.race([fromCallback, fromPaste])
}

async function waitForInstallationRepos(
  credentials: { appId: number; slug: string; privateKey: string },
  pickRepos: boolean,
): Promise<string[] | undefined> {
  const installUrl = githubAppInstallUrl(credentials.slug)
  note(
    [
      pickRepos
        ? 'Opening the install page. Choose the repositories the agent should watch.'
        : 'Opening the install page. Grant the App the repositories already listed in channels.github.repos; that list is not changed.',
      'If it does not open, visit:',
      installUrl,
    ].join('\n'),
    'Install the App',
  )
  openBrowserBestEffort(installUrl)
  const waiting = spinner()
  waiting.start('Waiting for the App to be installed')
  try {
    const { repos } = await waitForGithubAppInstallation({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      signal: AbortSignal.timeout(INSTALLATION_WAIT_MS),
    })
    waiting.stop(`App installed with access to ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`)
    return repos
  } catch (error) {
    waiting.stop('Did not see the installation')
    log.warn(
      `${error instanceof Error ? error.message : String(error)}. The App is created; install it later at ${installUrl}.`,
    )
    return undefined
  }
}

async function selectRepos(repos: string[]): Promise<string[] | null> {
  if (repos.length === 0) return []
  const selected = await multiselect({
    message: 'Repositories to allow',
    options: repos.map((repo) => ({ value: repo, label: repo })),
    initialValues: repos,
    required: false,
  })
  if (isCancel(selected)) return null
  return selected
}
