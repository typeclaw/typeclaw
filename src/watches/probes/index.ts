import { githubIssueProbe } from './github-issue'
import { githubPrProbe } from './github-pr'

export { githubIssueProbe, githubPrProbe }

export const bundledProbes = [githubPrProbe, githubIssueProbe] as const
