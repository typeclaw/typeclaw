export type PiBuiltinToolName = 'read' | 'bash' | 'edit' | 'write' | 'grep' | 'find' | 'ls'

export const PI_BUILTIN_TOOL_NAMES: readonly PiBuiltinToolName[] = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
]

export const CORE_SYSTEM_TOOL_NAMES = ['web_search', 'web_fetch', 'look_at'] as const

export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([...PI_BUILTIN_TOOL_NAMES, ...CORE_SYSTEM_TOOL_NAMES])
