import { spawn } from 'node:child_process'

export function openBrowserBestEffort(url: URL | string): void {
  const target = url.toString()
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', () => undefined)
  child.unref()
}
