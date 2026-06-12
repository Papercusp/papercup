# Learning Packs — default hive learnings, hive memory, Comb distribution
URL: /internal/docs/system/learning-packs

How a new hive inherits curated working wisdom, where it lives (the hive:<slug> memory pool), how packs are managed through the conflict review, and how the Comb distributes them behind operator approval.

# Learning Packs

> Plan of record: `learning-packs-2026-06-11` (shipped). Code anchors:
> `packages/operator-core/lib/learning-packs/`, `lib/memory/hive-scope.ts`,
> the `learning_packs:*` tool group, and the Cupboard worker migration 008.

A **learning pack** is a versioned, git-canonical set of *learnings* —
curated, project-transferable working wisdom. At hive creation the selected
pack (default: **`papercusp-default`**, 32 learnings) is **copied** into the
hive's own memory store; from then on the hive owns every row — editable,
deletable, growable — and every agent in every member harness recalls it.

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
  pack into a non-empty pool classifies every incoming learning
  (clean / duplicate / conflict — mem0 dedup + the P-017 conflict judge) and
  clashes require explicit per-item resolutions (keep existing · take
  incoming · keep both). Defaults skip clashes: existing content outranks the
  incoming pack.

## Where things live

| Piece                   | Location                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Built-in packs          | `libs/papercusp/packages/harness/learnings/<pack-id>/` (manifest.yaml + one-learning-per-file md)                                                                                                                                          |
| Comb-installed packs    | `~/.papercusp/learning-packs/<pack-id>/`                                                                                                                                                                                                   |
| A hive's live learnings | mem0 rows, scope `hive:<home-slug>`                                                                                                                                                                                                        |
| Pack mute state         | hive setting `learning-packs:disabled` (federated hive\_settings)                                                                                                                                                                          |
| Seeding                 | `hive:create` step 6b (flag `LEARNING_PACKS`, default ON; undo-stacked, best-effort)                                                                                                                                                       |
| Injection               | `buildMemoryContextBlock` — hive pool resolved member→hive via the registry's `hive_slug`; token-budgeted (\~4k default, `PAPERCUSP_MEMORY_INJECT_BUDGET_CHARS`), priority user > harness > hive-organic > hive-pack; muted packs filtered |

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
  upgrade / sweep / export / publish` (+ matching `/api/learning-packs/*`
  routes). `sweep` re-judges the whole pool for contradictions that emerge
  after install; `upgrade` adopts a newer version's NEW items only — present
  rows are never auto-touched.

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
