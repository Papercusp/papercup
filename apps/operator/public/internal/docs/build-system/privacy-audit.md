# Privacy audit (PostHog leak scanner)
URL: /internal/docs/build-system/privacy-audit

The V1 ship contract, how bin/audit-bundle.sh enforces it, and how to extend it for future leak categories.

## The V1 contract

A freshly installed production binary must:

1. Make **zero network requests** to `flags.papercuspai.com` under any usage.
2. Resolve every feature flag to `false` (so snapshot / template / marketplace / cloudflare-publish / oracle / harness-phases / design / admin / rust-port-ui surfaces are unreachable).

Both must hold without anyone configuring anything post-install.

## How the system already enforces it

`apps/operator/lib/posthog-config.ts` resolves the active PostHog configuration in this priority order:

1. **Env vars** — `PAPERCUSP_POSTHOG_HOST`, `PAPERCUSP_POSTHOG_KEY`, `PAPERCUSP_POSTHOG_PERSONAL_KEY`, `PAPERCUSP_POSTHOG_TESTING_FEATURES`
2. **Discovery file** — `~/.papercusp/posthog.json` (and `~/.papercusp/posthog-personal.json` for the personal API key)
3. **Default** — `{testingFeaturesEnabled: false}` → `source: "unconfigured"` at the resolver layer / `source: "defaults"` at the `/api/flags/bootstrap` layer

`apps/operator/lib/flag-bus.ts` only initializes the PostHog client when `isTestingFeaturesEnabled() === true`. So on a clean install (no env vars, no discovery files), the PostHog SDK never starts. **Zero network requests by construction.**

`libs/flags/src/types.ts` exports `FLAG_DEFAULTS` with every flag defaulting `false`. These are baked into the bundle. On a clean install they are the values returned.

## What the auditor scans for

`papercusp-desktop/bin/audit-bundle.sh` rejects an artifact if any of these strings appear anywhere inside:

```
posthog.json
posthog-personal.json
PAPERCUSP_POSTHOG_HOST
PAPERCUSP_POSTHOG_KEY
PAPERCUSP_POSTHOG_PERSONAL_KEY
PAPERCUSP_POSTHOG_TESTING_FEATURES
```

The discovery-file basenames cover the "file got accidentally bundled as a resource" leak. The four env-var names cover the "build-time env was baked into the binary as a literal" leak (e.g. via `process.env.PAPERCUSP_POSTHOG_KEY` getting inlined by Next.js's `NEXT_PUBLIC_*` mechanism if someone renames the var).

## Supported artifact formats

```
.deb         → dpkg-deb -x
.rpm         → rpm2cpio | cpio -idm  (falls back to 7z)
.dmg         → hdiutil attach  (on Linux: 7z)
.msi         → 7z x
.exe (NSIS)  → 7z x
.AppImage    → ./Artifact --appimage-extract
directory    → scanned in place (useful for .next-prod/standalone)
```

Extraction goes into a `mktemp -d` and is `rm -rf`'d on exit.

## Usage

```sh
bin/audit-bundle.sh path/to/Papercusp_0.0.1_amd64.deb
bin/audit-bundle.sh /home/marsh-office/Papercusp_0.0.1_x86_64.dmg \
                    /home/marsh-office/Papercusp_0.0.1_x64_en-US.msi \
                    /home/marsh-office/Papercusp_0.0.1_x64-setup.exe
```

Exit codes:

* `0` — all clean (`OK: N/N artifacts clean`)
* `1` — at least one artifact had a match
* `2` — usage error

## /admin integration

Three integration points:

1. **Inside each prod-build command** (Linux, Mac, Windows): the build script runs the auditor on its own output before declaring success. A bundled leak fails the build.
2. **Standalone "Audit prod bundles for PostHog leaks" card** — re-runs against everything currently on disk in `/home/marsh-office/` and the workspace `bundle/{deb,rpm}` dirs.
3. **CI-equivalent local check** — `bin/audit-bundle.sh` can be called from any context; consider adding it to a pre-release script if/when one exists.

## Verified-clean status (2026-05-13)

All four currently-built artifacts pass:

```
Papercusp_0.0.1_amd64.deb       (700 MB)  OK
Papercusp_0.0.1_x86_64.dmg      (460 MB)  OK
Papercusp_0.0.1_x64_en-US.msi   (375 MB)  OK
Papercusp_0.0.1_x64-setup.exe   (268 MB)  OK
```

## Extending the scanner

If a new "must not ship in prod" string is identified (e.g. another personal API key file, a new env var), edit `papercusp-desktop/bin/audit-bundle.sh`:

```sh
NEEDLES=(
  'posthog.json'
  'posthog-personal.json'
  'PAPERCUSP_POSTHOG_HOST'
  'PAPERCUSP_POSTHOG_KEY'
  'PAPERCUSP_POSTHOG_PERSONAL_KEY'
  'PAPERCUSP_POSTHOG_TESTING_FEATURES'
  # add new entries here
)
```

Then run the standalone audit card to verify existing artifacts before declaring the new policy enforced.

## Why this isn't a regex / AST scan

The bundles are gigabytes of compiled JS, minified standalone output, native binaries, postgres data files, etc. A plain `grep -rlF` is fast (\~5–10s per artifact) and the false-positive risk is negligible — the strings are specific enough that they don't occur in unrelated content. If a future needle string is generic enough to false-positive, narrow it with a context-anchor (e.g. `PAPERCUSP_POSTHOG_KEY=`).

## What the auditor does NOT catch

* **Behavioral leaks**: code that hardcodes `flags.papercuspai.com` and calls `fetch()` regardless of `isTestingFeaturesEnabled()`. The auditor scans for strings related to *configuring* the SDK, not the SDK itself. Defense: the build chain validates `flag-bus.ts`'s gating discipline; no code outside that file should touch PostHog endpoints.
* **Same-host PostHog instance accidentally pointing prod traffic somewhere it shouldn't**. Defense: see the V1 contract — even with a wrong host, the client must not start.
* **Telemetry from other sources** (Tauri's auto-update, Next.js Fast Refresh's analytics, OS crash reporters). These are separate trust decisions documented elsewhere.

If you need to validate behavioral guarantees, see [verification](/internal/docs/build-system/verification) — that page covers the live-run smoke test (`curl /api/flags/bootstrap`, `ss -tnp | grep flags.papercuspai`) that catches behavioral leaks.
