export type McpCatalogServer = {
  name: string
  description?: string
  connected: boolean
  toolCount?: number
}

export function renderMcpCatalog(servers: McpCatalogServer[]): string {
  const connected = servers.filter((server) => server.connected)
  if (connected.length === 0) return ''

  const lines = connected.map((server) => {
    const toolCount = server.toolCount ?? 0
    const description = server.description?.trim() ? server.description.trim() : 'no description'
    return `- ${server.name} (${toolCount} tools): ${description}`
  })

  // WHY: this catalog is inserted in the cacheable stable prompt region and is
  // omitted when empty so agents without MCP keep byte-identical prompts.
  return [
    '## MCP servers',
    '',
    'The following MCP servers are connected. Each exposes tools you can discover and call:',
    ...lines,
    '',
    "Use `mcp_list_tools(server)` to see a server's tools, `mcp_describe(server, tool)` for a tool's input schema, and `mcp_call(server, tool, args)` to invoke it.",
  ].join('\n')
}
