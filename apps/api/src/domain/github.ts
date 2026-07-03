export interface GitHubRepositoryInput {
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  description: string | null;
  topics: string[];
  pushedAt: string | null;
}

export function parseGitHubRepositoryLocator(input: string): { owner: string; name: string } {
  const trimmed = input.trim();

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    const [owner, name] = trimmed.split("/");
    return { owner: owner!, name: name!.replace(/\.git$/, "") };
  }

  const url = new URL(trimmed);
  if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
    throw new Error("Only github.com repositories are supported");
  }

  const [owner, repo] = url.pathname.replace(/^\/+/, "").split("/");
  if (!owner || !repo) {
    throw new Error("GitHub repository URL must include owner and repository name");
  }

  return { owner, name: repo.replace(/\.git$/, "") };
}
