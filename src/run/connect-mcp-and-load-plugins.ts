import type { McpConnectResult, McpManager } from '@/mcp'

// Connects MCP servers and loads plugins concurrently — neither consumes the
// other's result — but joins with allSettled rather than Promise.all so a fatal
// plugin-load rejection can't leak the MCP side. allSettled waits for connectAll
// to fully settle, so on a plugin failure every MCP connection it established is
// closed before the error is rethrown; startAgent returns no stop() handler on
// this path, so this is the only cleanup chance. connectAll() itself never
// rejects (per-server failures are `ok: false` results), but the rejected branch
// is handled defensively.
export async function connectMcpAndLoadPlugins<T>(
  mcpManager: McpManager | null,
  loadPlugins: () => Promise<T>,
): Promise<T> {
  const [mcpSettled, pluginsSettled] = await Promise.allSettled([
    mcpManager !== null ? mcpManager.connectAll() : Promise.resolve<McpConnectResult[]>([]),
    loadPlugins(),
  ])

  if (pluginsSettled.status === 'rejected') {
    if (mcpManager !== null) await mcpManager.closeAll()
    throw pluginsSettled.reason
  }

  if (mcpSettled.status === 'fulfilled') {
    for (const result of mcpSettled.value) {
      if (!result.ok) console.warn(`[mcp] ${result.name} failed to connect: ${result.error.message}`)
    }
  } else {
    const reason = mcpSettled.reason
    console.warn(`[mcp] connect failed: ${reason instanceof Error ? reason.message : String(reason)}`)
  }

  return pluginsSettled.value
}
