# Current-build manual review and acceptance boundaries

Plan: cloud-portal-docs-and-papercup-faq-2026-10-06, P-003 / WI-10006917.
Recorded 2026-10-07 by su-73f621d7-bae1-4bbb-b045-a11b5c47a384.

This records source review and browser observations. The seven product
journeys, real novice study, live Papercup matrix and shipment are unfinished.
No account creation, paid provisioning, payment, deletion or external send
was performed during these checks.

## Source review

Portal paths below are relative to the configured workspace's
`.papercusp/apps/portal` checkout.
Core and manual paths are relative to the canonical Papercusp staging tree.

| Journey | Observed source and manual instructions | Remaining runtime evidence |
| --- | --- | --- |
| Account and organization | `packages/ui/src/auth.tsx` renders **Create account** and **Sign in**. The account guide requires the same identity, intended organization and separate access checks; repeated signup is not access recovery. | Prepared-account sign-in, organization access and applicable recovery. |
| Workspace connection | `packages/ui/src/workspaces.tsx` defines **Use Papercusp's cloud**, **Bring your own cloud**, **Google Cloud** and **AWS**. Host readiness gates **Open desktop**; a workspace card alone is insufficient. Quickstart preserves the account-dependent choices and provisioning/connection distinction. | Applicable connection and readiness transition without creating billable hosts. |
| First task and result | `packages/ui/src/ask-papercup.tsx` renders **Ask Papercup…**. `apps/host/src/papercup-chat.ts` fixes role `papercup` and public trust. `apps/operator/prompts/papercup.converse.md` hands implementation to a recorded work-item. Quickstart now names the actual composer, requires a confirmed target, and follows the implementation reference to the inspectable README result. | Actual handed-off task, implementing session and changed README with verification. |
| Approval and permissions | `ASK_CAPABILITY_CONTRACT` in `ask-papercup.tsx` declares no confirmation round-trip for public chat actions. The manual now distinguishes that boundary from approval and AUTO in the implementing agent's conversation. Public retrieval must not broaden the principal's access. | The real implementing route's approval interaction and permission refusals. |
| Costs, stop and delete | `packages/ui/src/billing.tsx` renders **Manage billing** conditionally. The guide preserves displayed prices, confirmed entitlement versus checkout return, three charge categories, retained resources after stop and backup/restore before deletion. | Role-appropriate billing/lifecycle explanations and displayed confirmation; no payment or destructive action is needed as a study shortcut. |
| Data, privacy and credentials | Remote-access and snapshot guides preserve limited app access, supported credential setup, secret redaction, completed backup and explicit restore. Public manual retrieval is isolated from private corpora; static prose cannot establish a tenant's current permissions. | Authorized current access and applicable recovery evidence; paired public-positive/private-negative runtime controls. |
| Errors and support | Troubleshooting separates sign-in, connection, stopped-agent and stale-document failures and asks for redacted reference/time evidence. It uses the installation's support destination rather than inventing a universal Support button. | Applicable runtime recovery and an identified support destination, without sending an external report. |

## Browser observations

The existing Astro preview served the actual built manual at the private
loopback address `http://127.0.0.1:32123/docs`. This is a disposable local
current-build preview, not the staging operator, portal deployment or a durable
delivery URL. The public manual build had completed at 19:42Z before this
session's final composer/approval copy correction; that correction still needs
a fresh build and affected browser checks.

Maintained command profile: `apps/operator/playwright.config.ts` with
`OPERATOR_E2E_BASE_URL`, `OPERATOR_E2E_REUSE_SERVER=1`, and
`OPERATOR_E2E_SKIP_WARMUP=1`. The skipped warmup targets the operator SPA's
routes, which do not exist on this static manual preview. Test assertions and
the shared egress/ledger reporter were retained.

- Ledger **20905604**, LOCAL, six checks passed: five guide links, reloads,
  375-pixel mobile overflow and actual Pagefind result navigation.
- Ledger **20905682**, LOCAL, two new maintained checks passed: keyboard skip
  into content, keyboard search/open/close, and light/dark selection persisted
  after reload with visible content and no horizontal overflow.
- The preceding **20905676** failure remains recorded. Its cause was two
  incorrect new test assumptions: the skip target sets the keyboard navigation
  position without focusing the heading, and a raw theme selector includes a
  hidden mobile duplicate. A measured browser diagnostic distinguished those
  assumptions from a product failure. The corrected suite checks next-Tab
  entry into `main` and uses the visible accessible combobox.

Test source: `apps/operator/e2e/public-manual.spec.ts`. Passing browser checks
do not establish semantic accuracy, live chat behavior, novice outcomes or
production shipment. Follow the remaining evidence requirements in
`acceptance-protocol.md`; unobserved fields stay unknown.

## Rebuild and combined check after the copy correction

The corrected source rebuilt successfully at **20:28:42Z**, including the
Pagefind index and copied canonical `manual-source` bundle. Astro check then
reported zero errors, warnings and hints; both maintained manual test files
passed all seven tests. LOCAL ledgers: **20905704** (first-task) and
**20905703** (public build/source parity), head
`77a0fb0d1e9cedefc69c2677e7193e96eba34194` plus dirty source.

The combined eight-browser-check run on that rebuilt manual is **20905705**:
**seven passed, one failed**. The keyboard shortcut opened the search dialog,
but the input did not receive focus. The earlier focused run passed; the
cause of the differing observation is unknown. This is owned as
**EI-25354008812545188**, linked to WI-10006917. Measure actual focus and the
Starlight search lifecycle before changing the assertion or claiming a product
fix. Do not report the current browser cohort as fully passing.

The preview was stopped after the check. No verification process remains
running. The test command and source path above let a successor recreate it;
the loopback address is not a delivered artifact URL.

## Focus diagnosis and current checks, 20:42–20:45Z

This section supersedes the unresolved-focus and red-cohort conclusions above.
The earlier failures remain evidence; they were not replaced by passing replays.

Installed Starlight `Search.astro` focuses an existing input in `openModal`,
then independently creates Pagefind's input from a `requestIdleCallback` after
`DOMContentLoaded`. A maintained test controlled that callback and opened the
real dialog first. LOCAL ledger **20906610** reproduced the inactive input
after Pagefind mounted. The companion close-before-mount test initially used
an accessible-role query that excludes closed dialogs; its count failure was
a test locator mistake, corrected to the actual `site-search dialog` element.

The public manual now wraps Starlight's own Search component through its
supported override. A one-shot mutation observer focuses the late input only
if the dialog is still open. Starlight retains its UI, search engine, shortcuts
and existing ready-input behavior. The observer disconnects when the input
arrives, so result updates do not reclaim focus. Closing the dialog before
initialization completes preserves the reader's current focus.

The build completed at **20:41:46Z** after output-subtree locks were acquired.
The fresh actual Astro preview at `http://127.0.0.1:32123/docs` passed the
complete maintained public-manual browser file: **13 passed**, LOCAL ledger
**20906621**, including both controlled initialization cases, the original
keyboard journey, themes, mobile/reload checks, FAQ fragment bookmarks and
actual Pagefind results. The unchanged egress fixture and ledger reporter ran.
The associated Astro check had **zero diagnostics**; both maintained manual
test files passed **seven tests**, LOCAL ledgers **20906640** (first task) and
**20906639** (served build and canonical retrieval bundle parity). These rows
name head `43022a600667d6d07f6485a5dd7686310bdbe44d` plus dirty source; they
prove the tested working build, not an exact committed or deployed artifact.

P-005 integration also exposed a real cross-repo disclosure mismatch:
`selectConverseTools` selects `docs:search` and `docs:get`, but the Portal's
`ASK_CAPABILITY_CONTRACT.attachedTools` omitted both. The existing Portal test
failed that assertion in **20906637** (three passed, one failed). The notice
now lists both tools, and its composition test includes `PUBLIC_MANUAL_TOOLS`.
Fresh Portal tests passed **28/28**, LOCAL ledgers **20906708** (four contract
tests) and **20906709** (24 Ask panel tests). Machine access and confirmation
behavior are unchanged. This repair is owned as **EI-25354793930299654** under
WI-10006919. It does not demonstrate the fresh installed public MCP runtime,
tenant isolation, live answer policy or production disclosure.

The seven actual product journeys, real novice study, live Papercup/security
matrix, independent acceptance and exact production shipment remain open.
