---
title: Fleet spawn containment: native per-backend OS sandboxing
slug: fleet-spawn-sandbox-2026-06-01
status: ready
created: 2026-06-01
updated: 2026-06-01
owner: avi@storewolf.com
---

# Fleet spawn containment: native per-backend OS sandboxing

## Now

**State:** P-012 (live verification) DONE — and it overturned Phases 2-3. Outcome per backend: **claude** sandbox works (cred/egress/Read-deny verified, no hang) — the ONLY viable one; **codex** FAILS — `-s workspace-write` cancels MCP tool calls (D-009), so codex now always runs `danger-full-access` regardless of the flag; **omp** FAILS/deferred — `srt` wraps omp's whole process and would gate its own model/MCP (D-010), plus omp is mis-configured on this box, so the srt-wrap + helpers were removed and omp runs unsandboxed. Net: `PAPERCUSP_FLEET_SANDBOX` now enables ONLY claude's sandbox; codex+omp keep their working defaults. 72 unit tests; submodule `papercusp@646abad`. P-013 (default-on) NOT done: P-012 didn't fully pass, and even claude's deny-all command egress (`allowedDomains: []`) would break roles that need the network (npm/pip install) — so default-on needs per-role egress allowlisting + a full per-role-on-real-harness pass first. Flag remains off-by-default (opt-in).

**Next:** Before any default-on: give claude's sandbox a per-role EGRESS allowlist (so dep-installing roles aren't broken by deny-all) and run a real per-role pass on a desktop; separately, redesign omp's srt config with a per-omp egress allowlist + verify once omp runs on the box. codex stays uncontained pending MCP-under-sandbox upstream.

## Background

### The gap (from D-003-B)

The shipped fleet posture (`claudeMcpArgs`, orchestrator `invoke.ts`) is
default-deny at the *tool* level and blocks dangerous tools/commands, but the
tools a role legitimately needs — `Read`, `Bash`, `WebFetch` — are themselves
the exfil path. A deny-list can't enumerate every secret path, and TLS-opaque
egress can't be pattern-matched. Only an OS sandbox (filesystem view + egress
proxy) closes this. D-003-B recorded it as a deferred "true containment"
follow-up; this plan is that follow-up.

### What each backend provides (verified 2026-06-01)

| Backend | Native fs/net sandbox | Mechanism | Invoke |
|---|---|---|---|
| claude-code | YES (built in) | Linux/WSL2 bubblewrap + `socat` proxy; macOS Seatbelt | `sandbox.enabled` in settings.json |
| codex | YES (built in) | Linux bubblewrap + seccomp (Landlock fallback); macOS Seatbelt | `--sandbox workspace-write --ask-for-approval never` / config.toml |
| omp (oh-my-pi) | NO | — (`omp --help`: only `--allow-home`/`--no-pty`; subagent worktrees are task isolation, not security) | wrap in `srt` (@anthropic-ai/sandbox-runtime) |

Key convergence: all of these are bubblewrap+seccomp / Seatbelt under the hood,
and all follow the same model — the **agent keeps its model-API connection;
only the spawned shell commands are sandboxed**. So one host-dependency story
(`bubblewrap` + `socat` + the seccomp helper; Ubuntu 24.04+ needs a `bwrap`
AppArmor profile) covers every backend.

### The common containment policy (target for all three)

- **Filesystem:** write = the spawn cwd (worktree / projectDir) only; read =
  everything EXCEPT credential dirs (`~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/gcloud`, `~/.papercusp`, `~/.npmrc`).
- **Network:** command egress allowlisted to the model API + the operator
  (`api.anthropic.com` / `api.openai.com` + `localhost:3070`); deny all else.
- **Env:** strip provider/cloud creds from the subprocess env.

## Phase 1 — claude-code native sandbox

- **P-001** `done` Inject a `sandbox` block into the per-spawn claude settings (or `--settings`): `enabled:true`, `failIfUnavailable:true`, `allowUnsandboxedCommands:false` (strict), `filesystem.allowWrite:["."]`, `filesystem.denyRead:[creds]`, `network.allowedDomains:["api.anthropic.com"]` + `allowManagedDomainsOnly:true`. Gated behind `PAPERCUSP_FLEET_SANDBOX`.
- **P-002** `done` Pair the sandbox with `Read`/`Edit` deny rules for the credential paths — the sandbox only covers Bash + children, NOT the Read/Edit/Write tools (Anthropic docs: default read policy "still allows reading credential files such as ~/.aws/credentials and ~/.ssh/"). Without this, cred-reads via the `Read` tool stay open. blocked-by: P-001
- **P-003** `done` Set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` on the spawn env to strip Anthropic/cloud creds from sandboxed subprocesses.
- **P-004** `done` Isolation verification: a `claude -p` spawn under the sandbox can write its cwd, cannot read a sentinel `~/.ssh` secret (via Bash AND via Read), and cannot reach a non-allowlisted domain; a representative role task still completes. blocked-by: P-001, P-002

## Phase 2 — codex native sandbox

- **P-005** `dropped` Orchestrator codex spawn uses `--sandbox workspace-write --ask-for-approval never` (config.toml `sandbox_mode`/`approval_policy`), with `sandbox_workspace_write.writable_roots` = the cwd. workspace-write already blocks command network by default (stricter than claude). Gated behind the same flag. (codex sandbox not viable — workspace-write cancels MCP D-009; reverted to always danger-full-access)
- **P-006** `dropped` Decide codex command-network policy: workspace-write denies it by default; if a role needs the operator API from a command, widen writable_roots/network — but note the macOS `network_access` Seatbelt bug (codex#10390), so don't rely on codex command-network on Mac. blocked-by: P-005 (moot — codex stays danger-full-access D-009)
- **P-007** `done` Isolation verification mirroring P-004 for codex (cwd write ok; cred read denied; egress denied; role task completes). blocked-by: P-005 (standalone-verified; codex MCP under workspace-write gated to P-012) (verified: codex workspace-write cancels MCP → not viable D-009)

## Phase 3 — omp via srt wrapper

- **P-008** `dropped` Add `@anthropic-ai/sandbox-runtime` (`srt`) as the omp containment wrapper: prefix the omp spawn with `srt` carrying an `~/.srt-settings.json` of the common policy (`filesystem.denyRead`/`allowWrite`, `network.allowedDomains`). srt wraps an arbitrary process, cross-platform (same bwrap/Seatbelt+proxy). Gated behind the flag; no-op + warn if `srt`/bwrap absent. (srt wraps whole omp process → breaks its own egress D-010; auto-wrap + helpers reverted)
- **P-009** `done` Isolation verification for the omp+srt path (cwd write ok; cred read denied; egress denied; omp role task completes). blocked-by: P-008 (wrapper-verified; omp-under-srt functioning gated to P-012) (couldn't verify omp mis-configured on box + design flaw found D-010; deferred)

## Phase 4 — host setup, flag, and default-on gate

- **P-010** `done` Shared policy module: one source of truth for the credential-deny list + egress allowlist, mapped onto each backend's config shape (claude settings / codex toml / srt json). Avoids drift across the three. (FLEET_SANDBOX_DENY_READ/ALLOWED_DOMAINS are the shared source mapped onto claude settings + srt schema)
- **P-011** `wip` Host dependency check + docs: `bubblewrap` + `socat` + seccomp helper present; Ubuntu 24.04+ `bwrap` AppArmor profile; `enableWeakerNestedSandbox` when the spawn runs inside a container; fallback-safe + Linux/macOS only (no native Windows). (deps installed on this box srt+ripgrep; bwrap/socat present + documented in D-008; formal dep-check/docs page TODO)
- **P-012** `done` Per-role real-spawn verification pass (the `#1` gold-standard gate): run each pipeline role under the sandbox against a real harness; catalogue tool breakage (watchman, Go-CLI TLS, docker, etc.) and add per-tool `excludedCommands`/`allowWrite` exceptions. Only after this passes do we flip default-on. blocked-by: P-004, P-007, P-009 (verification done — revealed codex+omp non-viable D-009/D-010; claude viable for no-network roles)
- **P-013** `todo` Flip `PAPERCUSP_FLEET_SANDBOX` default-on once P-012 is green; keep `failIfUnavailable` opt-in for managed/CI deployments. blocked-by: P-012 (not flipped — P-012 didn't fully pass; needs claude per-role egress allowlist + full per-role pass first) (gated not an item-dep: needs claude per-role egress allowlist + a full per-role real-spawn pass before default-on)

## Decisions

### D-001 — Use each backend's NATIVE sandbox, not a hand-rolled wrapper
Date: 2026-06-01
Research (web + `claude`/`codex`/`omp --help` on this box) showed claude-code and codex BOTH ship native OS sandboxes built on the same primitives (bubblewrap+seccomp on Linux, Seatbelt on macOS) that sandbox the spawned shell commands while the agent keeps its model-API connection. Rolling our own bwrap wrapper would reinvent it — worse, miss macOS (bwrap is Linux-only) and the egress proxy. So: claude-code → built-in `sandbox.enabled`; codex → `--sandbox`. Only omp lacks one. The host dependency (bubblewrap+socat+seccomp helper) is shared across all three.
Related: P-001, P-005

### D-002 — omp gets @anthropic-ai/sandbox-runtime (srt), not a bespoke wrapper
Date: 2026-06-01
omp (oh-my-pi) exposes no fs/network security sandbox (`omp --help` has only `--allow-home`/`--no-pty`; its subagent worktrees are task isolation, not a boundary). Rather than hand-roll bwrap for omp alone, wrap the omp spawn in Anthropic's standalone `srt`, which wraps any process with the SAME bwrap/Seatbelt+proxy mechanism + an fs/domain allowlist, cross-platform and maintained. Keeps "never roll our own": claude built-in, codex built-in, omp via a maintained wrapper.
Related: P-008

### D-003 — Ship off-by-default; flip default-on only after a real per-role spawn pass
Date: 2026-06-01
Every one of these sandboxes breaks some legitimate tools (Anthropic + OpenAI docs both list: jest+watchman, Go CLIs' TLS under Seatbelt, docker, nested-container /proc). Whether a given role breaks can't be verified from a prompt read — it needs the role doing its real work under the sandbox. So all phases ship behind `PAPERCUSP_FLEET_SANDBOX` (off by default; fallback-safe if deps absent), and default-on is gated on P-012 (the `#1` gold-standard verification). Shipping unverified default-on would repeat the exact mistake D-003-B's investigation warned against.
Related: P-013, P-012

### D-004 — claude's sandbox covers Bash only → pair with Read/Edit deny rules + env scrub
Date: 2026-06-01
Claude Code's sandbox isolates Bash subprocesses, NOT the built-in Read/Edit/Write tools (those go through the permission system), and its default read policy explicitly still allows `~/.aws/credentials` / `~/.ssh/`. So for claude-code the sandbox alone does NOT close cred-reads via the `Read` tool — it must be paired with `Read`/`Edit` deny rules (permission layer) for the credential paths, plus `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`. codex's workspace-write constrains its edits too, so it's more uniform; omp+srt wraps the whole process.
Related: P-002, P-003

### D-005 — Containment is defense-in-depth, not a hard boundary; TLS is not inspected
Date: 2026-06-01
Even with the sandbox, the egress proxy filters by client-supplied hostname WITHOUT terminating TLS, so a broad allowlist enables domain-fronting exfil (Anthropic + OpenAI both warn). Keep the allowlist minimal (model API + operator only). True TLS-aware egress needs a custom MITM proxy + CA inside the sandbox — out of scope here, noted as further hardening if the threat model demands it. Worktree isolation also remains conditional (invoke.ts falls back to the shared projectDir), so the sandbox is the primary containment, not the worktree.
Related: P-001, P-008

### D-006 — Sandbox can't tighten cwd writes per-role; write-discipline stays at the allowed-tools layer
Date: 2026-06-01
P-004 verification (vs claude 2.1.159) — both a confirmation and a correction:

POSITIVE: the worker policy the orchestrator emits works end-to-end — cwd write allowed, egress to a non-allowlisted host blocked (exit 56), `~/.ssh` hidden from Bash (`ls` empty), and the **Read TOOL on `~/.ssh/config` denied** by the `permissions.deny` rule ("denied by your permission settings"). So cred-read closure (Bash via denyRead + the Read/Edit tools via permission deny) and egress closure both hold.

CORRECTION: per-role WRITE tightening is NOT achievable via claude's sandbox. The cwd is **always writable** — `allowWrite` only ADDS paths beyond cwd (an empty array is a no-op, not "no writes"), and `denyWrite` of the cwd did not reliably block either (bwrap then wrote the file). So the original idea of `allowWrite:[]` for the API-only roles was ineffective and has been removed.

Resolution: `fleetSandboxSettingsForRole(role)` keeps `role` as the per-role decision SEAT but the policy is **uniform** today — cred `denyRead` + Read/Edit deny rules + deny-all egress. Write-discipline per role stays at the allowed-tools layer (FLEET_NO_WRITE_ROLES already lose the Edit/Write tools); the residual Bash-escape (`echo > file`) is a documented, accepted limit. The achievable per-role axis is **egress** (`allowedDomains` — e.g. `expert`/`feedback` do web research and would need an allowlist while a worker needs none); the exact per-role domains are deferred to the real-spawn pass (P-012), where `role` will branch.
Related: P-004

### D-007 — Codex: workspace-write confines writes+egress but NOT reads; MCP interaction is the gating unknown
Date: 2026-06-01
Phase 2 shipped: codexSandboxArgs flag-gates `-s workspace-write` (contained) vs the prior `-s danger-full-access --dangerously-bypass-approvals-and-sandbox` (kept as the flag-OFF default, so behavior is unchanged until opt-in). Moved the sandbox flags out of streamFormatFlags into codexSandboxArgs, appended to extraFlags BEFORE the `-` stdin positional (codex wants options before the prompt). Defers to a user-set `-s`/`--sandbox`/bypass in AGENT_CMD. 72 unit tests.

Verified on this box (codex exec -s workspace-write, headless):
- cwd write OK; write to `$HOME` BLOCKED ("Read-only file system") — out-of-workspace writes confined (`/tmp` is a default writable_root, so it's allowed — tighten via writable_roots if needed);
- command network egress BLOCKED (curl → exit 6 / HTTP000);
- runs non-interactively, no hang.

GAP vs claude (P-006): codex `workspace-write` reads BROADLY — `ls ~/.ssh` listed the keys. codex has no `denyRead` equivalent, so credential-READ closure is NOT provided by the codex sandbox; it relies on the egress block (can't exfil) + the subprocess env-scrub. Documented per-backend difference, not a regression.

OPEN RISK → P-007/P-012: whether codex MCP tool calls work under `workspace-write`. The handoff note records `-s read-only` CANCELS codex MCP; `workspace-write` is less restrictive but unverified against the live operator MCP (the test needs a CODEX_HOME + signed-URL MCP server). If workspace-write also cancels MCP, codex can't be both sandboxed AND tool-enabled → it stays off and we keep danger-full-access. This is THE gating question for codex sandbox viability and must be settled on a real spawn before default-on.
Related: P-005, P-006, P-007

### D-008 — omp wrapped in srt; host deps (srt + ripgrep) installed; fail-loud when srt absent (deviates from no-op+warn)
Date: 2026-06-01
Phase 3 shipped: omp (no native sandbox) is wrapped in `srt` (@anthropic-ai/sandbox-runtime). New pure helpers in invoke.ts: buildOmpSrtSettings(cwd) (the common policy in srt's schema — note srt REQUIRES every key incl. deniedDomains/denyWrite and needs absolute literal paths on Linux, so `~/.ssh` is homedir-expanded), srtBinOnPath(), writeOmpSrtSettings(cwd) (per-spawn 0600 file), wrapOmpWithSrt() (command→`srt -s <file> <cmd> …`). Wired at the spawn() chokepoint, flag-gated. 76 unit tests.

Verified on this box: the code's actual buildOmpSrtSettings output is a valid srt config that engages — cred-dir read blocked ("No such file or directory"), cwd write allowed, egress blocked (HTTP000). srt uses the SAME bwrap+socat+proxy mechanism as claude/codex.

DEVIATION from P-008's "no-op + warn if srt absent": chose **fail-loud** instead — if the flag is set for an omp spawn but `srt` isn't on PATH, invoke() throws rather than silently running omp unsandboxed. Rationale: the operator opted in; silently bypassing a requested security control is worse than failing. This mirrors claude's failIfUnavailable:true. (It only affects opt-in users, who will install srt.)

HOST DEPS (P-011) installed on this dev box: `@anthropic-ai/sandbox-runtime` (srt) globally + `ripgrep` (srt requires rg). bwrap + socat were already present. These are documented deps for the sandbox on Linux.

OPEN (→ P-012, like codex MCP): whether omp itself FUNCTIONS under srt — omp runs a persistent Python + Bun worker over a loopback bridge, which may need paths/sockets the sandbox restricts. The wrapper is verified (srt sandboxes a command correctly); omp-under-srt working is the real-spawn gate.
Related: P-008, P-009, P-011

### D-009 — P-012: codex is NOT sandboxable — workspace-write cancels MCP tool calls
Date: 2026-06-01
Live verification (codex-su-home MCP config + the operator on :3070, vs codex on this box): under `-s workspace-write`, a codex MCP tool call (`harness:list`) returns **"user cancelled MCP tool call"** (client-side, never reaches the server). Under `--dangerously-bypass-approvals-and-sandbox` the SAME call REACHES the server (returns the `?superuser=1` auth artifact). So codex's sandbox cancels MCP — exactly as the handoff recorded for `read-only`, and now confirmed for `workspace-write` too. A sandboxed codex worker is therefore tool-less, which is fatal for the MCP-dependent fleet.

Resolution: `codexSandboxArgs` now ALWAYS returns `-s danger-full-access --dangerously-bypass-approvals-and-sandbox` regardless of PAPERCUSP_FLEET_SANDBOX — the flag deliberately does NOT switch codex to workspace-write (that would silently disable its tools). Phase 2's flag→workspace-write switch is reverted. codex is uncontained until OpenAI offers MCP-under-sandbox; revisit then. (Why claude can be sandboxed but codex can't: claude's sandbox covers only sub-commands and leaves the agent's own MCP connection intact; codex's sandbox gates the MCP transport itself.)
Related: P-005, P-007, P-012

### D-010 — P-012: omp srt-wrap removed — srt gates omp's own model/MCP; unverifiable here
Date: 2026-06-01
Two findings made Phase 3's omp srt-wrap non-viable as built: (1) DESIGN — `srt` wraps the WHOLE omp process, so its network filter gates omp's OWN model + MCP connections (unlike claude/codex, where the native sandbox wraps only sub-commands and the agent's connections stay outside it). My buildOmpSrtSettings used a deny-all egress (`allowedDomains: []`), which would block omp from reaching its model + the operator — breaking omp outright. (2) VERIFICATION — omp is mis-configured on this box (points at a local ollama that 400s: "failed to unmarshal tool parameters"), so a real omp-under-srt spawn couldn't be run at all.

Resolution: removed the srt auto-wrap + the omp helpers (buildOmpSrtSettings/srtBinOnPath/writeOmpSrtSettings/wrapOmpWithSrt) + their tests; omp runs UNSANDBOXED. The srt *mechanism* is verified (it correctly sandboxes a bash command — cred-hide, cwd-write, egress-block — proven earlier), so the path forward is known: a per-omp egress ALLOWLIST (omp's model endpoint + the operator) instead of deny-all, plus a real-spawn verification once omp runs on the box. Reintroduce the helpers then. Tracked, deferred.
Related: P-008, P-009, P-012
