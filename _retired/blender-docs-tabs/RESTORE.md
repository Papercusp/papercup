# Restoring the Blender + Docs left-rail tabs

**Retired 2026-07-26** — `agents-system-pane-split-2026-07-26` P-006.

## Why they went

They were not deleted for being broken. They were **dissolved into a better axis**.

Both were thin wrappers (24 and 32 lines) around `AutomationPane`, each claiming a
*subject* category — `learning` for Blender, `docs` for Docs. The owner's question on
2026-07-26 was:

> "Is everything in the agents tab an llm? its an 'agents' tab, only the actual llm
> runs should show there, other things that run in a schedule lets make a new tab for
> all the routines that are deterministic. lets move the blender and docs tab routines
> in these 2 llm and deterministic tab split and categorize them."

Subject was never the axis that mattered. "Does a fire of this bill a model?" was —
and it cuts straight through both panes:

| former pane | row | now lives in |
|---|---|---|
| Blender | `bp-singleton-*` (15), `improvement-*` (5), `gym-cycle`, `pot-eval-battery` | **Agents** (`spend: llm`) |
| Docs | `doc-steward-dispatch` | **Agents** (`spend: llm`) |
| Docs | `knowledge-pack-delivery`, `knowledge-pack-hygiene` | **System** (`spend: none` — it is packaging, not authoring) |
| Docs | `doc-freshness-sweep` | **System** (`spend: none` — a sha comparison, explicitly free) |

The Blender's **Arming (spend gates)** section was not lost: it moved into the Agents
pane, which is where the things it gates now live. It renders only for `lens === 'llm'`.

Nothing is unreachable. The two lenses partition the whole catalog by construction
(`spend !== 'none'` vs `spend === 'none'`), which is a stronger guarantee than the
category-per-pane wiring these tabs used — that wiring is exactly how `infra` once
ended up claimed by no pane at all, hiding 40 routines, 39 of them active.

## What was removed

- `apps/operator-vite/src/components/left-sidebar/BlenderTab.tsx` → here
- `apps/operator-vite/src/components/left-sidebar/DocsTab.tsx` → here
- their two `TABS` entries + lazy imports in `LeftSidebar.tsx`
- the `Blend` / `FileText` lucide imports that served only those entries

The tab **ids** `blender` and `docs` are retired with them. A stale `?lst=blender`
deep link falls through to the default tab rather than resolving.

## How to restore

1. `git mv` both files back to `apps/operator-vite/src/components/left-sidebar/`.
2. Re-add the lazy imports and their `TABS` entries in `LeftSidebar.tsx`, plus the
   `Blend` and `FileText` icon imports.
3. **They will not compile as-is.** `AutomationPane`'s props changed: `categories:
   readonly AutomationCategory[]` became `lens: 'llm' | 'system'`. A restored
   subject-scoped pane needs either a third lens or a `categories` prop added back
   alongside `lens`.
4. `AutomationCategory` and `classifyRoutine` are still live in
   `lib/automation/catalog.ts` and still populate `AutomationRoutine.category`, so the
   subject grouping a restored pane would filter on has not gone anywhere.

Before restoring, consider the **browse-by-family view** already inside
`AutomationPane` (the header's "By family" toggle) — it groups by
`RoutineFamily` (`learning`, `docs`, `loops`, `wake`, …), which is the same subject
grouping these tabs provided, without spending two rail slots on it.
