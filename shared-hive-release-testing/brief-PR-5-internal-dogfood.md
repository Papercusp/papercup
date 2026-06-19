# Brief PR-5 — Internal fork→PR dogfood (stand papercup up as its own forked member)

**Implementation brief.** Plan: `PLAN-pr-system-completion-dogfood.md` (Phase PR-5). The
owner's original ask: truly dogfood the member path by routing papercup's OWN contribution
through fork→PR. The live validation of PR-1..4. Depends on PR-1..4 landing (the inbound side
must be real first, else the dogfood just exposes a half-built path). Final phase.

## Why
Today papercup dogfoods git-sync as the privileged OWNER (direct-push) but has NEVER run its
own contribution through fork→PR — so the path external members hit is the least exercised by
the team (EI-382, the silent link-join-no-sync, was found by audit not use). Standing papercup
up as its own forked member makes the team eat the exact dog food external users will.

## Build / stand-up
1. **Enable platform mode internally.** Stand up `papercup` as a `kind:'hive'` self-hive via the
   EXISTING `platform:enable` (`enable-platform-mode.ts`, `PLATFORM_SELF_HIVE_SLUG=
   'papercusp-platform'`, canonical `github.com/Papercusp/papercup.git`) — the packaged-but-never-
   internally-run feature. Add the `papercusp-platform` flag/hive that's currently absent.
2. **Route REAL contribution through fork→PR.** A Bee (or a designated dogfood lane) contributes
   a real change to papercup AS A MEMBER without canonical write → `fork-pr-on-feature-pass` →
   fork under the operator's account → PR → PR-1 daemon notices → PR-2 agent-reviews → PR-3 owner
   mode (start MANUAL) → merge to canonical. Validate the WHOLE loop end-to-end, live.
3. **Fork cleanup.** Implement the missing teardown/GC: after a contributor PR merges/closes,
   GC abandoned forks (recommend KEEP-on-merge + a stale-fork GC, per the plan D-3 — deleting
   another account's fork is intrusive). Close the stale-accumulation gap.
4. **Contributor-revocation no-op fix.** Implement `revoked_pubkeys` (the silent no-op from
   `non-collaborator-join-fork-pr` D-001) so a revoked contributor actually loses contribution
   admission — composes with the owner-enforcement EN-3 revoke + the C-001 re-key.

## Tests (teeth-verified + LIVE)
- The full internal loop round-trips: a Bee's real change → fork→PR → agent-review → (manual)
  owner-approve → merged to canonical papercup main; the WI shows shipped + linked PR (PR-4).
- A non-collaborator can NOT direct-push canonical (the S0 invariant — composes with Brief AH).
- Revocation: a revoked contributor's new PRs are refused admission (teeth: pre-fix → no-op = RED).
- Fork GC: an abandoned fork is collected without touching active ones.

## Done
GREEN when papercup is live as its own forked self-hive, a real internal contribution round-trips
Bee→fork→PR→agent-review→merge to canonical, revocation has teeth, and forks don't accumulate —
the team now continuously eats the exact fork→PR path external members will, so member-path bugs
become ones the team hits first.
