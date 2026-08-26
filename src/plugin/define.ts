import type { z } from 'zod'

import type {
  BuiltinToolRef,
  ContainerCommand,
  DefinedPlugin,
  EitherCommand,
  HostCommand,
  PluginCommand,
  PluginContext,
  PluginExports,
  Subagent,
  Tool,
} from './types'

type DefinePluginSpec<S extends z.ZodType<unknown> | undefined> =
  S extends z.ZodType<infer T>
    ? {
        configSchema: S
        permissions?: readonly string[]
        ownerWildcardExclusions?: readonly string[]
        commands?: Record<string, PluginCommand>
        plugin: (ctx: PluginContext<T>) => Promise<PluginExports>
      }
    : {
        permissions?: readonly string[]
        ownerWildcardExclusions?: readonly string[]
        commands?: Record<string, PluginCommand>
        plugin: (ctx: PluginContext<unknown>) => Promise<PluginExports>
      }

export function definePlugin<S extends z.ZodType<unknown> | undefined = undefined>(
  spec: DefinePluginSpec<S>,
): DefinedPlugin<S extends z.ZodType<infer T> ? T : unknown> {
  return spec as DefinedPlugin<S extends z.ZodType<infer T> ? T : unknown>
}

export function defineTool<P>(tool: Tool<P>): Tool<P> {
  return tool
}

export function defineSubagent<P>(subagent: Subagent<P>): Subagent<P> {
  return subagent
}

type ContainerCommandSpec<S extends z.ZodObject<z.ZodRawShape> | undefined> =
  S extends z.ZodObject<z.ZodRawShape>
    ? Omit<ContainerCommand<z.infer<S>>, 'args'> & { args: S }
    : Omit<ContainerCommand<unknown>, 'args'> & { args?: undefined }

type HostCommandSpec<S extends z.ZodObject<z.ZodRawShape> | undefined> =
  S extends z.ZodObject<z.ZodRawShape>
    ? Omit<HostCommand<z.infer<S>>, 'args'> & { args: S }
    : Omit<HostCommand<unknown>, 'args'> & { args?: undefined }

type EitherCommandSpec<S extends z.ZodObject<z.ZodRawShape> | undefined> =
  S extends z.ZodObject<z.ZodRawShape>
    ? Omit<EitherCommand<z.infer<S>>, 'args'> & { args: S }
    : Omit<EitherCommand<unknown>, 'args'> & { args?: undefined }

export function defineCommand<S extends z.ZodObject<z.ZodRawShape> | undefined = undefined>(
  cmd: ContainerCommandSpec<S>,
): ContainerCommand<S extends z.ZodObject<z.ZodRawShape> ? z.infer<S> : unknown>
export function defineCommand<S extends z.ZodObject<z.ZodRawShape> | undefined = undefined>(
  cmd: HostCommandSpec<S>,
): HostCommand<S extends z.ZodObject<z.ZodRawShape> ? z.infer<S> : unknown>
export function defineCommand<S extends z.ZodObject<z.ZodRawShape> | undefined = undefined>(
  cmd: EitherCommandSpec<S>,
): EitherCommand<S extends z.ZodObject<z.ZodRawShape> ? z.infer<S> : unknown>
export function defineCommand(cmd: PluginCommand): PluginCommand {
  return cmd
}

export const readTool: BuiltinToolRef = { __builtinTool: 'read' }
export const bashTool: BuiltinToolRef = { __builtinTool: 'bash' }
export const editTool: BuiltinToolRef = { __builtinTool: 'edit' }
export const writeTool: BuiltinToolRef = { __builtinTool: 'write' }
export const grepTool: BuiltinToolRef = { __builtinTool: 'grep' }
export const findTool: BuiltinToolRef = { __builtinTool: 'find' }
export const lsTool: BuiltinToolRef = { __builtinTool: 'ls' }
export const webSearchTool: BuiltinToolRef = { __builtinTool: 'web_search' }
export const webFetchTool: BuiltinToolRef = { __builtinTool: 'web_fetch' }
