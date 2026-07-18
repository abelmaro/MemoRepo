# Changelog

All notable changes to MemoRepo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-07-18

### Added

- Add capability-aware advanced Ask this Space controls for model verbosity and reasoning effort.
- Persist per-turn provider stop reasons, token usage, provider round counts, and tool-call counts for answer diagnostics.
- Add an authenticated dashboard event stream for reactive state invalidation and automatic reconciliation after reconnecting.
- Add durable per-attempt recovery and a size-bounded, snapshot-scoped cache for successful read-only tool results.

### Changed

- Strengthen Ask this Space investigations with the snapshot gateway workflow, evidence verification, pagination, and truncation guidance.
- Materialize exact Git commits directly into reusable immutable revision trees instead of creating and copying temporary worktrees for every snapshot.
- Use a Docker-managed data volume for new installations while preserving existing bind-mount configurations.
- Separate heavyweight indexing capacity from interactive snapshot queries and reuse one CBM session across each agent turn.
- Batch job-log and streamed assistant-content persistence to reduce SQLite contention without delaying live events.
- Replace idle dashboard polling with selective event-driven refetches while retaining polling for active external authorization flows.
- Measure the real dashboard event stream separately from normal HTTP latency in performance baseline reports.
- Replace Quick, Standard, and Deep answer modes with one adaptive investigation policy that chooses depth from the question and evidence.
- Raise the default internal safety ceilings to 1,800 seconds, 200 tool calls, and 50 provider rounds while reserving capacity for final synthesis.

### Fixed

- Avoid synchronous recursive size scans on repeated snapshot-list requests by persisting snapshot artifact sizes and backfilling legacy rows asynchronously.
- Skip redundant clean Git checkouts and repairs when a managed clone already matches its selected remote commit.
- Reclaim content-addressed revision trees after their last retained snapshot reference is removed and garbage collection runs.
- Preserve collected evidence across provider failures and API restarts, automatically retry transient failures, and resume exhausted or interrupted answers on the same logical turn.
- Finalize with the best supported answer when research reaches a soft budget or stops making progress instead of exposing a terminal limit error.

## [0.3.0] - 2026-07-16

### Added

- Add snapshot-pinned Ask this Space agent chats powered by the Pi SDK, with persistent conversations, streamed answers, interrupt support, and read-only snapshot tools.
- Add runtime provider/model discovery and selection for OAuth-capable Pi integrations, with environment-defined initial values and configurable 600-second/96-tool answer budgets.
- Add stable `MR-*` codes and request IDs to handled API failures, plus coded job failures and clone/index/snapshot phase timings for easier diagnosis.

### Changed

- Make Ask this Space draggable and resizable on desktop, keep it within the viewport, and give the conversation composer a stable bottom position.
- Keep modal content and job logs within their own scroll regions, compact connection and operation notices, and improve diagnostics spacing.
- Keep the repository picker open while a GitHub catalog refresh runs and report refresh progress in place.
- Allow active background jobs to cancel their Git, indexing, and snapshot subprocesses cooperatively.
- Avoid redundant remote fetches after a fresh clone and before branch checkout.

### Fixed

- Render Ask this Space assistant answers as sanitized GitHub Flavored Markdown, including lists, code, tables, links, and task items.
- Replace upstream GitHub 502/503/504 HTML responses with retryable user-facing errors.
- Prevent duplicated agent limit failures and identify time and tool budget exhaustion separately.

## [0.2.1] - 2026-07-16

### Added

- Restore optional `GH_TOKEN` authentication for local installations. When the variable is non-empty, MemoRepo uses it for GitHub REST and Git operations instead of requesting OAuth Device Flow login.

### Changed

- Give `GH_TOKEN` priority over any locally stored OAuth credential and show the active authentication mode in System health.

### Security

- Keep `GH_TOKEN` out of API responses, unrelated child-process environments, Git remotes, and generated MCP configurations; pass it ephemerally only to authenticated Git operations.

## [0.2.0] - 2026-07-15

### Added

- Add dashboard-driven GitHub OAuth Device Flow with one active local account, connection status, automatic repository sync, local disconnect, and a direct link to review or revoke the authorization on GitHub.
- Add authenticated, encrypted storage for the GitHub OAuth access token with a separate persistent encryption-key volume.
- Include MemoRepo's public OAuth Client ID so users can authorize the official integration without registering an application or configuring GitHub credentials.

### Changed

- **Breaking:** Remove manual GitHub token authentication. Existing installations must update MemoRepo, restart it, and sign in with GitHub from **System health**; no GitHub environment credential is required.
- Route GitHub REST and Git operations through the stored OAuth credential and allow the application to start safely before an account is connected.
- Report account connection, granted scopes, visible repositories, and organization policy warnings through system preflight.

### Security

- Keep the private device code in API memory, validate the authorized GitHub identity before persistence, encrypt the access token with AES-256-GCM, and avoid exposing credentials in API responses, logs, Git remotes, CBM subprocesses, or generated MCP configs.

## [0.1.9] - 2026-07-12

### Changed

- Normalize MCP code locations to repository-relative `file_path` values while returning project context separately.
- Document that indexed code text matching is case-sensitive.

### Fixed

- Harden MCP input validation and recovery guidance: reject empty snippet symbols, explicit empty project scopes, control characters, invalid structured-search regular expressions, repeated node variables across relationship patterns, and unlabeled inline-property Cypher patterns; derive invalid-label hints from each project's actual schema instead of returning misleading native failures.
- Make read-only Cypher results trustworthy: return exact whole-project counts, reject or flag aggregations that hit the engine ceiling, replace unsupported standalone clauses and ignored ordering with actionable errors, provide gateway-controlled scoped offsets instead of broken `SKIP`, allow properties named like mutation keywords, and reject properties absent from every available schema.
- Correct cross-repository execution and continuation: search every repository before applying global limits, interleave global results fairly, prevent empty early repositories from hiding later matches, replace unreachable global graph offsets with explicit per-project continuation, and omit root `has_more` when continuation requires a concrete project scope.
- Make search pagination complete and internally consistent: paginate graph search beyond the first 100 candidates with combined totals, expose code-search offsets and metadata beyond the first 25 matches, keep structured and code-search candidate counts stable across pages, make final native windows reachable without advertising impossible pages, preserve scoped totals beyond the final result, and allow every combined projectless code-search candidate to be reached beyond the per-project engine window.
- Strengthen exact symbol and snippet identity: reject contradictory trace names, recover exact candidates through structured search or retrievable snippets when direct lookup misses, preserve actionable ambiguity errors, mark abbreviated suffix matches and homonymous snippets as low-confidence with explicit warnings while withholding unreliable neighbor metadata, and reconcile source-backed recursion flags, return types, and caller counts.
- Make call traces conservative and evidence-based: normalize project-prefixed and relative caller identities before validation, remove contradicted self-hops and receiver-incompatible `CALLS` edges with correction counts, filter homonymous contamination from exact traces and graph queries, recover HTTP callees from exact source when native name-only traversal is ambiguous, and preserve valid internal or imported callers unless positive receiver evidence proves an edge incompatible.
- Unify and enrich HTTP route behavior: preserve endpoint paths during sanitization; normalize dynamic, dotted, and concatenated parameters; infer missing methods only from matching indexed source; share one source-enriched inventory across architecture, Route search, simple Route Cypher, and schema counts; discover routes when native architecture omits them; mark source-less routes without fictitious locations, line ranges, or empty metadata; mark synthesized routes non-navigable when their exact snippet identity cannot be resolved; remove redundant `ANY` entries; and avoid injecting routes into unrelated requested architecture aspects.
- Honor compact repository listings unless detailed metadata is explicitly requested.

## [0.1.8] - 2026-07-11

### Changed

- Upgrade the containerized code intelligence engine from 0.8.1 to 0.9.0 with verified release checksums.
- Negotiate MCP tool availability with the installed code intelligence engine instead of publishing a static tool list.
- Resolve trace targets by qualified symbol identity and expose usage references for callbacks and functions passed as values.

### Fixed

- Stop advertising semantic search when the installed engine does not support it.
- Reject ambiguous trace targets instead of returning cross-language matches based only on common symbol names.

## [0.1.7] - 2026-07-11

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
- Prevent CBM child processes from inheriting GitHub credentials and unrelated environment secrets.

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

[Unreleased]: https://github.com/abelmaro/MemoRepo/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/abelmaro/MemoRepo/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/abelmaro/MemoRepo/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/abelmaro/MemoRepo/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/abelmaro/MemoRepo/compare/v0.1.9...v0.2.0
[0.1.9]: https://github.com/abelmaro/MemoRepo/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/abelmaro/MemoRepo/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/abelmaro/MemoRepo/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/abelmaro/MemoRepo/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/abelmaro/MemoRepo/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/abelmaro/MemoRepo/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/abelmaro/MemoRepo/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/abelmaro/MemoRepo/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/abelmaro/MemoRepo/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/abelmaro/MemoRepo/tree/v0.1.0
