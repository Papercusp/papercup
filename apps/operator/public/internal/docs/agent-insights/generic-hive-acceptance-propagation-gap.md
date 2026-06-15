# Generic-hive acceptance/output doesn't gate deliverables yet — the hive↔member finalize split
URL: /internal/docs/agent-insights/generic-hive-acceptance-propagation-gap

A live P-021 smoke found that a generic-hive's acceptance.kind=judge / output.kind=artifacts is declared on the HIVE harness, but deliverables finalize in MEMBER harnesses (research/review/vote) that don't inherit it — so the judge gate (P-009) + artifacts output (P-010), though correctly built + unit-tested, do not fire end-to-end. The fix is propagating the hive's domain profile to its members.

## What the smoke found

`hive-blueprint-generalization` P-021 (the live smoke) was meant to prove a
`generic-hive` reaches DONE repo-less via **judge acceptance + artifacts output**.
Standing one up on the live operator confirmed the *create* path end-to-end:

```bash
# (raw MCP — see "Gotcha: stale client schema" below)
hive:create { slug, blueprintId: 'generic-hive' }
# → a home harness whose .papercusp/blueprint.yaml is `extends: generic-hive`,
#   inheriting acceptance.kind=judge / output.kind=artifacts / affinity=topic-overlap.
```

But the judge gate **never fires for the actual deliverables**, because of an
execution-model split:

* The **hive harness** runs the hive blueprint: `spine.decider: queen`,
  `workItem.kind: hive-wake` (idPrefix `POT`). Its work items are the Queen's
  **placement/wake triggers**, NOT deliverables. Its finalize path only ever
  processes `hive-wake` items.
* **Deliverables** (a report, analysis, decision) are placed by the Queen as
  feature-family items into **member harnesses** — the `research` / `review` /
  `vote` pipelines (`generic-hive`'s `dependencies.blueprints`). They run + finalize
  under the **member's** blueprint.
* A member blueprint (`research`, …) declares **no `acceptance`** ⇒
  `harnessAcceptanceKind(memberProjectDir)` is `undefined` ⇒ the finalize gate is the
  plain coding/straight-through path. The hive's `acceptance.kind=judge` is on the
  *hive* harness, which the deliverable never finalizes in.

So **P-009 (judge hard-gate) and P-010 (artifacts output) are correct mechanisms —
built, unit-tested, byte-identical-for-coding — but unwired to where deliverables
actually finalize.** The domain profile is declared on the hive; the work finalizes
in the members.

## The fix (the wiring that's missing)

The hive's `acceptance` / `output` (and `affinity`/`lexicon`) profile must
**propagate to the member harnesses** a generic-hive spawns, so a `research` member
*of a generic-hive* finalizes under judge + artifacts. Candidate seams (pick one):

1. **At member creation** — when the Queen spins up a member (`harness:create` for a
   hive-owned pipeline), overlay the hive's `acceptance`/`output` onto the member's
   resolved config. Cleanest "the hive governs its members" model.
2. **At the finalize gate** — make `harnessAcceptanceKind` / `harnessOutputKind`
   for a member that BELONGS to a hive fall back to the owning hive's profile
   (needs the member→hive link at finalize time).

Until then, a generic-hive's deliverables finalize like any research task (no judge,
no artifacts sink). The `VERIFICATION_STANDARD` preamble swap (P-008) DOES reach the
member's bees (it reads the member's own blueprint — but the member has no `judge`
acceptance either, so a research member's bee gets `TESTING_STANDARD` unless the
member inherits the hive profile too — same propagation gap).

## Gotcha: a long-lived client session has a STALE tool schema

The su MCP client snapshots tool **schemas at session start**. `hive:create` gained
its `blueprintId` arg mid-session (P-006), so an old session's
`mcp__papercusp-su__hive_create` lacks it and can't create a generic-hive. The
operator itself is current (it resolves `@papercusp/operator-core` from **source**
`./lib`, not a build). Workarounds: start a fresh client session, or call the
operator's MCP directly — `POST :3070/api/mcp?superuser=1&client=<uiClientId>` with
`{method:"tools/call",params:{name:"hive:create",arguments:{…,blueprintId}}}` (the
real tool name is colon-form `hive:create`; the handler needs the `&client=` id or it
errors `resolveAgentIdentity: superuser context is missing uiClientId`).

## Status of the surrounding work

Built + unit-tested + correct, just unwired end-to-end: P-009 judge hard-gate
(`parseAcceptanceVerdict` + the finalize-loop skip-onDone-on-`revise`), P-010 output
tagging, P-008 preamble swap. The create path + domain-profile inheritance are
**live-proven**. The propagation above is the remaining step to make the gate fire on
real deliverables. Plan: `hive-blueprint-generalization-2026-06-15` (P-021).
