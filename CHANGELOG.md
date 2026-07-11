# Changelog

All notable changes to MemoRepo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add transactional, versioned SQLite migrations with upgrade coverage for every previously released schema.

### Changed

- Build the API container in isolated stages, ship production-only dependencies, pin its base image, and restrict Git trust to managed repository paths.
- Surface unavailable API and panel query states with retry actions, disable conflicting Space operations, and add automated accessibility coverage for shared dialogs and errors.
- Add defensive no-store browser response headers and restrict application-owned directories and database files to the service account on POSIX-capable storage.

### Fixed

- Keep the Data lifecycle panels in stable columns when prune or garbage-collection feedback appears.

## [0.1.6] - 2026-07-10

### Changed

- Replace native browser alerts, confirmations, and prompts with accessible application modals or inline operation feedback.
- Enforce the `query_graph` row limit through `max_rows`, reject caller-supplied limits, multiple statements, mutating clauses, and procedure calls, and mask literals and comments before validation.
- Remove managed filesystem locations from system diagnostics and sanitize public HTTP and MCP error messages centrally.
- Use consistent “Delete space” language throughout the Space lifecycle confirmation flow.

### Fixed

- Distinguish snapshot updates, failed builds, and required rebuilds so completed failures no longer appear as indefinitely pending.
- Remove cleaned repository clones from the pending-cleanup list while retaining their internal history for job and index references.
- Revoke an active snapshot atomically when a repository it contains is removed, then rebuild from the remaining repositories without exposing the stale snapshot to MCP clients.
- Bound subprocess stream capture, unterminated output lines, job-event messages, retained log-event counts, and persisted job errors, with explicit truncation markers for noisy processes.

## [0.1.5] - 2026-07-10

### Added

- Add MemoRepo favicon, Apple touch icon, Android app icons, and a dark-theme web app manifest, and reuse the product mark in the main navigation.

### Changed

- Add a scalable dark brand theme with centralized foundations for color, typography, spacing, shape, effects, motion, and layers, plus accessible interaction states and build-time enforcement against component-level design literals.

### Fixed

- Keep repository branch hover and focus surfaces fitted to their content across desktop and responsive layouts.
- Respect reduced-motion preferences for loading indicators and keep the design-token API free of unused aliases.
- Increase favicon artwork coverage and regenerate every icon size from one tightly cropped master.

## [0.1.4] - 2026-07-10

### Changed

- Make the space-level check and update workflow fetch selected remote branches, reindex only repositories whose commit or index state changed, and rebuild the snapshot only when needed.
- Redesign the space dashboard around contextual agent readiness, consolidated repository actions, searchable branch selection, and clearer empty states.
- Reorganize activity, system health, and lifecycle settings into one contained management surface with responsive layouts and accessible dialogs.

### Fixed

- Keep exactly one snapshot active per space and avoid rendering duplicate active status badges.

## [0.1.3] - 2026-07-09

### Added

- Deduplicate pending and running jobs only when their job type, scope, dependency, and canonical payload match exactly, using an atomic SQLite queue key.

### Security

- Require a strong local bearer token for the control API while keeping MCP connection credentials separate.
- Require an explicit CSRF header for state-changing control requests, including deletes.
- Add separate per-IP rate limits for authentication checks, control reads, mutations, SSE handshakes, and MCP calls.
- Keep the dashboard control token in tab-scoped session storage and stream job events without putting credentials in URLs.
- Restrict Git child processes to an allowlisted environment plus the credentials required for the current Git operation.

### Fixed

- Allow a valid control token to unlock the dashboard immediately after failed authentication attempts have exhausted the invalid-token rate-limit bucket.

## [0.1.2] - 2026-07-09

### Security

- Verify the SHA-256 digest of downloaded `codebase-memory-mcp` archives before extraction.
- Prevent CBM child processes from inheriting `GH_TOKEN` and unrelated environment secrets.

## [0.1.1] - 2026-07-09

### Changed

- Require JSON content types for state-changing HTTP API and MCP requests.

### Fixed

- Remove MCP tool usage statistics when deleting a space.
- Preserve managed files when a space deletion fails before its database transaction commits.

### Security

- Restrict HTTP requests to trusted API hostnames and dashboard origins.
- Reject cross-site browser requests before they can reach state-changing handlers.

## [0.1.0] - 2026-07-03

### Added

- Add a local-first dashboard for organizing repositories into isolated spaces.
- Add GitHub repository discovery, managed clones, branch selection, and commit tracking.
- Add `codebase-memory-mcp` indexing and immutable per-space snapshots.
- Add a read-only, space-scoped MCP gateway with generated local client configurations.
- Add persistent background jobs with retries, pending cancellation, dependency tracking, and startup recovery.
- Add snapshot retention and local maintenance workflows.
- Add Docker Compose support for productive local use on Windows, macOS, and Linux.

[Unreleased]: https://github.com/abelmaro/MemoRepo/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/abelmaro/MemoRepo/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/abelmaro/MemoRepo/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/abelmaro/MemoRepo/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/abelmaro/MemoRepo/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/abelmaro/MemoRepo/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/abelmaro/MemoRepo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/abelmaro/MemoRepo/tree/v0.1.0
