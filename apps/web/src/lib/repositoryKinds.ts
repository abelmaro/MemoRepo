import { booleanValue, type GitHubRepository, type SpaceRepository } from "./api";

export type RepositoryKindFilter = "all" | "forks" | "archived" | "private";

export const REPOSITORY_KIND_FILTERS: Array<{ value: RepositoryKindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "forks", label: "Forks" },
  { value: "archived", label: "Archived" },
  { value: "private", label: "Private" }
];

export function matchesRepositoryKind(repository: SpaceRepository | GitHubRepository, kind: RepositoryKindFilter): boolean {
  if (kind === "forks") {
    return booleanValue(repository.fork);
  }
  if (kind === "archived") {
    return booleanValue(repository.archived);
  }
  if (kind === "private") {
    return booleanValue(repository.private);
  }
  return true;
}
