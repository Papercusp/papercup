---
title: Desktop-app install integration — bundle the omp-su setup into Papercusp.app
slug: desktop-app-install-integration-2026-05-23
status: shipped
created: 2026-05-23
updated: 2026-05-24
owner: pandawamble@gmail.com
related:
  - apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md
  - apps/operator/docs/plans/per-harness-plans-and-docs-2026-05-23.md
---

## Now

**State:** SHIPPED. All 13 items done across this autonomous loop. Phase 1 (always-on file install): `installPapercuspFiles()` + `POST /api/desktop/install/papercusp-files` + sidecar self-install when `PAPERCUSP_DESKTOP=1`. Phase 2 (opt-in OMP wiring): `GET / POST / DELETE /api/desktop/install/omp-integration` with full library coverage. Phase 3 (settings UI): `/settings/omp-integration` panel. Decisions D-001a / D-002a / D-003a ratified. 20 new tests, all green.
**Next:** Plan-doc-only edit. Promote to `status: shipped` when comfortable. Future work: real Papercusp.app build to confirm bundled sidecar layout end-to-end (the sidecar-build script change at `papercusp-desktop@49787bc` is what to verify).

# Desktop-app install integration

## §1 Why

`omp-su` is set up by `install-standalone-mcp.sh`. The script needs `bash` + `python3` + `curl` + `uuidgen` — Mac users *might* have all four, Windows users won't, Linux usually does. Shelling out from the Tauri desktop bundle is not a real cross-platform answer. The install logic needs to live where the bundle already has it: Node (the operator sidecar) for filesystem/JSON/HTTP, with the Tauri host kicking it off at startup.

A second motivation: the install today silently modifies a third-party tool's config (`~/.omp/agent/mcp.json`) + writes wrapper into PATH. That should be a deliberate user choice, surfaced in settings — not a silent install-time side effect.

## §2 Scope

- **Phase 1 — always-on file install.** Mint/reuse the token + agent_id; copy playbook + coord extension to `~/.papercusp/`. No third-party-config touches. Runs at sidecar startup, idempotent.
- **Phase 2 — opt-in OMP integration endpoint.** A separate endpoint the settings UI hits explicitly. Merges `papercusp-su` into `~/.omp/agent/mcp.json`, installs the `omp-su` wrapper to a PATH dir, strips the legacy always-on block from `~/.omp/agent/CLAUDE.md`.
- **Phase 3 — settings UI.** A panel in the operator surfacing OMP detection state, the integration toggle, and a "Re-install now" button.

**Not in scope:** retiring `install-standalone-mcp.sh` (stays as the dev/repo path). Custom Tauri Rust install logic (everything routes through Node).

## §3 Decision context (alternatives behind the needs-human items)

### context for P-001 — where does the install logic live?

- **(a)** **Node operator sidecar.** Two new endpoints (`/api/desktop/install/papercusp-files`, `/api/desktop/install/omp-integration`); Tauri host fires the first at startup. **Recommended** — Node has cross-platform `fs`/`crypto`/`os`; the playbook + extension source files are already in the operator app; the operator already binds the token. Tauri host stays thin.
- **(b)** Tauri host (Rust). All install logic in `src-tauri/src/main.rs` using `std::fs` + `serde_json` + `rand`. Pro: zero round-trip; runs before the sidecar boots. Con: duplicates logic the operator could do; needs the playbook + extension as Tauri *resources*, not operator-app files.
- **(c)** Both — Tauri does always-on (Phase 1), operator does opt-in (Phase 2). Splits ownership without real benefit.

### context for P-005 — Windows support?

- **(a)** **Mac + Linux only in v1; defer Windows.** **Recommended** — Windows needs a `.cmd` shim (not a bash wrapper); needs `setx`-style PATH handling; OMP itself may not run cleanly on Windows. Cross-platform on day one triples the testing surface; defer until Mac/Linux work first.
- **(b)** Day-one Windows support — `.cmd` wrapper, `%USERPROFILE%\.papercusp\` paths, PATH munging via PowerShell.
- **(c)** Detect OMP per-platform, skip the wrapper install on Windows with a clear message.

### context for P-009 — settings UI placement

- **(a)** A new panel under existing operator settings — "OMP Integration" tile. **Recommended** — discoverable; matches how other integrations surface.
- **(b)** First-run setup wizard step — "Enable engineer-collaborator integration?" The setup wizard already exists (`setup-wizard` commits this session) — natural insertion point but only fires once.
- **(c)** Both — wizard offers it once, settings panel for later changes.

## §4 Phase 1 design — always-on file install

**Endpoint:** `POST /api/desktop/install/papercusp-files` (no auth; localhost-only).

Does:
1. Ensure `~/.papercusp/` exists.
2. Token: read `~/.papercusp/superuser-token` if non-empty; else mint a fresh 32-byte token and write it. (Same logic as `install-standalone-mcp.sh` after `a03fb875` — reuse, don't rotate.)
3. Agent id: read `~/.papercusp/su-agent-id` if non-empty; else mint a UUID and write it.
4. Copy playbook from `<operator-app>/prompts/papercusp-su.tools.md` → `~/.papercusp/engineer-collaborator.md` (refresh on every call — picks up app updates).
5. Copy coord extension from `<operator-app>/scripts/hooks/omp/coord-hook.ts` → `~/.papercusp/papercusp-coord.ts`.

Returns `{ tokenPath, agentIdPath, playbookPath, extensionPath, minted: { token, agentId } }` so the host can log what happened.

**Tauri integration:** `src-tauri/src/main.rs` — after sidecar reaches "ready," fire one `POST` (best-effort; log on failure). No retry; the next launch tries again.

## §5 Phase 2 design — opt-in OMP integration endpoint

**Endpoint:** `POST /api/desktop/install/omp-integration` (no auth; localhost-only).

Does (idempotent, mirrors `install-standalone-mcp.sh` steps 3–4d):
1. Detect OMP — check `~/.omp/agent/` exists or `command -v omp`.
2. Merge `papercusp-su` server into `~/.omp/agent/mcp.json` (preserves other servers).
3. Strip the legacy managed block from `~/.omp/agent/CLAUDE.md`.
4. Install `omp-su` wrapper — co-located with the `omp` binary on PATH (or `~/.local/bin` fallback with a warning in the response).
5. Returns `{ ompDetected, mcpJsonPath, wrapperPath, legacyBlockStripped, pathWarning? }`.

**Endpoint:** `GET /api/desktop/install/omp-integration` — read current state (detected? installed?). Settings UI polls this.

## §6 Phase 3 design — settings UI

Operator settings → new "OMP Integration" tile. Shows:
- OMP detection state (`✓ Detected at /home/.../omp` or `✗ Not detected`).
- Integration state (`Installed (last refreshed 14:22)` or `Not installed`).
- Toggle: "Install / Re-install" → POST integration endpoint; "Uninstall" → DELETE endpoint (separate item — see P-013).
- The four managed paths, copyable.

Calls into the Phase 2 endpoint. No Tauri-side logic.

## §7 Migration & coexistence with the shell script

- `install-standalone-mcp.sh` stays. Documented as the dev/repo path: "If you cloned the repo and run `cd papercusp-desktop && npm run dev`, use this script to set up `omp-su` against your dev operator. If you installed `Papercusp.app`, it's done for you automatically."
- The shell script and the desktop endpoints write the same files in the same shape. Idempotent in either direction — re-running one after the other is a no-op.
- The script's `superuser-token` reuse logic (commit `a03fb875`) is the canonical reference; Node ports it verbatim.

## Phase 1 — always-on file install

- **P-001** `done` Decide where the install logic lives. Recommendation: Node operator sidecar (D-001a). See §3. (— D-001 ratified Node sidecar)
- **P-002** `done` Implement `POST /api/desktop/install/papercusp-files` (Node) — token + agent_id + playbook + extension. blocked-by: P-001 (— shipped f7b80951 + registered 0ae7df2c; verified live with POST returning 200)
- **P-003** `done` Locate the playbook + extension source paths inside the bundled sidecar resources (Tauri ships them — pick the right relative path). blocked-by: P-001 — sidecar build copies both files (papercusp-desktop@49787bc); operator candidate-path fallback handles dev + sidecar layouts
- **P-004** `done` Tauri host fires the endpoint at startup after sidecar reaches "ready." Best-effort, logs on failure. blocked-by: P-002 — pivoted to sidecar self-install via `PAPERCUSP_DESKTOP=1` env in `host-bootstrap.ts` (commit 2e65de9d), strictly better than the Rust route (no new HTTP dep, no env wiring)
- **P-005** `done` Decide Windows scope. Recommendation: Mac + Linux only in v1 (D-002a). See §3. (— D-002 ratified Mac+Linux v1, defer Windows)
- **P-006** `done` Tests: token mint vs reuse, agent-id mint vs reuse, playbook overwrite refreshes content, sidecar-resource path resolves correctly. blocked-by: P-002 (— covered by 7 tests in f7b80951: first-install + re-run + mode-0600 + missing-source + reuse-without-newline + resolveInstallPaths shape)

## Phase 2 — opt-in OMP integration endpoint

- **P-007** `done` Implement `POST /api/desktop/install/omp-integration` (Node) — mcp.json merge, wrapper install, legacy-block strip. blocked-by: P-005 — shipped with PUT/DELETE too
- **P-008** `done` Wrapper-install logic platform-aware: POSIX → bash shim in `~/.bun/bin/` or `~/.local/bin/`; Windows → out of scope per P-005. blocked-by: P-005 — co-locates with detected omp binary, falls back to ~/.local/bin/; win32 short-circuits with reason=windows_not_supported_in_v1
- **P-009** `done` Implement `GET /api/desktop/install/omp-integration` — current state probe. blocked-by: P-007
- **P-010** `done` Tests with a fake `~/.omp/` tree: detection, merge preserves other entries, wrapper PATH warning when `~/.local/bin` not on PATH. blocked-by: P-007 — 13 tests cover detection + merge + wrapper-co-locate + path-warning + legacy-block strip + uninstall

## Phase 3 — settings UI

- **P-011** `done` Decide settings panel placement. Recommendation: new "OMP Integration" tile in operator settings (D-003a). See §3. (— D-003 ratified OMP Integration settings tile)
- **P-012** `done` Build the settings panel — detection state, install toggle, "Re-install now" button, managed paths. blocked-by: P-009, P-011 — `/settings/omp-integration` with detection table, install/uninstall buttons, action log, pathWarning surface. Wired into the Advanced settings group in `app/settings/layout.tsx`.
- **P-013** `done` Implement `DELETE /api/desktop/install/omp-integration` — uninstall: remove mcp.json entry, remove wrapper, optionally re-add CLAUDE.md block (or just delete the integration). blocked-by: P-007 — shipped together with Phase 2 (commit 5b8ba168). Does not re-add legacy CLAUDE.md block; pure uninstall.

## §8 Out of scope

- Retiring `install-standalone-mcp.sh` — stays as the dev/repo path.
- Custom Tauri Rust install logic — everything Node-side.
- Windows wrapper — deferred (P-005a).
- A full GUI installer for Papercusp itself (the Tauri bundle handles that).

## Decisions

(none yet — appended as `### D-NNN — title` when P-001 / P-005 / P-009 are ratified.)

### D-001 — D-001a — install logic lives in the Node operator sidecar
Date: 2026-05-24
Ratified P-001. Install logic goes in the Node operator sidecar — two endpoints under `/api/desktop/install/`. Tauri host stays thin and fires the always-on endpoint at startup.

Why Node sidecar over Tauri Rust:
- Cross-platform `fs`/`crypto`/`os` already there; no new Rust deps.
- Playbook + extension source files already live in the operator app — no Tauri-resource handling needed.
- Operator already binds the superuser token — single owner.
- Keeps Tauri host minimal (preferred direction).

Cost of being wrong: small. If a startup-ordering issue surfaces, Tauri can do the always-on directly (option c) later; the API surface stays the same.
Related: P-001

### D-002 — D-002a — Mac + Linux only in v1; defer Windows
Date: 2026-05-24
Ratified P-005. v1 supports Mac + Linux only. Windows deferred to a separate plan.

Why:
- Windows needs `.cmd` shim instead of bash wrapper; needs PowerShell PATH munging; OMP itself may not run cleanly there.
- Cross-platform on day one triples testing surface for the unproven happy path.
- Most current papercusp users + the engineers building it are Mac/Linux.

Implementation: detect `process.platform === 'win32'` in the omp-integration endpoint and return `{ supported: false, reason: 'Windows is not yet supported' }`. The papercusp-files endpoint (Phase 1) is platform-agnostic — works on Windows for free.
Related: P-005

### D-003 — D-003a — settings tile placement for OMP integration
Date: 2026-05-24
Ratified P-011. New "OMP Integration" tile in operator settings. NOT a setup-wizard step.

Why:
- Settings panel is the discoverable, repeatable surface; wizard fires once.
- Matches how other integrations (mobile pair, backups) surface.
- The toggle needs to be revisitable — users may install OMP after Papercusp, or want to uninstall the integration without uninstalling Papercusp.

Could later add a one-shot wizard nudge (option c) without architecture changes.
Related: P-011
