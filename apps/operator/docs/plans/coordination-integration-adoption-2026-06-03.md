---
title: Coordination integration & adoption — subscribable features/plans, admin UI, agent prompting
slug: coordination-integration-adoption-2026-06-03
status: draft
created: 2026-06-03
updated: 2026-06-03
owner: aviynw@gmail.com
companion-to: [coordination-substrate-2026-06-03, coordination-conversations-2026-06-03, engineer-issues-2026-06-03]
---

# Coordination integration & adoption

## Now

**State:** Draft 2026-06-03. The last layer — connects the existing systems into the substrate, builds the human-facing UI, and ships the agent prompting that makes the whole thing actually get used. Depends on [[coordination-substrate-2026-06-03]], [[coordination-conversations-2026-06-03]], [[engineer-issues-2026-06-03]]. No code yet.

**Next:** build after the substrate + at least one object type (conversations or issues) prove out.

## Three concerns

- **A. Make features & plans Subscribable + Taggable (connect, NOT rebuild).** Features and plans already emit change events (features: `emit_change_notify` + `substrate_outbox` CDC; plans: plan-events + `plan_revisions`). Making them subscribable is mostly WIRING those existing streams into the substrate fan-out + adding topic tags — not rebuilding either system.
- **B. Admin UI (operator-level, cross-harness — none exists today).** The audit confirmed the issues UI is per-harness only; there is no operator/cross-harness view, and topics/conversations are brand new.
- **C. Agent adoption / prompting (the thing that makes it work).** A coordination system is only as good as agents' discipline in using it; the guidance layer is first-class, not a follow-up.

## Decisions

### D-001 — Tag features & plans with topics → the topic becomes a cross-object index
2026-06-03

Plan-level + feature-level topic tags (not per-item — over-granular). Then a topic is a cross-object feed: "everything about `zero-cache`" = the plans + issues + conversations + features tagged it. Subscribing to a topic gives the whole work-stream of an area across object kinds — the real payoff of universal topics.

### D-002 — Route existing CDC events into the fan-out (high-churn → digest)
2026-06-03

Feature/plan change events flow through the substrate fan-out to topic/entity subscribers. Features + plans are high-churn → they default to `digest` delivery mode (substrate D-006), never `full`, or they firehose. No new emission — reuse the existing CDC streams.

### D-003 — Admin UI: operator-level, nuqs-backed, SSE/agent-driveable
2026-06-03

New operator surfaces: a Topics browser (list/subscribe/merge), a Conversations/Q&A view (open questions, threads, resolve), and an operator-level cross-harness Issues view (the gap the audit found). All user-meaningful state in nuqs (per CLAUDE.md), built on the existing admin shell + the SSE reactive path (NOT Zero). Reuse the plans-admin patterns (rail / detail / threads).

### D-004 — Prompting spans all three layers + tool-shape enforcement
2026-06-03

Per the repo's per-role guidance discipline: (1) `defineTool` guidance (when/notWhen/chaining) on every new verb — when to ask vs file-issue vs discuss; tag-topics-on-create; claim-before-fixing; (2) `<role>.tools.md` cross-tool workflow — knowledge-first → ask → maybe-file-issue; "subscribe topics for your work area"; "discovered a problem → `issues:create` + tag + link blocked items"; (3) `<role>.persona.md` behavior — tag topics on every create; capture answers on resolve; claim before fixing; check your topic-feed. The load-bearing disciplines (knowledge-first, topic-tagging) are ALSO enforced by tool shape, not just prose — prompts drift.

### D-005 — A standing "coordination" section in the SU playbooks
2026-06-03

`papercusp-su-{engineer,power}.tools.md` get a section explaining the whole loop (subscribe your topics; ask knowledge-first; file issues on discovery; promote conversations → issues → features) so a fresh agent uses the system coherently, not verb-by-verb.

## Build

### Phase 1 — Subscribable features + plans
`table-registry` tag columns for features/plans (via su-08782's registry shape); wire their CDC into the fan-out; topic-tag write paths; the cross-object topic-index query.

### Phase 2 — Admin UI
Topics browser; Conversations/Q&A view; operator-level cross-harness Issues view. nuqs + SSE + the existing admin shell.

### Phase 3 — Adoption
`defineTool` guidance on all new verbs; role `tools.md` + `persona.md` edits; the SU playbook coordination section; tool-shape enforcement of the key disciplines. Run the `tools-md-sync` test (the guidance-coverage gate) green.

## Risks
- **Prompting drift / non-adoption** — mitigated by tool-shape enforcement of the load-bearing disciplines + the `tools-md-sync` guidance-coverage gate.
- **UI churn vs in-flight plans-PG + storage-unification work** — sequence the UI after those land where they overlap (plan reads, `table-registry`).
- **High-churn feature/plan feeds** — `digest`-default (D-002) is mandatory; verify no `full`-mode default leaks.

## Dependencies
All three prior plans; su-08782's registry/projection engine (tag columns + fan-out); the SSE path; the existing admin shell + plans-admin patterns.
