# Contributing to MemoRepo

Thank you for helping improve MemoRepo. Keep contributions focused, explain
the user-facing reason for each change, and avoid unrelated refactoring.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
For vulnerabilities, follow the private process in the
[Security Policy](.github/SECURITY.md) instead of opening a public issue.

## Before You Start

- Search existing issues and pull requests for related work.
- Open an issue before a large feature or breaking change so its scope can be
  agreed on before implementation.
- Never include credentials, private repository content, local paths, personal
  data, or unsanitized logs in an issue, commit, or pull request.

## Development Requirements

- Node.js 22 or newer
- pnpm 10.28.2, as declared by the root `packageManager` field
- Docker Desktop, or Docker Engine with Compose on Linux

Install dependencies from the repository root:

```bash
pnpm install
```

Copy `.env.example` to `.env` and provide the required local values. The
`.env` file is ignored by Git and must never be committed. For a complete
runtime walkthrough, see the [quickstart](docs/quickstart.md).

## Repository Layout

- `apps/api`: Fastify API, command-line integration, persistence, and services
- `apps/web`: React and Vite dashboard
- `packages`: shared workspace packages
- `docs`: product, runtime, and integration documentation

Generated `dist`, coverage, dependency, database, log, and local runtime files
must not be committed.

## Running the Project

Run the API or dashboard directly during development:

```bash
pnpm dev:api
pnpm dev:web
```

Run the supported product environment with Docker Compose:

```bash
docker compose up --build
```

## Making Changes

- Create a short branch name that describes the product change.
- Write all branch names, commit messages, pull request titles, changelog
  entries, public documentation, and code comments in English.
- Use clear, product-oriented commit messages such as
  `fix - reject invalid repository paths`.
- Add or update tests for behavior changes. If tests are not practical, explain
  why in the pull request.
- Update public documentation when behavior, configuration, or user workflows
  change.
- Preserve backward compatibility unless the change explicitly proposes a
  breaking release.

## Validation

Run the smallest relevant checks while developing. Before requesting review,
run the complete repository checks from the root:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Do not report a check as passing unless it was run successfully. If a check
cannot run in your environment, document the command and reason in the pull
request.

## Issues

Use the provided issue forms for reproducible bugs and feature proposals.
Include the affected version, component, environment, expected result, actual
result, and minimal reproduction when reporting a bug. Sanitize logs before
attaching them.

Keep security vulnerabilities out of public issues. Follow
[SECURITY.md](.github/SECURITY.md) for private disclosure.

## Pull Requests

- Keep each pull request limited to one coherent outcome.
- Complete the pull request template and link the relevant issue.
- Describe observable behavior changes and important implementation choices.
- Include screenshots or recordings for visible interface changes.
- Call out migrations, compatibility risks, and security implications.
- Respond to review feedback with follow-up commits or a clear explanation.

Maintainers may ask for a change to be split when independent concerns would
be easier to review and release separately.
