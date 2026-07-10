# Changelog

All notable changes to MemoRepo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Make the space-level check and update workflow fetch selected remote branches, reindex only repositories whose commit or index state changed, and rebuild the snapshot only when needed.

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

[Unreleased]: https://github.com/abelmaro/MemoRepo/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/abelmaro/MemoRepo/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/abelmaro/MemoRepo/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/abelmaro/MemoRepo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/abelmaro/MemoRepo/tree/v0.1.0
