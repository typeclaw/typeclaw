import { spawn } from 'node:child_process'

export const CONTAINER_PORT = 8973
export const TUI_TOKEN_LABEL = 'dev.typeclaw.tui-token'

export type DockerExec = (args: string[]) => Promise<{ stdout: string; exitCode: number }>

export async function resolveHostPort(containerName: string, exec: DockerExec = defaultDockerExec): Promise<number> {
  const result = await exec(['port', containerName, `${CONTAINER_PORT}/tcp`])
  if (result.exitCode !== 0) {
    throw new Error(`container '${containerName}' not running or port ${CONTAINER_PORT} not published`)
  }
  const port = parseDockerPortOutput(result.stdout)
  if (port === null) throw new Error(`could not parse host port from: ${result.stdout.trim()}`)
  return port
}

export async function resolveTuiToken(containerName: string, exec: DockerExec = defaultDockerExec): Promise<string> {
  const result = await exec(['inspect', '--format', `{{ index .Config.Labels "${TUI_TOKEN_LABEL}" }}`, containerName])
  if (result.exitCode !== 0) throw new Error(`could not inspect container '${containerName}'`)
  const token = result.stdout.trim()
  if (token.length === 0 || token === '<no value>')
    throw new Error(`no TUI token label on container '${containerName}'`)
  return token
}

// Prefer an IPv4 mapping: `docker port` prints one line per bound address
// (0.0.0.0:PORT, :::PORT, [::]:PORT) and localhost resolves to IPv4 first on
// macOS/Linux. Mirrors src/container/port.ts#parseDockerPortOutput.
export function parseDockerPortOutput(stdout: string): number | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return null

  const ipv4 = lines.find((line) => /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(line))
  const candidate = ipv4 ?? lines[0]
  if (candidate === undefined) return null

  const lastColon = candidate.lastIndexOf(':')
  if (lastColon < 0) return null
  const port = Number(candidate.slice(lastColon + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return port
}

const defaultDockerExec: DockerExec = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, exitCode: code ?? 1 }))
  })
