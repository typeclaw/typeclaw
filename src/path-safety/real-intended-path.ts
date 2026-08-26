import path from 'node:path'

// Canonicalizes the longest RESOLVABLE prefix of an absolute path, then re-appends
// the remainder lexically. A bare realpath throws on a path that does not exist yet
// (a write target, or a read of a not-yet-created file), so we walk up to the nearest
// resolvable ancestor, realpath THAT — collapsing every symlinked component, including
// a planted one — and rejoin the tail. This is what catches `public/leak/x` where
// `public/leak` is a symlink into a hidden dir even though `public/leak/x` itself does
// not exist.
//
// Which errnos may be walked past is the security-sensitive part, so it is the
// CALLER's decision, not a default. See the three exported sets below.

// The historical, strictest set: only a missing component is walked past.
// Correct for allowlist/authorization policies, where an unresolvable component must
// never widen what is permitted.
export const RECOVER_MISSING: ReadonlySet<string> = new Set(['ENOENT'])

// Adds EACCES for denylist matching. A realpath of a path under a directory the
// runtime cannot search fails with EACCES, not ENOENT — e.g. resolving
// `/root/.config/...` while running as a non-root uid when `/root` is mode 700.
// Treating that as fatal blocks reads of paths that are neither secret nor denied.
// Walking past it is sound for a DENYLIST because the tail is still matched against
// the denied surface after rejoining: a masked directory still matches lexically and
// still blocks. It is NOT sound for an allowlist — see RECOVER_MISSING.
export const RECOVER_MISSING_OR_UNSEARCHABLE: ReadonlySet<string> = new Set(['ENOENT', 'EACCES'])

// Adds ENAMETOOLONG for denylist matching of values that may be prose rather
// than filesystem paths. Walking past an oversized component is sound for a
// DENYLIST because lexical matching has already caught direct and
// traversal-normalized denied paths, while the ancestor walk still resolves a
// symlinked prefix before rejoining and matching the oversized tail. The
// oversized component cannot itself name a real file on the affected
// filesystem. It is NOT sound for an allowlist — see RECOVER_MISSING.
export const RECOVER_MISSING_OR_UNSEARCHABLE_OR_NAME_TOO_LONG: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'ENAMETOOLONG',
])

export type RealIntendedPathOptions = {
  // Defaults to RECOVER_MISSING: callers must opt in to the broader set.
  readonly recoverable?: ReadonlySet<string>
  // What to do when even the filesystem root is unresolvable. Callers that treat an
  // unresolvable path as a hard failure use 'throw'; callers that fall back to the
  // lexical input use 'return-input'.
  readonly onExhausted?: 'throw' | 'return-input'
}

export function realIntendedPathSync(
  absolutePath: string,
  realpath: (candidate: string) => string,
  options: RealIntendedPathOptions = {},
): string {
  const walk = createAncestorWalk(absolutePath, options)
  while (true) {
    let resolved: string
    try {
      resolved = realpath(walk.target())
    } catch (error) {
      const exhausted = walk.retreat(error)
      if (exhausted !== undefined) return exhausted
      continue
    }
    return walk.rejoin(resolved)
  }
}

export async function realIntendedPath(
  absolutePath: string,
  realpath: (candidate: string) => Promise<string>,
  options: RealIntendedPathOptions = {},
): Promise<string> {
  const walk = createAncestorWalk(absolutePath, options)
  while (true) {
    let resolved: string
    try {
      resolved = await realpath(walk.target())
    } catch (error) {
      const exhausted = walk.retreat(error)
      if (exhausted !== undefined) return exhausted
      continue
    }
    return walk.rejoin(resolved)
  }
}

type AncestorWalk = {
  target(): string
  rejoin(resolvedTarget: string): string
  // Returns the final result when the walk cannot retreat further, or undefined to
  // keep walking. Rethrows anything the caller did not declare recoverable.
  retreat(error: unknown): string | undefined
}

function createAncestorWalk(absolutePath: string, options: RealIntendedPathOptions): AncestorWalk {
  const recoverable = options.recoverable ?? RECOVER_MISSING
  const onExhausted = options.onExhausted ?? 'return-input'
  const pending: string[] = []
  let current = absolutePath

  return {
    target: () => current,
    // Copy before reversing: the caller may hold this array across iterations.
    rejoin: (resolvedTarget) => path.join(resolvedTarget, ...[...pending].reverse()),
    retreat(error) {
      if (!isRecoverableErrno(error, recoverable)) throw error
      const parent = path.dirname(current)
      if (parent === current) {
        if (onExhausted === 'throw') throw new Error(`could not resolve existing parent for ${absolutePath}`)
        return absolutePath
      }
      pending.push(path.basename(current))
      current = parent
      return undefined
    },
  }
}

function isRecoverableErrno(error: unknown, recoverable: ReadonlySet<string>): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  const code = (error as { code: unknown }).code
  return typeof code === 'string' && recoverable.has(code)
}
