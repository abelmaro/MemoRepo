import { createHash } from "node:crypto";
import type { CbmIndexMode } from "./cbmService.js";

export interface SnapshotRebuildInput {
  spaceId: string;
  mode: CbmIndexMode;
  repositories: Array<{ repositoryId: string; commit: string | null }>;
}

export function createSnapshotRebuildFingerprint(input: SnapshotRebuildInput): string {
  const repositories = input.repositories
    .map((repository) => [repository.repositoryId, repository.commit] as const)
    .sort(([leftId, leftCommit], [rightId, rightCommit]) =>
      leftId.localeCompare(rightId, "en") || (leftCommit ?? "").localeCompare(rightCommit ?? "", "en"));
  return createHash("sha256")
    .update(JSON.stringify([input.spaceId, input.mode, repositories]))
    .digest("hex");
}
