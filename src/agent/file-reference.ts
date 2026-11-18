import { fileURLToPath } from 'node:url'

// The file tools accept `file:` URIs and decode them before opening the path,
// so policy that decides on a destination must decode them the same way.
export function normalizeFileReference(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.toLocaleLowerCase().startsWith('file:')) return value
  try {
    return fileURLToPath(trimmed)
  } catch {
    throw new Error(`invalid file URI: ${value}`)
  }
}
