# Common questions source review

P-004 / WI-10006918, `cloud-portal-docs-and-papercup-faq-2026-10-06`.
Canonical source: `apps/papercusp-docs/src/content/docs/faq.mdx`.
Review date: 2026-10-06. This records the author's source checks and the fresh
independent review below. Approval of the revised FAQ remains pending.
The FAQ is not accepted or shipped.

## Demand and scope

The twenty seed questions are **proposed demand**, selected from the plan's
beginner journeys and the existing manual. No permission-appropriate real-user,
support, tenant or analytics question corpus was inspected. Their number and
alternate phrasings are design choices, not measured frequency or user findings.

The FAQ answers conceptual questions and supplies safe next actions. It does
not establish an account's current permissions, prices, subscription status,
hosting availability, connection state or retention policy. Those require
authorized current evidence. No fixed price, unlimited allowance, universal
cloud availability or comprehensive backup is promised.

## Question coverage and retained limits

Anchors are pinned in the existing publication contract using Astro's heading
slugger. Each question has two distinct alternate phrasings and at least one
existing fuller public guide. The following source checks support the claims;
they do not substitute for a responsible independent review or live walkthrough.

| Stable anchor | Source checked | Answer and retained caveat |
| --- | --- | --- |
| `what-is-papercusp` | `quickstart.mdx`, `using-the-app.mdx` | Start with a bounded task and inspect its result; a completion label is not publication evidence. |
| `what-is-papercup` | `using-the-app.mdx`, portal `apps/host/src/papercup-chat.ts` baseline | Assistant explanations and action depend on the session's tools and access; specify workspace/project. |
| `what-is-a-workspace` | `workspaces-and-agents.mdx` | Workspace environment and selected project differ; changing selection does not move a project. |
| `do-i-need-the-desktop-app` | `using-the-app.mdx`, portal workspace setup | Browser account options and connected local execution differ; installation flows are conditional. |
| `does-closing-the-browser-stop-my-agents` | `using-the-app.mdx`, `agent-modes-and-fleets.mdx` | Closing a tab is not an acknowledged stop command; local work depends on its computer. |
| `which-cloud-option-should-i-choose` | Portal `packages/ui/src/workspaces.tsx`; `hosted-provider-delegation.ts` | Current labels distinguish managed cloud and provider-owned hosting; described options may be unavailable. |
| `is-my-workspace-ready-when-its-card-appears` | `cloud-workspaces.mdx`, `troubleshooting.mdx` | Card creation does not prove a connected host; inspect the actual attempt instead of duplicating it. |
| `do-i-create-an-account-every-time` | Portal `packages/ui/src/auth.tsx`; `auth/hosted/self-signup.ts` | Reuse the identity's sign-in flow; app integrations are separate from account creation. |
| `why-can-i-not-see-my-organizations-workspace` | `accounts-and-billing.mdx`, `auth/hosted/self-signup.ts` | Identity authentication does not authorize all organizations; check account/organization and administrator role. |
| `what-can-i-be-charged-for` | `billing/entitlement-seam.ts`, `cloud-workspaces.mdx` | Subscription, model use and provider resources need separate checks; null allowances never mean unlimited. |
| `does-returning-from-checkout-mean-payment-is-confirmed` | `billing/entitlement-seam.ts`, portal `packages/ui/src/billing.tsx` | Pending subscription facts and confirmed entitlement differ; avoid duplicate checkout. |
| `does-stopping-a-workspace-make-it-free` | `cloud-workspaces.mdx` | Stop and delete differ; disks, snapshots and networking may retain charges. Provider-specific actual charges remain unknown. |
| `what-should-i-check-before-deleting-a-workspace` | `cloud-workspaces.mdx`, `backup/snapshot_create.ts`, `backup/restore.ts` | Identify deletion scope and a completed applicable backup/restore route; no subscription-cancellation or total-resource-removal guarantee. |
| `who-can-access-my-data` | `remote-access.mdx`, `access/create.ts` | Review the running machine, organization and configured scopes; no universal storage/retention or present-permission promise. |
| `where-should-i-enter-credentials` | `remote-access.mdx`, `access/create.ts` | Supported secure setup and scoped access; no secrets in reports, public repos or support/chat. No owner-key escalation to bypass a refusal. |
| `what-does-auto-let-an-agent-do` | `agent-tools/mode/set.ts`, `agent-modes-and-fleets.mdx` | Approved scope and permission boundaries persist; stop/pause must be explicitly acknowledged. |
| `how-do-i-know-a-task-is-finished` | `plans-and-work.mdx`, `quickstart.mdx` | Inspect acceptance and reported evidence; implementation, verification and publication are separate claims. |
| `what-if-an-agent-makes-a-mistake-or-gets-stuck` | `troubleshooting.mdx`, `plans-and-work.mdx` | Confirm interruption, identify work/blocker and inspect affected state; destructive restore is not generic error recovery. |
| `is-my-conversation-a-backup` | `harness-snapshots.mdx`, `backup/snapshot_create.ts`, `backup/restore.ts` | Conversation, source history and backups differ. Reconcile completed receipts and test a separate restore destination where supported. Restore mode matters; in-place restoration can overwrite newer state. |
| `how-do-i-get-help-safely` | `troubleshooting.mdx`, `remote-access.mdx` | Use the installation's actual help destination and redacted error/time/reference; no invented Support button or retry loop. |

Guide files above are under `apps/papercusp-docs/src/content/docs`. Core source
paths are under `packages/operator-core/lib`; portal paths are relative to the
separate checkout recorded in `baseline.md`.

## Sensitive review responsibilities

Billing and checkout require a hosted-billing reviewer; cloud costs/lifecycle
require a workspace-host reviewer; privacy/credentials require an auth/access
reviewer; backup/deletion recovery requires a backup reviewer. P-007 owns the
durable review assignments and drift relationship. The fresh independent review
below checks these sources but does not establish ongoing maintainer ownership.
P-004 remains open until approval is recorded against the exact FAQ revision.
Automated structure checks cannot
prove billing, privacy or recovery truth.

## Verification so far

The maintained focused runner passed 44 tests across the FAQ publication
contract (7), public source readiness (35), and dated inventory consistency (2),
with no skips. Evidence: `/tmp/cloud-docs-faq-tests.log`, local source at runner
head `ff223fd86f`; two named test files were uncommitted. Scoped declaration
generation emitted only `source-contract.d.mts`. This establishes local source
behavior, not a full-suite verdict or a deployed artifact.

The FAQ tests reject removed questions, broken bookmarks, duplicate anchors,
missing/duplicate aliases, link-only answers, private/self/escaping/nonexistent
guide links and nonexistent guide fragments. Existing source guards enforce
concrete code anchors and sidebar reachability. The historical inventory test
now compares its totals within its dated receipt while current source readiness
continues to require the actual current guide population.

The fresh maintained Astro reader suite passed 10 tests without skips on
2026-10-06 (`testRunId: 20862474`, group
`a0aa39d9-633a-4b93-b0af-9c364d1bdd8b`). Its FAQ case checked rendered heading
anchors and fuller-guide destinations. A fresh seven-test FAQ structure run
also passed without skips (`testRunId: 20864456`, group
`83dbaeb8-49dd-49ae-8c2b-9c7cd9d25505`), with ledger-backed unit bindings for
`AUTO-BAR-R-4-P-004@3` and `DOCS-FAQ-COUNT@1`. These bindings still require
review; they do not approve semantic truth.

An isolated Astro build with Pagefind completed successfully. The maintained
Playwright Common questions cases then passed three tests: immediate bookmark
reload on desktop, the same journey through the actual mobile Menu, and search
using both credential and stopped-disk alternate wordings. Evidence:
`/tmp/cloud-docs-faq-successor-fixed-build.log` and
`/tmp/cloud-docs-faq-successor-verified-playwright.log` (exit 0, no skips).
The isolated artifact was under
`apps/papercusp-docs/.astro/cloud-docs-faq-successor/dist`; the local preview
used `127.0.0.1:43129` and was stopped after verification.

The browser check found a fragment-reload defect: global smooth scrolling
could be interrupted by immediate reload, leaving the bookmarked answer at
the top-of-page scroll position. Replacing only that CSS behavior in the same
navigation sequence distinguished this from a missing anchor: the old behavior
left the heading at 4252px, while native immediate scrolling put it at 87px.
The stylesheet now keeps native immediate jumps. The maintained browser cases
guard desktop and mobile bookmarks; mobile viewport and Menu state are selected
before navigation. Tracked as `EI-25267974475848924`.

Independent sensitive-source review was requested in conversation
`conv-mux7lsk0-0000-8b25517ba71f4fbaac95376ffa49b508`, against FAQ SHA-256
`97482fb26c41800244c86206d591cfbc2249ca368bf7d1cf128e2585f81627a5`.
The first two routed reviewers declined because their inherited transcripts
covered rubric vetting rather than the product sources. The third reviewer,
`su-a21e7be0-2338-4117-a0cc-bd59694631fe`, performed fresh independent source
reads and recorded them in `thread-post:1160755`. That full post was read;
it supports billing separation, cloud stop/delete/cost cautions, scoped
credentials and the backup/restore warnings at the reviewed FAQ hash.
It approves checkout's negative claim but leaves the portal confirmation
surface unverified. It recommends clarifying that an allowance may be absent.

The allowance clarification is now in the FAQ. The author also read the portal's
`packages/ui/src/billing.tsx`: lines 160–227 derive the rendered status and
pending/active confirmation from subscription state; lines 419–432 fetch the
account's current subscription. This supports checking that surface rather
than trusting the return URL. `packages/ui/src/auth.tsx:249–261,330–356` supports
the administrator/sign-in recovery language and distinguishes optional
Gmail/Calendar data connections from portal authority. These are source checks,
not a claim that a live payment or organization-access journey passed.

The reviewer also identified a stale clone-only header comment in
`packages/operator-core/lib/agent-tools/backup/restore.ts:2`, contradicted by
the explicit `in_place` mode below it. That comment drift is filed and owned as
`EI-25268923232895042`; the FAQ already warns about replacement of newer work.
Approval of the revised FAQ, real novice observations, Avi's acceptance and
exact production verification remain unverified. No shipment is claimed.
