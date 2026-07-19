import path from "node:path";
import type {
  SnapshotManifest,
  SnapshotManifestRepository,
  SnapshotManifestRepositoryCbmIndex,
  SnapshotQuality
} from "./snapshotService.js";
import {
  snapshotSourceIntegrityManifestPath,
  verifySnapshotSourceIntegrity,
  type SnapshotSourceIntegrityFile,
  type SnapshotSourceIntegrityManifest,
  type SnapshotSourceIntegritySummary
} from "./snapshotSourceIntegrity.js";

const SKIP_PATH_SAMPLE_LIMIT = 20;

export interface SnapshotIndexCoverageOptions {
  project?: string;
  signal?: AbortSignal;
}

export interface SnapshotIndexCoverageExtension {
  extension: string;
  sourceFiles: number;
  sourceBytes: number;
  excludedFiles: number;
  skippedFiles: number;
  candidateFiles: number;
  candidateBytes: number;
  coverageRatio: number | null;
}

export interface SnapshotIndexProjectCoverage {
  project: string;
  repository: string;
  quality: SnapshotQuality;
  integrity: {
    verified: boolean;
    treeSha?: string;
    rootDigest?: string;
    reason?: string;
  };
  totals: Omit<SnapshotIndexCoverageExtension, "extension" | "coverageRatio"> & { coverageRatio: number | null };
  extensions: SnapshotIndexCoverageExtension[];
  skips: {
    reportedCount: number;
    detailedCount: number;
    truncated: boolean;
    unmappedCount: number;
    byExtension: Array<{ extension: string; count: number }>;
    byPhase: Array<{ phase: string; count: number }>;
    samplePaths: string[];
  };
  exclusions: {
    reportedCount: number;
    detailedCount: number;
    truncated: boolean;
    unmappedDirectories: number;
  };
  exhaustive: boolean;
  exhaustivenessReasons: string[];
}

export interface SnapshotIndexCoverageResult {
  quality: SnapshotQuality;
  coverageBasis: "source_inventory_minus_reported_exclusions_and_skips";
  indexedFileMembershipProven: false;
  exhaustive: boolean;
  exhaustivenessReasons: string[];
  totals: Omit<SnapshotIndexCoverageExtension, "extension" | "coverageRatio"> & { coverageRatio: number | null };
  extensions: SnapshotIndexCoverageExtension[];
  projects: SnapshotIndexProjectCoverage[];
}

export async function snapshotIndexCoverage(
  manifest: SnapshotManifest,
  options: SnapshotIndexCoverageOptions = {}
): Promise<SnapshotIndexCoverageResult> {
  const repositories = options.project
    ? [requiredCoverageRepository(manifest, options.project)]
    : manifest.repositories;
  const projects: SnapshotIndexProjectCoverage[] = [];
  for (const repository of repositories) {
    projects.push(await projectCoverage(repository, normalizeQuality(manifest.quality), options.signal));
  }
  const extensions = aggregateExtensions(projects.flatMap((project) => project.extensions));
  const totals = sumCoverage(extensions);
  const reasons = uniqueSorted(projects.flatMap((project) => project.exhaustivenessReasons));
  return {
    quality: normalizeQuality(manifest.quality),
    coverageBasis: "source_inventory_minus_reported_exclusions_and_skips",
    indexedFileMembershipProven: false,
    exhaustive: projects.length > 0 && projects.every((project) => project.exhaustive),
    exhaustivenessReasons: reasons,
    totals,
    extensions,
    projects
  };
}

export function snapshotIndexCoverageMcpView(result: SnapshotIndexCoverageResult): Record<string, unknown> {
  return snakeCaseKeys(result) as Record<string, unknown>;
}

async function projectCoverage(
  repository: SnapshotManifestRepository,
  snapshotQuality: SnapshotQuality,
  signal?: AbortSignal
): Promise<SnapshotIndexProjectCoverage> {
  const integrity = await verifiedIntegrity(repository, signal);
  const files = integrity.manifest?.files ?? [];
  const sourcePaths = new Set(files.map((file) => file.path));
  const excluded = exclusionInventory(repository.cbmIndex, files);
  const skips = skipInventory(repository.cbmIndex, sourcePaths);
  const extensionRows = extensionCoverage(files, excluded.paths, skips.paths);
  const totals = sumCoverage(extensionRows);
  const quality = normalizeQuality(repository.cbmIndex?.snapshotQuality);
  const reasons: string[] = [];
  if (!integrity.verified) reasons.push(integrity.reason ?? "source_integrity_unverified");
  if (snapshotQuality !== "complete") reasons.push(`snapshot_quality_${snapshotQuality}`);
  if (quality !== "complete") reasons.push(`project_quality_${quality}`);
  if (!skips.complete) reasons.push("skip_inventory_incomplete");
  if (!excluded.complete) reasons.push("exclusion_inventory_incomplete");

  return {
    project: repository.projectName,
    repository: repository.fullName,
    quality,
    integrity: {
      verified: integrity.verified,
      ...(integrity.manifest ? {
        treeSha: integrity.manifest.treeSha,
        rootDigest: integrity.manifest.rootDigest
      } : {}),
      ...(!integrity.verified && integrity.reason ? { reason: integrity.reason } : {})
    },
    totals,
    extensions: extensionRows,
    skips: {
      reportedCount: repository.cbmIndex?.skippedCount ?? 0,
      detailedCount: repository.cbmIndex?.skipped?.files.length ?? 0,
      truncated: repository.cbmIndex?.skipped?.truncated ?? false,
      unmappedCount: skips.unmappedCount,
      byExtension: countValues(skips.safePaths.map(fileExtension), "extension"),
      byPhase: countValues(
        repository.cbmIndex?.skipped?.files.map((file) => file.phase || "unknown") ?? [],
        "phase"
      ),
      samplePaths: skips.safePaths.slice(0, SKIP_PATH_SAMPLE_LIMIT)
    },
    exclusions: {
      reportedCount: repository.cbmIndex?.excluded?.count ?? 0,
      detailedCount: repository.cbmIndex?.excluded?.dirs.length ?? 0,
      truncated: repository.cbmIndex?.excluded?.truncated ?? false,
      unmappedDirectories: excluded.unmappedDirectories
    },
    exhaustive: reasons.length === 0,
    exhaustivenessReasons: uniqueSorted(reasons)
  };
}

async function verifiedIntegrity(
  repository: SnapshotManifestRepository,
  signal?: AbortSignal
): Promise<{ verified: boolean; reason?: string; manifest?: SnapshotSourceIntegrityManifest }> {
  const expected = repository.sourceIntegrity;
  if (!expected) return { verified: false, reason: "source_integrity_manifest_unavailable" };
  const verification = await verifySnapshotSourceIntegrity(
    repository.localPath,
    snapshotSourceIntegrityManifestPath(repository.localPath),
    expected.treeSha,
    signal
  );
  if (!verification.valid || !verification.manifest) {
    return { verified: false, reason: verification.reason ?? "source_integrity_unverified" };
  }
  if (!sameIntegritySummary(expected, verification.manifest)) {
    return { verified: false, reason: "snapshot_integrity_summary_mismatch" };
  }
  return { verified: true, manifest: verification.manifest };
}

function exclusionInventory(
  index: SnapshotManifestRepositoryCbmIndex | undefined,
  files: SnapshotSourceIntegrityFile[]
): { paths: Set<string>; complete: boolean; unmappedDirectories: number } {
  const summary = index?.excluded;
  if (!summary) return { paths: new Set(), complete: true, unmappedDirectories: 0 };
  const directories = summary.dirs.map(normalizeCoveragePath);
  const safeDirectories = directories.filter((directory): directory is string => directory !== undefined);
  const paths = new Set(files
    .filter((file) => safeDirectories.some((directory) => file.path === directory || file.path.startsWith(`${directory}/`)))
    .map((file) => file.path));
  const unmappedDirectories = directories.length - safeDirectories.length;
  return {
    paths,
    complete: !summary.truncated && summary.count === summary.dirs.length && unmappedDirectories === 0,
    unmappedDirectories
  };
}

function skipInventory(
  index: SnapshotManifestRepositoryCbmIndex | undefined,
  sourcePaths: Set<string>
): { paths: Set<string>; safePaths: string[]; complete: boolean; unmappedCount: number } {
  const details = index?.skipped?.files ?? [];
  const normalized = details.map((file) => normalizeCoveragePath(file.path));
  const safePaths = normalized.filter((candidate): candidate is string => candidate !== undefined);
  const mappedPaths = safePaths.filter((candidate) => sourcePaths.has(candidate));
  const paths = new Set(mappedPaths);
  const reportedCount = index?.skippedCount ?? 0;
  const truncated = index?.skipped?.truncated ?? false;
  const unmappedCount = normalized.length - mappedPaths.length;
  return {
    paths,
    safePaths,
    complete: !truncated && reportedCount === details.length && unmappedCount === 0,
    unmappedCount
  };
}

function extensionCoverage(
  files: SnapshotSourceIntegrityFile[],
  excludedPaths: Set<string>,
  skippedPaths: Set<string>
): SnapshotIndexCoverageExtension[] {
  const rows = new Map<string, SnapshotIndexCoverageExtension>();
  for (const file of files) {
    const extension = fileExtension(file.path);
    const row = rows.get(extension) ?? emptyExtension(extension);
    row.sourceFiles += 1;
    row.sourceBytes += file.sizeBytes;
    if (excludedPaths.has(file.path)) {
      row.excludedFiles += 1;
    } else if (skippedPaths.has(file.path)) {
      row.skippedFiles += 1;
    } else {
      row.candidateFiles += 1;
      row.candidateBytes += file.sizeBytes;
    }
    rows.set(extension, row);
  }
  return [...rows.values()]
    .map(withCoverageRatio)
    .sort((left, right) => left.extension.localeCompare(right.extension, "en"));
}

function aggregateExtensions(rows: SnapshotIndexCoverageExtension[]): SnapshotIndexCoverageExtension[] {
  const totals = new Map<string, SnapshotIndexCoverageExtension>();
  for (const row of rows) {
    const aggregate = totals.get(row.extension) ?? emptyExtension(row.extension);
    aggregate.sourceFiles += row.sourceFiles;
    aggregate.sourceBytes += row.sourceBytes;
    aggregate.excludedFiles += row.excludedFiles;
    aggregate.skippedFiles += row.skippedFiles;
    aggregate.candidateFiles += row.candidateFiles;
    aggregate.candidateBytes += row.candidateBytes;
    totals.set(row.extension, aggregate);
  }
  return [...totals.values()]
    .map(withCoverageRatio)
    .sort((left, right) => left.extension.localeCompare(right.extension, "en"));
}

function sumCoverage(rows: SnapshotIndexCoverageExtension[]) {
  return withCoverageRatio(rows.reduce((total, row) => ({
    ...total,
    sourceFiles: total.sourceFiles + row.sourceFiles,
    sourceBytes: total.sourceBytes + row.sourceBytes,
    excludedFiles: total.excludedFiles + row.excludedFiles,
    skippedFiles: total.skippedFiles + row.skippedFiles,
    candidateFiles: total.candidateFiles + row.candidateFiles,
    candidateBytes: total.candidateBytes + row.candidateBytes
  }), emptyExtension("all")));
}

function emptyExtension(extension: string): SnapshotIndexCoverageExtension {
  return {
    extension,
    sourceFiles: 0,
    sourceBytes: 0,
    excludedFiles: 0,
    skippedFiles: 0,
    candidateFiles: 0,
    candidateBytes: 0,
    coverageRatio: null
  };
}

function withCoverageRatio<T extends SnapshotIndexCoverageExtension>(row: T): T {
  row.coverageRatio = row.sourceFiles === 0 ? null : Number((row.candidateFiles / row.sourceFiles).toFixed(6));
  return row;
}

function countValues<T extends string>(
  values: string[],
  key: T
): Array<Record<T, string> & { count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([value, count]) => ({ [key]: value, count }) as Record<T, string> & { count: number });
}

function fileExtension(relativePath: string): string {
  return path.posix.extname(relativePath).toLocaleLowerCase("en-US") || "[none]";
}

function normalizeCoveragePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || path.posix.isAbsolute(normalized)) return undefined;
  const segments = normalized.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..") ? normalized : undefined;
}

function requiredCoverageRepository(manifest: SnapshotManifest, project: string): SnapshotManifestRepository {
  const repository = manifest.repositories.find((candidate) =>
    candidate.projectName === project || candidate.fullName === project);
  if (!repository) throw new Error("snapshot_index_coverage project is outside this space snapshot");
  return repository;
}

function sameIntegritySummary(
  expected: SnapshotSourceIntegritySummary,
  actual: SnapshotSourceIntegritySummary
): boolean {
  return expected.schemaVersion === actual.schemaVersion
    && expected.algorithm === actual.algorithm
    && expected.sourceDirectory === actual.sourceDirectory
    && expected.treeSha === actual.treeSha
    && expected.rootDigest === actual.rootDigest
    && expected.fileCount === actual.fileCount
    && expected.totalBytes === actual.totalBytes;
}

function normalizeQuality(value: unknown): SnapshotQuality {
  return value === "complete" || value === "partial" || value === "degraded" ? value : "unknown";
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function snakeCaseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeCaseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, candidate]) => [
    key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLocaleLowerCase("en-US"),
    snakeCaseKeys(candidate)
  ]));
}
