export type CreateIdleDetectorOptions = {
  idleMs: number
  onIdle: () => void
}

export type IdleDetector = {
  arm: () => void
  cancel: () => void
  dispose: () => void
}

export function createIdleDetector({ idleMs, onIdle }: CreateIdleDetectorOptions): IdleDetector {
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  function clear(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    arm() {
      if (disposed) return
      clear()
      timer = setTimeout(() => {
        timer = null
        if (disposed) return
        onIdle()
      }, idleMs)
    },
    cancel() {
      clear()
    },
    dispose() {
      disposed = true
      clear()
    },
  }
}
