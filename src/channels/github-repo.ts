export function canonicalGithubRepo(repo: string): string {
  return repo
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLocaleLowerCase()
}

export function githubReviewerWorkKey(repo: string, prNumber: number): string {
  return `reviewer:github:${canonicalGithubRepo(repo)}#${prNumber}`
}
