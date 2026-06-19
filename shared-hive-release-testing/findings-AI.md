# Findings — Brief AI: Shared-hive ownership (provisional → claimed authority)

Owner: su-396e1. Lane: S0/S1 ownership-authority-root (the binding-service claim flow).
This pass took the BUILT-but-only-piece-tested provisional/claimed model to a
release-grade, teeth-verified end-to-end + adversarial pass against real Postgres,
and traced the federation/render path on every member surface.

**Verdict: 🟡 YELLOW** — the security ROOT (only a GitHub-verified maintainer/admin can
claim; non-owners are rejected; identity is unforgeable; supersede is admin-only) is
**sound and teeth-verified**. Two **S1** honesty/lifecycle gaps and one **S2** race
should be tracked before the owner-enforcement layer (`PLAN-owner-enforcement-layer.md`)
makes claim authority load-bearing. No S0.

---

## What I built (teeth-verified)

`packages/operator-core/lib/harness/__tests__/binding-service-authority.integration.test.ts`
— **27 tests** against a real testcontainer PG, mocking only the GitHub leg (octokit) +
`activeWorkspaceId`. This is the first test that exercises the **actual** service
functions (`createUnclaimedBinding` / `claimBinding` / `supersedeBinding` /
`recheckClaimantPermissions`) against a real cache row + the live permission gate.
Prior tests only covered pure helpers (`parseGithubRepoUrl`, `rowToBinding`,
`resolveClaimStatus`) and the route's **injected** `claimBinding`.

**Code change this pass:** `binding-service.ts` `recheckClaimantPermissions` — replaced the
v1 no-op stub with the real fail-safe per-claimant re-check (AI-4, below). Zero callers
existed, so zero blast radius on current behavior; typecheck + the full binding/claim unit
suite (37) stay green.

**Teeth-verify performed (README discipline):**
- Neutered the CLAIM gate (`if (!hasRequiredPermission(perm, CLAIM_REQUIRED_PERMISSION))`
  → `if (false)`) → the **3 S0 reject tests (write / read / none) went RED**, then
  restored → GREEN. Proves the gate is the real authority check, not a UI nicety.
- Neutered the SUPERSEDE gate (`SUPERSEDE_REQUIRED_PERMISSION`) → the **maintain-cannot-
  supersede** test went RED, then restored → GREEN. Proves the admin-only ladder is real.
- Restored both via `git checkout --` (no stray backup files; git-sync owns commit).

Existing green coverage I confirmed + lean on (not duplicated): `binding-service.test.ts`
(12) · `__tests__/binding-service.test.ts` rowToBinding (5) · both `claim-status-resolver`
suites (26) · `binding-claim.test.ts` route logic (11) · GUI `ClaimStatusBadge` (9) +
`HarnessClaimHeader` (8) + `useHarnessClaimStatus` (19). All green.

---

## Authority matrix (the brief's deliverable)

| Transition | Authority required | Enforced? | Evidence |
|---|---|---|---|
| create → unclaimed | any gh-token user (becomes provisional owner) | ✅ | scenario 1 tests; `BINDING_EXISTS` blocks a 2nd active bind |
| unclaimed → claimed | **live** GitHub `maintain`/`admin` on the bound repo | ✅ **teeth-verified** | claim S0 tests; neuter→RED |
| non-owner claim (write/read/none) | — | ✅ **rejected** `CLAIM_PERMISSION_DENIED` | scenario 3; status stays `unclaimed` |
| claim identity | the **gh-token** user (`getAuthenticatedUser`), never client-supplied | ✅ unforgeable | scenario 7; `claimBinding` takes only `binding_id` |
| re-claim (same user) | idempotent | ✅ no dup claimant | scenario 7 |
| 2nd maintainer claim (sequential) | each live-checked | ✅ both recorded | scenario 7 |
| 2 maintainers claim (concurrent) | each live-checked | ⚠️ **AI-6** lost-update window (S2) | scenario 7 |
| any → superseded | **admin only** (not maintain) | ✅ **teeth-verified** | scenario 4; neuter→RED |
| claimed → stale (claimant loses perm) | 24h daemon | ⚠️ logic **FIXED + teeth-verified** this pass; daemon still **UNWIRED** (AI-4) | scenario 5 |
| claim_status → a joining member | federation | ❌ **AI-5** does not federate (S1) | scenario 6 |
| renamed repo | id-keyed, full_name refreshed | ✅ | scenario 7 |
| deleted repo | honest failure `GITHUB_REPO_NOT_FOUND` | ✅ | scenario 7 |

---

## AI-1 — S0 claim gate is real + correct (scenarios 2, 3) — ✅ PASS

`claimBinding` resolves the acting user from the gh-token, calls
`getRepoPermission(owner, repo, login)` LIVE, and gates on
`hasRequiredPermission(perm, ['admin','maintain'])`. A `write`/`read`/`none`/non-collaborator
user is rejected with `CLAIM_PERMISSION_DENIED` and the row stays `unclaimed`. Teeth-verified
(neuter → the 3 reject tests go RED). **Note the subtlety, now pinned by a test:** `write`
is NOT sufficient — only `maintain`/`admin` — so a mere repo collaborator cannot seize the
trust signal.

## AI-2 — Identity is unforgeable (scenario 7) — ✅ PASS

The claim route (`POST /api/harness/binding/claim`) and `claimBinding` accept ONLY a
`binding_id`. The claimant recorded is always `getAuthenticatedUser()` (the local
gh-token). There is no client-supplied identity parameter anywhere on the path, so a
"forged claim request (wrong identity)" is structurally impossible — the worst a caller
can do is claim *as themselves*, which the GitHub permission gate then checks.

## AI-3 — Supersede is admin-only (scenario 4) — ✅ PASS

`supersedeBinding` gates on `['admin']` (stricter than claim's `['admin','maintain']`). A
`maintain`-only claimant is rejected `SUPERSEDE_PERMISSION_DENIED` and the row is untouched.
Teeth-verified (neuter → RED). The authority ladder (maintain can claim, only admin can
supersede) holds.

## AI-4 — stale re-verification was a no-op stub; LOGIC now FIXED + teeth-verified this pass (scenario 5) — 🟠 S1 (logic resolved; daemon UNWIRED) — EI-1624

**As found:** the 24h stale re-verification could not demote a real claimed binding. In
`binding-service.ts` the loop copied *every* claimant into `stillClaimers` unconditionally
(the per-claimant re-check was explicitly stubbed — "no numeric-id → login lookup table on
hand"), so `stillClaimers.length === 0` was unreachable for any binding with ≥1 claimant.
A former maintainer who lost `maintain`/`admin` kept the **claimed** trust signal forever,
and the provisional-owner controls that `stale` re-enables never re-enabled. **Compounding
finding:** `recheckClaimantPermissions` also has **ZERO callers** — it is not wired to any
routine/daemon/schedule — so even a correct implementation would never fire live.

**Fixed this pass (logic):** I implemented the real per-claimant re-check with fail-SAFE
semantics, teeth-verified:
- resolve each numeric claimant id → login via the `contributors` mirror (the same join
  `claim-status.ts` uses — the lookup the original comment said was "not on hand" now exists);
- re-check each claimant LIVE via `getRepoPermission`; drop a claimant ONLY on a
  **definitive** result below maintain/admin;
- **fail-safe rule 1:** an unresolvable login → KEEP (never demote on uncertainty);
- **fail-safe rule 2:** a `getRepoPermission` throw (GitHub down / rate-limited) → KEEP
  (never demote on a transient error) — so a GitHub outage can't mass-false-demote owners;
- ALL claimants definitively lost → `claimed→stale` + clear `claimed_by`; SOME lost →
  prune them, stay `claimed`.
Teeth-verified: neutering the keep/drop decision turns the demote + prune tests RED; the two
fail-safe (keep) tests stay green. 6 cases in `binding-service-authority.integration.test.ts`.

**Why STILL S1 / why the verdict stays YELLOW:** the daemon remains **UNWIRED** — nothing
schedules `recheckClaimantPermissions`, so scenario 5 does not fire end-to-end LIVE until a
24h routine is added (deliberately NOT done here: wiring a new scheduled security-lifecycle
daemon is cross-cutting routine/scheduler infra + a cadence/ops decision for the owner —
EI-1624). `PLAN-owner-enforcement-layer.md` §4 already re-checks GitHub permission **live**
at policy-author time, so it does not lean on this daemon; but the plan must never trust
cached `claim_status` for authority without that live re-check — AI-4 is why the live
re-check is load-bearing.

## AI-5 — claim_status does NOT federate: a member of a CLAIMED hive sees "unclaimed" (scenario 6) — 🟠 S1 — EI-1625

`shared_repo_binding_cache` is **not a federated table**:
- not in `PEER_LOG_TABLES` (`harness-state/table-registry.ts`) — pinned by a guard test;
- no `capture_substrate_outbox` trigger (its only trigger is mig-107 `emit_change_notify`,
  the **local** SSE refresh, not federation);
- no projection in `lib/sync/.../projections`.

The single data source for every claim badge (`/adv` header, Insights ProjectCard,
profiles) is `GET /api/harness/:slug/claim-status`, which reads ONLY the **local**
workspace's cache row. A joiner never writes that row — `join-shared-harness.ts` synthesizes
`.papercusp/shared.json` with `claim_status: 'unclaimed'` **hardcoded** (line ~576) and no
PG cache row. So on a member's machine the route returns `NO_BINDING` →
`HarnessClaimHeader` renders the explainer **"No GitHub maintainer has claimed this
harness. The creator is the provisional owner."** — an **active falsehood** for a hive the
owner has claimed.

**Severity S1 (a surface lies / a feature silently doesn't federate)** per the brief's
explicit done-criterion ("claim status federates + renders honestly on every surface — no
surface lies"). **Blast radius is display-only**: no data loss, no privacy leak, and a
member cannot forge `claimed` (with `binding_id:null` the claim CTA is hidden and `claim()`
short-circuits). Design nuance: the owner-enforcement layer federates *policy* via
`hive_settings` (post-A-003), **not** via this cache, so AI-5 does not block enforcement —
but it does mean members cannot today see *who* the verified owner is, which undercuts the
"claim = public trust signal" story for shared-public hives. Recommend either federating a
read-only projection of `(claim_status, claimed_by logins)` from the owner's hive-home, or
sourcing the member-side badge from the Cupboard listing's `claim_status` for shared-public
hives. **A live two-instance pass should specifically assert: does a JOINER see the owner's
`claimed` badge? (today: no.)**

## AI-6 — Concurrent two-maintainer claim has a read-modify-write lost-update window (scenario 7) — 🟡 S2 — EI-1626

`claimBinding` does read (`readCachedByRepoId`) → compute `[...existing.ids, me.id]` →
`upsert` with `ON CONFLICT DO UPDATE SET claimed_by_github_user_ids = EXCLUDED.…`, which
**replaces the array wholesale** from a value computed off a possibly-stale read. Two
maintainers claiming the *same* binding concurrently in the *same* workspace can therefore
last-write-wins one claimant out of the array. The concurrent test pins the safety
invariant that holds regardless of interleave: **no corruption, no duplicate id, status
ends `claimed`, ≥1 authorized claimant recorded.** Impact is minimal — narrow window (two
concurrent claims in one workspace), both parties ARE authorized, and the dropped claimant
can simply re-claim (idempotent). **S2.** Fix if cheap: make the append a
`claimed_by = array(SELECT DISTINCT unnest(claimed_by || me))` set-union in the UPDATE, or
wrap read+write in a transaction with `SELECT … FOR UPDATE`.

## AI-7 — Renamed / deleted repo resolve honestly (scenario 7) — ✅ PASS

`resolveRepoIdentity` keys on the numeric repo id and refreshes the cached `github_full_name`
on a rename (test pins it). A deleted repo (GitHub 404) → `GITHUB_REPO_NOT_FOUND`; a
rate-limited GitHub (403 + `x-ratelimit-remaining:0`) → `GITHUB_API_RATE_LIMIT` with a
retry hint. No silent corruption. Minor note (not filed): `claimBinding` computes the
perm-check `owner/repo` from the **cached** `full_name`; a rename occurring between create
and claim is checked against the stale name (GitHub usually redirects, but a hard-renamed
collaborator path could 404→`none`→deny). Low-probability; resolve-then-claim refreshes it.

## AI-8 — GUI claim surfaces are honest + correctly gated (scenario 8) — ✅ PASS (live E2E open)

The presentational + hook layers are covered green: `ClaimStatusBadge` renders exactly the
4 states (never "claimed" for an unclaimed input); `HarnessClaimHeader` shows the claim CTA
**only** when `status==='unclaimed' && viewerCanClaim` and **hides it when claimed even with
viewerCanClaim** (no double-claim path); `useHarnessClaimStatus` POSTs the claim and
surfaces the structured permission error as a toast. The components faithfully render the
status they are *given* — so the GUI itself is honest; AI-5 is a data-source gap upstream of
them, not a component bug.

**Open item:** a full two-identity **live Tauri** claim E2E (real shared hive → owner claims
→ status flips → badge updates; and a non-owner's CTA 403s) was NOT run — heavy infra
(packaged `.deb` + two GitHub identities with differing repo perms + the
`shared-hive-live-instances` lock). The integration layer already teeth-verifies the same
gates at the service boundary, so this is a confidence top-up, not a coverage hole — but it
is the right place to also verify the **AI-5 member-honesty** question live. Prior art:
`apps/operator/e2e/adv-hive-from-github-url.spec.ts`.

---

## Gaps left open (with why)
- **Live two-identity Tauri claim E2E** (AI-8 open item) — heavy live infra + lock
  coordination; service-layer gates are teeth-verified, so deferred to a coordinated
  live-lane pass (recommend folding AI-5's member-badge check into it).
- **AI-4 fix** (per-claimant re-check) and **AI-5 fix** (federate/route the member badge)
  are design changes spanning the daemon / federation registry — out of a single test
  lane's low-risk fix budget; filed for the owner rather than silently patched.

## Recommended dispositions
1. **AI-4 (EI-1624):** logic is now implemented + teeth-verified this pass. **Remaining: wire
   `recheckClaimantPermissions` to a 24h routine** (cross-cutting scheduler infra — owner
   decides cadence + ops) so scenario 5 fires live. **Gate the owner-enforcement layer on a
   working live owner re-check, never on cached `claim_status`.**
2. **AI-5 (EI-1625):** decide the member-side source of truth for `claim_status` (federated
   read-only projection from the hive-home, or Cupboard listing for shared-public) so a
   member of a claimed hive stops being told "no maintainer has claimed this." (Cross-cutting
   federation change — filed, not patched from this lane.)
3. **AI-6 (EI-1626):** within the brief's allowed "first-wins, no corruption" envelope today;
   optional polish — make the claimant append a set-union (or `FOR UPDATE`) to also record
   the concurrent co-maintainer.
