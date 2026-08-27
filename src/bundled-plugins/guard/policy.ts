export { ACKNOWLEDGE_GUARDS } from './keys'

export type GuardBlock = { block: true; reason: string }

export { GUARD_MANAGED_CONFIG, checkManagedConfigGuard } from './policies/managed-config'
export { GUARD_NON_WORKSPACE_WRITE, checkNonWorkspaceWriteGuard } from './policies/non-workspace-write'
export {
  GUARD_SKILL_AUTHORING,
  checkSkillAuthoringDecision,
  checkSkillAuthoringGuard,
  isSkillAuthoringAllowed,
} from './policies/skill-authoring'
export { GUARD_MEMORY_TOPICS_DELETE, checkMemoryTopicsDeleteGuard } from './policies/memory-topics-delete'
export { isMemoryTopicsWriteAllowed } from './policies/memory-topics-write'
export { GUARD_UNCOMMITTED_CHANGES, checkUncommittedChangesAdvice } from './policies/uncommitted-changes'
