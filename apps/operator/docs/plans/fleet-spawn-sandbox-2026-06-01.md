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

**State:** Design ready, not yet built. Follow-up from
`claude-code-backend-restore-2026-05-30` (D-003-B). The fleet's permission
posture — per-role `--allowed-tools` whitelist + `--disallowed-tools` deny +
spawn-scoped pre-push hook — is shipped, but it leaves two honest gaps it
*cannot* close: (1) **credential reads** — the allow-listed `Read` tool (and
`cat` under the granted `Bash`) reach any path incl. `~/.ssh`, `~/.aws`,
`~/.papercusp` secrets; (2) **network egress** — the allow-listed `WebFetch`
(and `curl`) can exfiltrate anything the agent holds. Closing those needs an
OS-level filesystem+network sandbox, not an allow/deny-list.

Research (2026-06-01, web + local binary inspection) found we should **not
roll our own** sandbox: each backend ships (or can borrow) a native one, all
built on the **same OS primitives** (bubblewrap+seccomp on Linux, Seatbelt on
macOS, + a localhost proxy for domain egress). See D-001.

**Next:** human go-ahead to build Phase 1 (claude-code). All phases ship the
sandbox **off-by-default behind a flag** (`PAPERCUSP_FLEET_SANDBOX`); flipping
default-on is gated on a real fleet-spawn per-role verification pass (the `#1`
gold-standard gate), because every one of these sandboxes breaks *some* tools
(jest+watchman, Go CLIs' TLS under Seatbelt, docker, nested-container /proc).

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

- **P-001** `todo` Inject a `sandbox` block into the per-spawn claude settings (or `--settings`): `enabled:true`, `failIfUnavailable:true`, `allowUnsandboxedCommands:false` (strict), `filesystem.allowWrite:["."]`, `filesystem.denyRead:[creds]`, `network.allowedDomains:["api.anthropic.com"]` + `allowManagedDomainsOnly:true`. Gated behind `PAPERCUSP_FLEET_SANDBOX`.
- **P-002** `todo` Pair the sandbox with `Read`/`Edit` deny rules for the credential paths — the sandbox only covers Bash + children, NOT the Read/Edit/Write tools (Anthropic docs: default read policy "still allows reading credential files such as ~/.aws/credentials and ~/.ssh/"). Without this, cred-reads via the `Read` tool stay open. blocked-by: P-001
- **P-003** `todo` Set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` on the spawn env to strip Anthropic/cloud creds from sandboxed subprocesses.
- **P-004** `todo` Isolation verification: a `claude -p` spawn under the sandbox can write its cwd, cannot read a sentinel `~/.ssh` secret (via Bash AND via Read), and cannot reach a non-allowlisted domain; a representative role task still completes. blocked-by: P-001, P-002

## Phase 2 — codex native sandbox

- **P-005** `todo` Orchestrator codex spawn uses `--sandbox workspace-write --ask-for-approval never` (config.toml `sandbox_mode`/`approval_policy`), with `sandbox_workspace_write.writable_roots` = the cwd. workspace-write already blocks command network by default (stricter than claude). Gated behind the same flag.
- **P-006** `todo` Decide codex command-network policy: workspace-write denies it by default; if a role needs the operator API from a command, widen writable_roots/network — but note the macOS `network_access` Seatbelt bug (codex#10390), so don't rely on codex command-network on Mac. blocked-by: P-005
- **P-007** `todo` Isolation verification mirroring P-004 for codex (cwd write ok; cred read denied; egress denied; role task completes). blocked-by: P-005

## Phase 3 — omp via srt wrapper

- **P-008** `todo` Add `@anthropic-ai/sandbox-runtime` (`srt`) as the omp containment wrapper: prefix the omp spawn with `srt` carrying an `~/.srt-settings.json` of the common policy (`filesystem.denyRead`/`allowWrite`, `network.allowedDomains`). srt wraps an arbitrary process, cross-platform (same bwrap/Seatbelt+proxy). Gated behind the flag; no-op + warn if `srt`/bwrap absent.
- **P-009** `todo` Isolation verification for the omp+srt path (cwd write ok; cred read denied; egress denied; omp role task completes). blocked-by: P-008

## Phase 4 — host setup, flag, and default-on gate

- **P-010** `todo` Shared policy module: one source of truth for the credential-deny list + egress allowlist, mapped onto each backend's config shape (claude settings / codex toml / srt json). Avoids drift across the three.
- **P-011** `todo` Host dependency check + docs: `bubblewrap` + `socat` + seccomp helper present; Ubuntu 24.04+ `bwrap` AppArmor profile; `enableWeakerNestedSandbox` when the spawn runs inside a container; fallback-safe + Linux/macOS only (no native Windows).
- **P-012** `todo` Per-role real-spawn verification pass (the `#1` gold-standard gate): run each pipeline role under the sandbox against a real harness; catalogue tool breakage (watchman, Go-CLI TLS, docker, etc.) and add per-tool `excludedCommands`/`allowWrite` exceptions. Only after this passes do we flip default-on. blocked-by: P-004, P-007, P-009
- **P-013** `todo` Flip `PAPERCUSP_FLEET_SANDBOX` default-on once P-012 is green; keep `failIfUnavailable` opt-in for managed/CI deployments. blocked-by: P-012

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
