// An adapter throws this from start(), or reports it through haltReason(),
// when retrying with the same credentials cannot succeed and every retry is
// another login against the platform. Personal-account platforms (KakaoTalk)
// treat repeated rejected logins as abuse and escalate restrictions, so the
// manager must stop retrying instead of backing off forever. A halted adapter
// restarts only when its inputs change (credential rotation, config edit) or
// an operator restarts it explicitly.
export class ChannelAdapterHaltedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelAdapterHaltedError'
  }
}

export function isChannelAdapterHaltedError(err: unknown): err is ChannelAdapterHaltedError {
  return err instanceof ChannelAdapterHaltedError
}
