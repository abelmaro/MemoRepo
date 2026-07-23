# MemoRepo landing

Static Astro landing page for the public MemoRepo project site. The generated HTML contains the complete page content and is configured for the case-sensitive GitHub Pages path `/MemoRepo/`.

## Local development

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev:landing
```

Open `http://localhost:4321/MemoRepo/` unless Astro reports a different port.

## Validation and build

```bash
pnpm --filter @memorepo/landing typecheck
pnpm --filter @memorepo/landing build
pnpm --filter @memorepo/landing test:unit
pnpm --filter @memorepo/landing test:browser
```

The browser smoke test expects a completed build and checks the full Motion journey, reduced-motion behavior, breakpoint boundaries, orientation changes, accessibility, keyboard interactions, console errors, horizontal overflow, and the JavaScript-disabled page across Chromium, Firefox, and WebKit.

The production output is written to `apps/landing/dist`.

## GitHub Pages

The workflow at `.github/workflows/deploy-landing-pages.yml` validates pull requests and deploys successful `main` builds.

Enable it once in the repository:

1. Open **Repository Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. Run **Deploy landing to GitHub Pages** manually or merge a landing change to `main`.

The default deployment URL is `https://abelmaro.github.io/MemoRepo/`.

The project-site `robots.txt` is served at `/MemoRepo/robots.txt`; it is not the host-level robots file for `abelmaro.github.io`. Indexing does not depend on it. The generated sitemap can be submitted directly to Search Console at `https://abelmaro.github.io/MemoRepo/sitemap.xml`.

## Custom domain

Site URLs are controlled at build time:

- `SITE_ORIGIN` defaults to `https://abelmaro.github.io`.
- `BASE_PATH` defaults to `/MemoRepo`.
- `CANONICAL_URL` is derived from those two values.

For a verified custom domain, configure the domain in GitHub Pages first, set DNS without wildcards, enable HTTPS, then build with the custom origin and a root base path. For example in PowerShell:

```powershell
$env:SITE_ORIGIN = "https://docs.example.com"
$env:BASE_PATH = "/"
pnpm --filter @memorepo/landing build
```

Validate the canonical URL, Open Graph image, sitemap, manifest, and `.well-known/security.txt` after the change. Add a `CNAME` only after the real domain is selected and configured.
