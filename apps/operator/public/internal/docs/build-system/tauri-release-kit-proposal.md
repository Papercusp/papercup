# Proposal — shared desktop build kit (@papercusp/tauri-release-kit)
URL: /internal/docs/build-system/tauri-release-kit-proposal

Abstracting the Linux/Mac/Windows Tauri build+release pipeline into a shared library usable by both papercusp and oddsmith. Design, seam contract, migration.

:::note\[Status: proposal / plan-first]
This is a **design proposal**, not shipped behaviour. No code has been extracted
yet. It exists for owner review before any refactor, per the
`tauri-release-kit-shared-build-2026-06-25` plan. The in-flight
Mac + Windows **public-release drive** (`windows-public-release-readiness-2026-06-25`)
is actively changing the very scripts this would extract — see
[Risks & timing](#risks--timing).
:::

## The ask

Can the cross-platform (Linux / macOS / Windows) desktop build + release
pipeline be abstracted into a generalized shared library that **both papercusp
and oddsmith** use?

**Short answer: yes — the release *orchestration* generalizes cleanly; the
*sidecar build* does not and must stay a per-app injected seam.** That split is
the whole design.

## What the pipeline does today

The canonical tree is the **`papercup/papercusp-desktop/` git submodule**
(v0.0.2). It builds three platform families, all driven from `bin/`:

| Layer                                                     | Driver                                                                | Where it runs                                                                     |
| --------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Linux `.deb` / `.AppImage` / `.rpm` (x86\_64, opt. arm64) | `bin/release-local.sh` → `tauri build`                                | dev host, locally                                                                 |
| macOS universal `.dmg`                                    | `bin/mac-vm-build.sh` → `tauri build --target universal-apple-darwin` | macOS VM over SSH (`:2222`)                                                       |
| Windows `.msi` + NSIS `.exe`                              | `bin/build-windows-on-vm.sh` → `win-build.ps1`                        | Windows VM over SSH (`:2223`); WSL2 runtime distro from `scripts/build-rootfs.sh` |

`bin/release-local.sh` is the spine. Its steps:

1. **Version bump** across `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`.
2. **Build the sidecar** (`bin/build-desktop-sidecar.sh`, \~1,070 lines).
3. **`tauri build`** per target — Tauri does native bundling + minisign signing
   in one shot, keyed by `TAURI_SIGNING_PRIVATE_KEY_PATH`.
4. **Generate `latest.json`** (the auto-updater manifest) — maps
   `{platform → {url, signature}}` against the GitHub release download URL.
5. **Commit + tag + push** (`desktop-vX.Y.Z[-channel]`).
6. **`gh release create/upload`** (idempotent, `--prerelease` for alpha/beta).

## The core insight: two layers, only one generalizes

The pipeline is **release orchestration** wrapped around a **sidecar build**,
and they generalize very differently:

* **Release orchestration is domain-free.** Version bump, the `tauri build`
  target matrix, signing, `latest.json` generation, `gh release` upload, and the
  Mac/Windows **VM SSH orchestration** know nothing about what the app *is*.
  This is the shareable half.
* **The sidecar build is wildly app-specific.** Papercusp's
  `build-desktop-sidecar.sh` is **\~1,070 lines** bundling the operator UI +
  harness + orchestrator + MCP server + node-pty + embedded-postgres + pgvector
  * external binaries (omp, gh, MinGit, node) + a WSL rootfs tarball. Oddsmith's
    `apps/desktop/scripts/build-sidecar.mjs` is **\~42 lines** of esbuild over one
    `serve.ts`. There is nothing to share here — it must be an **injected step**.

So the library owns the *dance*; each app supplies a `buildSidecar()` plugin and
a config object.

### Generic vs injected boundary

| Concern                          | Generic (in the kit)                        | Injected per-app (seam)                       |
| -------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Version bump                     | ✅ field-path-driven updater                 | which files/fields                            |
| `tauri build` matrix             | ✅ Linux x64/arm64, Win cross, Mac universal | which targets enabled                         |
| Signing                          | ✅ already an env-var seam                   | key path / passphrase                         |
| `latest.json` / updater manifest | ✅ generator                                 | GH download base URL                          |
| `gh release` create/upload       | ✅ idempotent driver                         | owner/repo, tag pattern, channel→prerelease   |
| Mac/Windows **VM orchestration** | ✅ SSH/SCP/rsync boilerplate                 | VM host/port/user/key, build dir              |
| WSL rootfs builder               | ✅ Docker bootstrap algorithm                | pkg list, output path                         |
| **Sidecar build**                | ❌ stays per-app                             | the whole `buildSidecar()` impl               |
| App metadata                     | ❌                                           | name, id, bundle targets, category, publisher |

## Where it would live, and how it's consumed

Oddsmith already consumes papercusp **as published npm packages** (`@papercusp/sse`,
`@papercusp/sync`, `@papercusp/ui-primitives`, `@papercusp/embedded-pg-discovery`,
…) via workspace `*` deps — **not** a submodule. So the kit should follow the
**same existing pattern**, not invent a new one:

> **`@papercusp/tauri-release-kit`** under `libs/generic/`, published as an npm
> package exposing (a) a typed `TauriReleaseConfig` + programmatic API and (b) a
> thin `bin/` CLI. Each app gets a small `release.config.ts` + a
> `bin/release` wrapper. This matches the `libs/generic/*` + `configure*()` seam
> convention catalogued in `BORROWABLE.md`.

A git-submodule of the whole desktop tree was considered and rejected: oddsmith
deliberately does not submodule papercusp, and the desktop *shells* legitimately
differ (oddsmith builds its own SPA + a tiny sidecar; papercusp serves
operator-vite + the heavy sidecar). Sharing the **kit** (logic), not the
**shell** (the Tauri app), is the right grain.

### Seam contract (sketch — illustrative, not final)

```ts
export interface TauriReleaseConfig {
  appName: string;              // "Papercusp"
  appId: string;                // "com.papercusp.desktop"
  repo: { owner: string; name: string };
  tagPattern: (v: string, ch: Channel) => string;   // desktop-vX.Y.Z[-ch]
  versionFiles: VersionField[]; // [{file, kind: 'json'|'toml', path}]
  targets: Partial<Record<Target, TargetOpts>>;      // linux-x64, ...
  signing: { keyPath: string; passwordEnv?: string };
  latestJsonUrl: (a: { tag: string; name: string }) => string;
  vm?: { mac?: VmSsh; windows?: VmSsh };             // host/port/user/key/dir
  buildSidecar: (ctx: SidecarCtx) => Promise<void>;  // ← the injected seam
}
```

`buildSidecar` is the firewall: papercusp wires in its 1,070-line bash; oddsmith
wires in its esbuild. The kit never knows the difference.

## Migration order

1. **Resolve canonicity (blocker).** Three desktop trees exist:

   * `papercup/papercusp-desktop/` — **submodule, v0.0.2, canonical** (has the
     VM build scripts). Extract from here.
   * `papercupai-workspace/papercusp-desktop/` — standalone, v0.0.1, **stale**.
   * `papercup/libs/papercusp/apps/desktop/` — vestigial, no build scripts.

   Confirm/retire the stale + vestigial trees first, or the extraction bakes in
   drift.
2. **Extract the kit** behind the seam; **papercusp adopts it first** — its
   `bin/release-local.sh` becomes a thin wrapper over the kit. Prove byte-identical
   (or intentionally-improved) artifacts.
3. **Oddsmith adopts second** — add `release.config.ts` + `buildSidecar` (its
   esbuild) + a `bin/release`, giving oddsmith the Linux/Mac/Windows release flow
   it currently lacks entirely.

## Risks & timing

* ⚠ **The release scripts are being actively stabilized right now.** The
  `windows-public-release-readiness-2026-06-25` drive (and the Mac drive) are
  editing `build-windows-on-vm.sh`, Authenticode signing, and the WSL rootfs as
  of this writing. Refactoring mid-cut risks destabilizing a live public
  release. Safest sequencing: extract **after** that release lands, **or** scope
  a first pass to the **stable Linux x86\_64 core only** (the part not in flux)
  and prove it on both apps before touching the VM paths.
* The sidecar seam must be drawn carefully — papercusp's bundling pulls \~1GB of
  external binaries with platform-specific exclusions (omp/code-server dropped on
  Windows for NSIS size limits); these stay entirely on papercusp's side of the
  seam.

## Open questions (for owner)

1. Go now, or after the public-release drive stabilizes?
2. Full kit (incl. VM orchestration) vs Linux-core-first slice?
3. `libs/generic/` npm package (recommended) vs a standalone `Papercusp/tauri-release-kit` repo?
