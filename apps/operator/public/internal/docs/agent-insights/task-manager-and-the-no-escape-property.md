# The task manager — what is running, who asked for it, and why nothing escapes
URL: /internal/docs/agent-insights/task-manager-and-the-no-escape-property

How the cgroup-confined task ledger classifies nested managed scopes, preserves fail-open enrollment, redacts public diagnostics, and proves release readiness.

# The task manager, and the no-escape property

**TL;DR** — `processes:list` tells you who launched a process, for which work item, under what budget, and what it costs. `ps` cannot answer those questions. End a managed task with `processes:kill { taskId }`, never with a process-name pattern.

## The one idea

Cgroup membership is inherited by every descendant, and an unprivileged process cannot leave its cgroup. Operator-owned roots launch in a transient `pc-<taskId>.scope` under `papercusp.slice`; descendants remain in that subtree even when a build tool creates a nested scope such as `pc-<taskId>.scope/papercusp-deb-build-*.scope`.

The reconciler therefore resolves the **nearest valid `pc-*` ancestor**, scanning from the leaf toward the slice root. Looking only at the leaf falsely reports nested build descendants as unaccounted.

A managed scope name carries the ledger key, but it proves only managed launch provenance. It does **not** prove a ledger row was ever committed: synchronous enrollment chooses the task id and launches the scope before its fire-and-forget database write settles.

## What you actually use

| You want                                      | Call                                                |
| --------------------------------------------- | --------------------------------------------------- |
| What is running and why                       | `processes:list`                                    |
| Cross-check the ledger against the kernel now | `processes:list { live: true }`                     |
| What a work item cost                         | `processes:list { workItemId, includeEnded: true }` |
| End one task and its whole subtree            | `processes:kill { taskId }`                         |
| Relieve pressure without losing work          | `processes:freeze { taskId }` and `resume: true`    |
| Cap a runaway without killing it              | `processes:limit { taskId, memoryMaxMb }`           |
| Human surface                                 | `/admin/tasks`                                      |

## Reading process provenance

The public process view uses four evidence-based buckets:

* **managed** — a live ledger row owns the process.
* **unaccounted** — the process is in a managed `pc-*` scope but no live ledger row currently owns it.
* **abandoned window** — a task-shaped process is outside any managed task scope and is old enough to merit investigation.
* **exempt** — visible host activity that is not owned by the task manager.

Do not rewrite these as lifecycle claims. In particular, `unaccounted` does not mean the row definitely existed and outlived the scope. It can also mean the enrollment write failed after scope launch. The alarm remains report-only; it never auto-kills.

A process started by hand may appear as foreign or exempt. For a general host process list, use `ps` or `pgrep`; for the tracked agent kinds, use `dev:processes`.

## Ledger states

`pending` means registered but not yet spawned. `running` means alive and accounted for. `exited`, `killed`, and `timed_out` are observed terminal states.

`stranded` is intentionally distinct: the ledger said running but the kernel disagreed, and no trustworthy exit code was observed. The system must not manufacture a clean completion from absence.

## Adding a spawn

A `detached: true` spawn creates a process intended to outlive its caller, so `lint:no-unenrolled-spawn` requires one of the maintained chokepoints:

* async seam: `managedSpawn`;
* sync seam: `beginSyncEnrolment` plus `completeSyncEnrolment` and `finishSyncEnrolment`.

Sync enrollment remains fail-open because task tracking must never prevent the requested command from running. A failed asynchronous ledger write is nevertheless logged once with bounded task/error context; swallowing it would make the resulting unaccounted scope impossible to diagnose.

A genuinely external lifetime must be added to the static guard allowlist with a reason. Silent unenrollment is not an option.

## Public diagnostic safety

Task-manager payloads can contain `/proc` command lines and upstream error text. Those strings may carry API keys, bearer tokens, or secret-directed flags. The inventory projection applies the shared `redactSensitiveText` contract **before** display caps to process command lines, task titles, exit reasons, log paths, reconcile errors, and schedule errors. Truncating first can preserve a secret while deleting the context that identified it.

UI components must render only the safe inventory projection; they must not read or reconstruct raw process diagnostics.

## Why the reconciler sometimes declines to act

`reconcileTick` refuses absence-based transitions when the owned scan is untrustworthy, including a missing cgroup root or owned-pass truncation. A bad scan is indistinguishable from an idle box and could otherwise strand every task at once. Positive confirmations are still recorded because presence remains trustworthy.

Foreign-pass truncation does not degrade the ledger verdict. Display-only host activity must never disable the correctness path.

## Recurrence guards

The release contract is pinned by tests for:

* nearest managed ancestor resolution and nested descendant matching;
* managed-scope residue wording without invented row history;
* fail-open enrollment plus an observable write-failure diagnostic;
* all four public provenance buckets and accessible labels;
* credential redaction in process and schedule payloads before rendering;
* the static unenrolled-spawn guard.

Run the task-manager Vitest suites, exact TypeScript ratchets for touched packages, `npm run lint:no-unenrolled-spawn`, and the operator production build before release. Browser verification must cover `/admin/tasks` plus the advanced Tasks roster.

## Where it lives

* Ledger: `harness_shared.task_ledger`
* Core: `packages/operator-core/lib/task-manager/`
* Shared redaction: `packages/operator-core/lib/sensitive-text.ts`
* Public projections: `inventory.ts`, `TasksClient.tsx`, and `TasksRosterPanel.tsx`
* Cadence: `system:task-reconcile`, tier `ephemeral`, every 30 seconds
* Guard: `npm run lint:no-unenrolled-spawn`
* Original implementation plan: `task-manager-no-escape-2026-07-27`
* Public-release audit: `task-manager-public-release-readiness-2026-08-11`
