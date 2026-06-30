# Learning Packs — default hive learnings, hive memory, Comb distribution
URL: /internal/docs/system/learning-packs

How a new hive inherits curated working wisdom, where it lives (the hive:<slug> memory pool), how packs are managed through the conflict review, and how the Comb distributes them behind operator approval.

# Learning Packs

> Plan of record: `learning-packs-2026-06-11` (shipped). Code anchors:
> `packages/operator-core/lib/learning-packs/`, `lib/memory/hive-scope.ts`,
> the `learning_packs:*` tool group, and the Cupboard worker migration 008.

A **learning pack** is a versioned, git-canonical set of *learnings* —
curated, project-transferable working wisdom. At hive creation the selected
pack is **copied** into the hive's own memory store; from then on the hive
owns every row — editable, deletable, growable — and every agent in every
member harness recalls it.

**Which pack seeds is a 3-level priority** (`hive:create`,
`_create.ts`): an explicit `learningPack` arg wins; else the blueprint's
declared `learning.pack`; else the global fallback
**`papercusp-default`** (32 learnings). So `papercusp-default` is *only*
the fallback — a hive whose blueprint declares a `learning.pack` seeds
that instead (see [Built-in packs](#built-in-packs-three-of-them)).

## The three load-bearing decisions

* **Copy, never live-link (D-001).** Seeded rows are ordinary mem0 rows in
  the `hive:<slug>` scope, provenance-tagged
  (`{source:'pack', pack_id, pack_version, pack_item_id}`). Injection,
  per-hive editing, uninstall, and upgrade-diff all ride existing machinery;
  a hive's store changes only by deliberate act.
* **Encode the discipline, parameterize the stack (D-002).** Pack content is
  *discovery rules* ("find how this project runs tests; use that framework"),
  never stack bindings ("use Vitest"). The Queen's first wake runs
  **convention discovery** and records the bindings as hive memories
  (`memory:remember { hive_slug }`); `applies_to` shape tags
  (`ui|service|library|cli|any`) filter what seeds.
* **Install is a merge review, never a silent union (D-003).** Installing a
  pack into a non-empty pool classifies every incoming learning into one of
  **four statuses** — `present` / `clean` / `duplicate` / `conflict`.
  `present` is the **provenance guard**: an item whose `{pack_id,
  pack_item_id}` already has a row is an unconditional no-op (skipped
  regardless of any resolution or embedding score) so a pack row is **never
  double-written** on re-install/upgrade. The other three are the
  same-pool semantic outcomes for items with no provenance row yet —
  `clean` installs; `duplicate` / `conflict` (mem0 dedup + the P-017
  conflict judge) require explicit per-item resolutions (keep existing ·
  take incoming · keep both). Defaults skip clashes: existing content
  outranks the incoming pack.

## Where things live

| Piece                   | Location                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-in packs          | `libs/papercusp/packages/harness/learnings/<pack-id>/` (manifest.yaml + one-learning-per-file md) — three ship: `papercusp-default`, `coding`, `work`                                                                                                                                                                                                                                                                                                                                                                  |
| Comb-installed packs    | `~/.papercusp/learning-packs/<pack-id>/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A hive's live learnings | mem0 rows, scope `hive:<home-slug>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Pack mute state         | hive setting `learning-packs:disabled` (federated hive\_settings)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Seeding                 | `hive:create` step 6b (flag `LEARNING_PACKS`, default ON; undo-stacked, best-effort)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Pre-turn injection      | `buildMemoryContextBlock` — hive pool resolved member→hive via the registry's `hive_slug`; token-budgeted (\~4k default, `PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS`), priority user > harness > hive-organic > hive-pack; muted packs filtered                                                                                                                                                                                                                                                                             |
| Runtime recall scope    | `memory:search` default fan-out is **confined to the session's hive subtree** (P-018, `narrowHarnessSlugsToSessionHive`, `lib/memory/hive-scope.ts`). A hive-scoped agent never cross-recalls sibling hives' harness pools. Workspace-spanning sessions (`harness='*'`) and plain standalone harnesses are exempt — their fan-out is unchanged. Gated by `FLAGS.SCOPED_SUPERUSER_CLAMP`; fail-open (flag read error → full fan-out retained). `memory:list` is unaffected (it only adds explicitly-passed hive pools). |

## Built-in packs (three of them)

Three packs ship under the builtin root, each seeded by the blueprint-driven
priority above (D-010, `domain-generic-hive-architecture`):

| Pack                | Seeded for                                                                         | Shape                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `papercusp-default` | the global fallback (no blueprint `learning.pack`, no explicit arg) — 32 learnings | shape-conditional                                                                                |
| `coding`            | a coding hive (`extends: coding`)                                                  | shape-conditional items (`ui\|service\|library\|cli\|any`) — generic engineering discovery rules |
| `work`              | a work hive (`extends: work`)                                                      | fully `any` (repo-less) — coordination discipline + rubric-judged deliverables                   |

`coding` and `work` carry only generic *discovery rules*, never stack
bindings; project specifics belong in the per-hive override and a separate
project pack. Because a coding hive defaults to `coding` and a work hive to
`work`, `papercusp-default` is **not** seeded for those blueprints.

## Candidate-promotion loop (fleet → pack)

A recurring cross-scope friction signature (the recurrence-escalation
promotion noticing the same pain across ≥2 distinct scopes) is staged as a
`learning_pack_candidates` row — deduped structurally so a dismissed lesson
never re-nags, and capped (default 20 pending). The **owner** then adopts or
dismisses it (`learning_packs:decide_candidate`); adoption **materializes**
the item into the `fleet-lessons` pack under the installed-packs root and
bumps that pack's patch version — it **never** writes into a hive pool
directly. Hives pick the new item up only through the normal install/upgrade
conflict review (D-003) — so a candidate becomes recallable wisdom only after
two deliberate human acts. Surfaced in the Learnings view and via the
`learning_packs:candidates` + `learning_packs:decide_candidate` verbs
(self-improvement-consume-edges P-032).

## Surfaces

* **Creation:** both create flows carry the pack picker (default pack
  preselected, "none" allowed); the from-repo strip shows a real `seed` step;
  the success card links to the Learnings view.
* **Learning tab → Learnings:** per-hive view with pack badges
  (pristine/edited vs the pack), origin filter, inline edit/remove, pack
  management (install / mute / uninstall / upgrade) and the conflict-review
  cards. Backing reads: `learning.hive`, `learning.hiveList`,
  `learningPacks.list`.
* **Verbs:** `learning_packs:list / install / uninstall / set_enabled /
  upgrade / sweep / export / publish / candidates / decide_candidate` (ten).
  `sweep` re-judges the whole pool for contradictions that emerge after
  install; `upgrade` adopts a newer version's NEW items only — present rows
  are never auto-touched; `uninstall` is provenance-driven and **keeps edited
  rows by default** (only pristine pack rows — text still matching the pack's
  canonical render — are removed; `keepEdited: false` removes everything, and
  the returned `kept` list reports the edited rows preserved). The HTTP
  routes under `/api/learning-packs/*` do **not** map 1:1 to the verbs — they
  are `install`, `upgrade`, `uninstall`, `set-enabled`, `fetch-from-comb`,
  and `candidate-decide`; `list / sweep / export / publish / candidates` are
  MCP-only or reached through other paths.

## Comb distribution + the approval gate (D-007)

Listing kinds gained `learning-pack` (and `pack` was renamed `tool-pack`;
the old wire value still parses). **Instruction-carrying kinds —
`learning-pack` and `blueprint` — publish PENDING** and are publicly
invisible until an allowlisted operator approves them at
`/admin/cupboard-moderation` (worker routes `/admin/pending` +
`/admin/listings/:id/review`). Submitters see their own pending listing and
any rejection reason. Code kinds (plugin/tool-pack) keep install-time
capability consent + reactive moderation.

Install-from-Comb only **stages** a pack locally (clone → validate through
the pack parser → `~/.papercusp/learning-packs/`); it enters a hive solely
through the conflict review. Every learning is browsable on the listing
detail page *before* install. Publishing: `learning_packs:export` writes the
pack shape into a member repo (organic rows only by default), the project's
normal flow pushes it, `learning_packs:publish` creates the listing.

## Ops notes

* Worker migration `008_learning_pack_kind_review_status.sql` is a ONE-SHOT
  D1 rebuild (applied to production 2026-06-11; pre-008 rows grandfathered
  `approved`; the one retired `snapshot` row was removed — backup taken via
  `wrangler d1 export` first). Future rebuild migrations: **enumerate the
  live `listing_kind` values before writing the CHECK** — a forgotten legacy
  kind fails the whole batch.
* Tests live under the **Learnings** domain in the Tests tab
  (`testing-domains-registry.ts`).
