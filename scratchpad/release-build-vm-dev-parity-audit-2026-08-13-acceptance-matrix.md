# Release-build versus development acceptance matrix

Status: frozen for P-002 on 2026-08-13  
Plan: `release-build-vm-dev-parity-audit-2026-08-13`  
Applies to: public 0.0.16, canonical `npm run dev`, and the final 0.0.17-alpha tuple  
Authority: D-001 through D-009

This is the single observable matrix for all three passes. A later pass may add
evidence, but it may not weaken, rename, or silently skip a check. A static file,
manifest, grep, or source review may explain a runtime observation; it never
substitutes for installed execution.

## Run set

Create one evidence bundle for every row below and for every artifact in the
corresponding frozen P-001 manifest.

| Run key | Subject | Required environment |
|---|---|---|
| `r016-linux-*` | Every public 0.0.16 Linux installer/bundle | Pristine overlay from the frozen Linux golden image |
| `r016-windows-*` | Every public 0.0.16 Windows installer/bundle | Pristine overlay from the frozen Windows audit image |
| `r016-macos-*` | Every public 0.0.16 macOS installer/bundle | Clean immutable Mac reset point accepted by P-001 |
| `dev-canonical` | The frozen source/submodule tuple under canonical `npm run dev` | Detached clean source plus the isolated environment in D-008 |
| `r017-linux-*` | Every final 0.0.17-alpha Linux artifact | A newly reset Linux overlay |
| `r017-windows-*` | Every final 0.0.17-alpha Windows artifact | A newly reset Windows overlay |
| `r017-macos-*` | Every final 0.0.17-alpha macOS artifact | A newly reset Mac guest |

An artifact is not covered by testing a sibling format or role. For example,
Windows MSI evidence does not cover NSIS, and GUI evidence does not cover Server.

## Evidence bundle contract

Every run records these fields before any verdict:

- run key, UTC start/end, operator, host, guest OS/build, boot ID, snapshot/reset
  identifier, and snapshot hash or immutable provenance;
- artifact public URL, filename, SHA-256, bytes, role, installer format, signature
  result, release tag/channel, and registry provenance; or, for development,
  source commit, `libs/papercusp` commit, desktop commit, dirty-tree status, exact
  command expansion, and environment allow-list;
- install, launch, relaunch, update/reinstall, uninstall, and cleanup commands with
  exit status and bounded stdout/stderr paths;
- process tree, listeners, `operator.json`, `embedded-pg.json`, `/api/health`,
  installed version/build identity, database system identifier, and relevant
  filesystem tree before and after each lifecycle transition;
- route/action ledger, API/tool census, screenshots or accessibility evidence,
  bounded application/sidecar/system logs, outbound-network capture, and all
  deviations from this matrix;
- one result per check ID: `pass`, `fail`, `blocked`, or `not-applicable`, plus the
  concrete evidence reference. `not-applicable` requires a product/writer reason;
  environment limitations are `blocked`, never `pass` or `not-applicable`.

Secrets, credentials, raw database dumps, and unbounded logs never enter a bundle.

## Global preconditions

| ID | Observable check | Pass condition | Existing mechanism |
|---|---|---|---|
| G-001 | Input identity | URL/hash/bytes/role/format match the frozen P-001 manifest; development commits match the frozen tuple; working trees are clean | Release registry, `sha256sum`, Git object/submodule reads |
| G-002 | Guest reset | Boot ID and reset provenance prove a new guest state; no prior Papercusp process, install, home, DB, listener, or test data exists | VM overlay/reset workflow and platform-native inventory |
| G-003 | Bundle privacy audit | The exact artifact passes the canonical bundle auditor; no PostHog key/config or forbidden host material is present | `papercusp-desktop/bin/audit-bundle.sh` |
| G-004 | Signature and package identity | Platform signature verifies; package/app identity, version, role, target architecture, and update channel agree with provenance | Platform signature tools plus `verify-provenance*.sh` |
| G-005 | Disk and runtime headroom | Guest has sufficient disk, memory, file descriptors, and install/runtime headroom before mutation | `vm-preflight`, disk preflight, platform inventory |
| G-006 | Isolation boundary | No live host/user data, credentials, sockets, operator discovery, or databases are inputs to the run | Clean guest; for dev, the D-008 private roots and unset DSNs |
| G-007 | Canonical dev topology | `dev-canonical` uses the repository's unmodified `npm run dev` expansion; preflight proves `:3270`/`:3274` free, no caller port/API override, and no bg-host reservation of `:3270`; post-launch evidence proves the isolated checkout's spawned operator/PTY own those targets. It does not stop or reuse Avi's desktop, silently walk ports, or fall back to another operator | Launcher/config writer read, systemd reservation read, command/process/listener capture; D-008 |

Any failed global precondition stops that run before product conclusions are drawn.

## Installation and lifecycle

| ID | Observable check | Pass condition |
|---|---|---|
| L-001 | Fresh install | Installer exits successfully and creates only the expected platform package/app tree, launch entries, role resources, and permissions |
| L-002 | First launch | The shipped launcher starts the correct role; bootstrap transitions to the operator UI; no dev-server URL or host checkout is used |
| L-003 | Packaged process topology | GUI/app, sidecar/operator, embedded Postgres, and role-specific children match the expected writer-owned topology; no duplicate operator or clustered worker fan-out appears |
| L-004 | Health and provenance | The operator becomes healthy within the recorded budget and reports the installed artifact's version/build SHA/role on the discovered sticky port |
| L-005 | Embedded database | A private non-5432 embedded PG is created below the run's home, migrations complete, and discovery files point only to that instance |
| L-006 | Graceful quit and relaunch | Quit drains owned children; relaunch succeeds without a crash loop, reuses the same physical DB, retains intended data, and does not re-provision |
| L-007 | Repeated relaunch | Three relaunches stay healthy, add no new panic/crash signature, and do not leak duplicate children or listeners |
| L-008 | In-place update/reinstall | Installing the comparison artifact while the old operator runs, then relaunching without pre-killing it, flips build SHA/version and holds the sticky port | 
| L-009 | Rollback/revert | Where the updater exposes Revert, the clean-room flow restores the prior signed artifact and its matching provenance without host-state input |
| L-010 | Uninstall | Platform uninstall succeeds; installed binaries, launch entries, services, and role-owned caches are removed; deliberately retained user data is itemized and documented |
| L-011 | Reinstall after uninstall | Reinstall starts cleanly, respects the documented retained-data policy, and does not adopt stale foreign processes or discovery records |
| L-012 | Role/package exclusion | GUI and Server conflict/replace behavior matches the package writer; an opposite-role install cannot silently create an unsupported mixed tree |
| L-013 | Crash recovery | Forced app/sidecar interruption is observed, recovery follows the shipped supervisor policy, health returns, and the bounded log contains a diagnosable cause rather than silent loss |

Use `papercusp-desktop/bin/install-and-relaunch-verify.sh` for L-008. Its
load-bearing behavior is to relaunch without terminating the stale operator, then
assert the SHA/version flip and sticky-port hold. Killing the operator first is a
different cold-start test and does not satisfy L-008.

## UI navigation and user actions

| ID | Observable check | Pass condition |
|---|---|---|
| U-001 | Shell render | A real installed window/webview reaches the shipped UI, title/role/version are correct, and there is no permanent bootstrap, blank, or error shell |
| U-002 | Navigation inventory | Every user-reachable route from the frozen route inventory is opened through normal navigation and by direct URL where supported; redirects, 404s, and feature gates match the frozen defaults |
| U-003 | Action inventory | Every visible enabled control on each covered route has an action record: route, label, interaction, expected side effect, actual result, persistence expectation, and evidence |
| U-004 | Creation/edit/delete flows | Representative user-owned objects are created, read, edited, and deleted through the UI; changes appear in the API/store and survive only where intended |
| U-005 | Forms and validation | Required, invalid, boundary, cancel, submit, retry, and duplicate-submit paths yield an explicit, recoverable outcome and never silently lose or duplicate data |
| U-006 | Long-running actions | Progress, cancellation, completion, failure, and retry remain visible across navigation and relaunch |
| U-007 | External/privileged actions | Publish, send, credential, filesystem, terminal, and other outward/privileged controls enforce the same confirmation, flag, permission, and audit boundary as their writers |
| U-008 | Keyboard/accessibility | Focus order, keyboard activation, labels/roles, modal escape, and error announcement support the same functional flows as pointer input |
| U-009 | Empty/loading/error states | Each major surface demonstrates honest empty, loading, recoverable error, and restored-success states rather than a blank or stale success view |
| U-010 | Reload/deep link | Reload and supported deep links preserve or reconstruct the intended route/state without falling back to a dev host or losing the operator connection |

U-002 and U-003 use the P-001 route/action inventory as the enumerated checklist;
a few hand-picked pages cannot satisfy them. Runtime interaction is required.

## Operator, API, and tool surface

| ID | Observable check | Pass condition |
|---|---|---|
| A-001 | Surface census | The runtime METHOD/path census and tool catalog are captured and compared to the frozen expected sets; every addition, omission, or schema difference is classified |
| A-002 | Health/docs/root | `/api/health`, internal docs, root shell, and desktop endpoints respond with the expected status/content type and report the run's own provenance |
| A-003 | Safe reads | Every safe/read-only runtime endpoint family and tool family has at least one successful semantic probe using isolated data and no host fallback |
| A-004 | Isolated writes | Every user-facing write family has a create/read/update/delete or equivalent round-trip, verified through both the public surface and its durable store/projection |
| A-005 | Error contracts | Invalid input, missing object, conflict, authorization/flag denial, and internal failure return the documented status/envelope without crashing the operator |
| A-006 | Streaming and realtime | SSE/WebSocket/IPC streams connect, deliver a typed event, reconnect or close cleanly, and do not cross the run's identity/data boundary |
| A-007 | Feature gates | Runtime flags equal `FLAG_DEFAULTS` with `source: defaults`; retired keys are absent; closed routes return real 404/denial; no PostHog evaluation occurs |
| A-008 | Debug-only surface | Release builds do not expose debug-only MCP/dev bridges or filesystem/code-loading paths; the development-only difference is recorded and writer-backed |
| A-009 | Tool transport | Catalogued tools resolve, validate declared inputs, return the expected envelope, and preserve audit attribution; representative read/write/error/streaming cases are exercised |
| A-010 | No native-host fallback | Packaged execution never reaches the host checkout, native `:5432`, host operator, or copied discovery state when its embedded component is absent or failing |

The frozen census currently records counts and hashes in P-001. Equality of a
catalog proves exposure parity only; it does not replace A-003 through A-009.

## Data, filesystem, networking, and permissions

| ID | Observable check | Pass condition |
|---|---|---|
| D-001 | Persistent data | A synthetic working-set/object round-trip reaches its durable store/projection, survives relaunch, and disappears after the supported clear/delete action |
| D-002 | Physical DB identity | Database system identifier stays stable across ordinary relaunch/update and changes only after an intentional clean reset |
| D-003 | Filesystem ownership | Every created file is below documented app/user roots with expected owner/mode; no repository, host home, temp secret, or unrelated user path is written |
| D-004 | Multi-user isolation | A fresh OS user has no discovery/config leakage from the build/test account and receives a private first-run state |
| D-005 | Loopback listeners | Operator, gateway, and IPC/WebSocket listeners bind only to documented loopback/socket addresses unless a user explicitly enables a remote surface |
| D-006 | Outbound traffic | A bounded network capture accounts for every DNS/TCP request; clean install performs no PostHog/flag call or unexplained egress |
| D-007 | Federation boundary | The maintained two-instance/federation smoke proves identity, create/read convergence, and teardown without reusing live workspace data |
| D-008 | Permissions | Filesystem, shell, dialog, notification, shortcut, autostart, updater, and custom-protocol permissions match the Tauri capability writer and fail closed outside their scope |
| D-009 | Secrets | Credentials are accepted only through supported injected/keychain/config mechanisms, are redacted from UI/log/process args, and are not bundled or persisted outside policy |
| D-010 | Cleanup isolation | Run cleanup removes only the run's processes, overlay, private roots, and fixtures; it never signals host/user or peer processes |

## Updater and release channel

| ID | Observable check | Pass condition |
|---|---|---|
| R-001 | Feed identity | Update endpoint selects the run's channel and role, returns the intended semver/artifact URL/bytes, and carries the inline minisign signature content |
| R-002 | Update discovery | An older installed build discovers the newer eligible build; current/newer builds do not offer a downgrade unless Revert is explicitly invoked |
| R-003 | Download/verification | Download completes or uses the maintained large-artifact fallback, verifies hash/signature before mutation, and reports actionable failure without damaging the current install |
| R-004 | Platform swap | The platform-specific updater replaces the app through the maintained swap path and yields the same L-008 provenance flip/sticky-port result |
| R-005 | Interrupted update | Network interruption, invalid signature, insufficient disk, and installer failure preserve a launchable prior version and bounded diagnostics |
| R-006 | Revert safety | Revert is offered only when a valid prior artifact exists, verifies it, restores it, and never uses a copied host home or live-host PID marker |

Linux updater/revert execution must use the clean-room VM `vmctl updater-e2e`
route documented in `desktop-auto-update-operations`; a copied host home under
Xvfb is forbidden.

## Logs, recovery, stability, and resource behavior

| ID | Observable check | Pass condition |
|---|---|---|
| O-001 | Log locations | App, sidecar, gateway, updater, installer, and system logs exist in documented locations and identify run/build/role without leaking secrets |
| O-002 | Clean steady state | Bounded scans after first launch and after the functional matrix show no unclassified panic, fatal error, crash report, respawn storm, or migration loop |
| O-003 | Failure diagnostics | Each deliberately induced recoverable failure produces a user-visible state and a correlated bounded log entry with enough detail to diagnose it |
| O-004 | Resource baseline | Process count, RSS, CPU, file descriptors, listeners, and disk are recorded after ready, after the matrix, and after relaunch; unexplained monotonic growth is a failure |
| O-005 | Extended stability | A platform-appropriate dwell with periodic health and a functional read/write probe shows no leak, crash loop, lost listener, or database corruption |
| O-006 | Teardown | After quit/uninstall, no owned child, listener, lock, mount, installer, updater, or guest-side test process remains |

## Platform-specific required evidence

### Linux

- Exercise every frozen Linux artifact/role; package-manager install/remove and
  standalone AppImage paths are separate when both ship.
- Launch the GUI via the installed `papercusp-desktop` binary/menu entry, not the
  `papercusp` setup/tutorial dispatcher.
- Read the dynamic packaged port from `~/.papercusp/operator.json`; prove embedded
  PG is not native `:5432`.
- Use the pristine Linux overlay and maintained `vmctl` updater/revert workflow.
- Record desktop/session integration, autostart/menu entries, executable modes,
  mount behavior, and uninstall residue.

### Windows

- Exercise each frozen MSI and NSIS artifact separately and record installer exit,
  ProductVersion, installed tree, launch entry, uninstall mechanism, and residue.
- Use `vm-preflight.sh`: host VM process, Windows SSH/app process, then the
  authoritative `/api/health` probe from inside WSL. A broken outer Windows→WSL
  forward with a healthy inner operator is `forward-degraded`, not operator death.
- Exercise the packaged Windows/WSL respawn path and `vm-smoke-windows.sh`; prove
  the app never adopts an unrelated distro/operator.
- Record firewall prompts/rules, `%LOCALAPPDATA%`/profile state, service/task
  entries, filename-with-spaces handling, and both installer uninstall paths.

### macOS

- Exercise every frozen DMG/role: attach, inspect volume/app tree, copy to
  `/Applications`, verify signature/quarantine behavior, launch, detach, remove,
  and reinstall.
- Reuse the maintained `mac-vm-fresh-install-e2e.sh`, lifecycle, relaunch, log-scan,
  inspect-running, working-set, seed-runtime, and gateway probes as applicable.
- Record app bundle resources/capabilities, embedded PG identity, launch behavior,
  permissions prompts, logs/crashes, mount cleanup, and uninstall residue.
- The current QEMU Mac has no GPU and WKWebView pixels may be blank even when the
  operator is healthy. HTTP/process/accessibility evidence may cover functional
  checks, but a blank screenshot cannot pass U-001 visual render. Record U-001 as
  `blocked` until a GPU-capable or real-Mac witness demonstrates rendered pixels;
  final “complete platform coverage” cannot silently waive this gap.

## Development-only capture

In addition to the same functional rows, `dev-canonical` records:

- the exact `npm run dev` expansion, parent/child process tree, Vite/Tauri/operator
  listeners, file watchers, debug MCP bridge, source maps/devtools, and shutdown;
- the pre-launch absence of listeners on `:3270`/`:3274`, absence of
  `OPERATOR_DEV_PORT`, `OPERATOR_DEV_PTY_PORT`, and `PAPERCUSP_DEV_API_TARGET`
  redirects, the enabled bg-host unit's parsed reserved port, and post-launch
  proof that the isolated source owns the webview/API/PTY targets rather than
  reusing or falling back to a pre-existing operator;
- `HOME`, `PAPERCUSP_HOME`, workspace/XDG roots, DSN absence, discovery-disabled
  setting, private PGDATA, and proof that no live user/host data was read;
- generated route tree identity, runtime METHOD/path census, tool catalog, feature
  defaults, Tauri capabilities, bundled-resource differences, and every dev-only
  surface's writer;
- the same route/action/data/lifecycle checks using fresh isolated fixtures. A
  dev-only convenience is not an excuse for a release omission unless its writer
  and product rationale are recorded.

## Difference ledger

For every observation that differs between development and an installed artifact,
record one row with:

| Field | Required value |
|---|---|
| Check/run refs | Matrix ID plus both evidence bundle references |
| Observed difference | Concrete runtime behavior, not an inferred source delta |
| Writer | File/function/build step that creates the behavior |
| Class | `intended-release-only`, `intended-dev-only`, `missing-in-release`, `release-only-exposure-security`, or `platform-packaging` |
| Rationale | Product/security/platform reason, or “none found” |
| Disposition | Accepted decision, or owned defect with root cause, recurrence guard, rebuild, and exact rerun |

An unclassified difference is a failing check. An intended difference without a
writer and rationale is unclassified.

## Verdict rules

- `pass` requires current-run runtime evidence tied to the exact artifact/source
  tuple and reset point.
- `blocked` remains open; it is never averaged into green coverage.
- `not-applicable` is valid only when the product has no such surface on that
  artifact/role and the responsible writer proves that absence is intentional.
- A confirmed defect remains red until the root cause or a filed-and-owned item,
  recurrence detector, rebuilt artifact, and exact installed-flow rerun all exist.
- 0.0.17 repeats this matrix unchanged. A 0.0.16 pass is baseline evidence, not a
  proxy for the final artifact.
- Final closure requires every run/artifact row, every matrix ID, and every
  difference row to have an owner-readable evidence reference and terminal
  disposition, with no open confirmed release-only defect.

## Maintained mechanisms to reuse

- `papercusp-desktop/bin/audit-bundle.sh`
- `papercusp-desktop/bin/verify-provenance.sh`
- `papercusp-desktop/bin/verify-provenance-parity.sh`
- `papercusp-desktop/bin/vm-preflight.sh`
- `papercusp-desktop/bin/install-and-relaunch-verify.sh`
- `papercusp-desktop/bin/vm-smoke-windows.sh`
- `papercusp-desktop/bin/verify-operator-respawn-vm.sh`
- `papercusp-desktop/bin/mac-vm-fresh-install-e2e.sh`
- `papercusp-desktop/bin/mac-vm-lifecycle-gw-e2e.sh`
- `papercusp-desktop/bin/mac-vm-relaunch-verify.sh`
- `papercusp-desktop/bin/mac-vm-log-scan.sh`
- `papercusp-desktop/bin/mac-vm-inspect-running.sh`
- `papercusp-desktop/bin/mac-vm-working-set-roundtrip.sh`
- `papercusp-desktop/bin/mac-vm-seed-runtime-test.sh`
- `papercusp-desktop/bin/two-instance-*-smoke.sh`
- `papercusp-desktop/scripts/linux-test-vm/vmctl updater-e2e`

These mechanisms supply evidence for the matrix. They are not a second matrix,
and a script's exit code covers only the assertions that its writer implements.
