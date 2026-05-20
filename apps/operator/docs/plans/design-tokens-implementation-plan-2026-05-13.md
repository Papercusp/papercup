# DTCG Migration & Cross-Platform Design Unification — Implementation Plan

Status: **Approved 2026-05-13**. Decisions taken on all 5 open questions (defaulted to leans).

## Goals
1. One DTCG-compliant token schema across desktop, Android, iOS, and the harness design-adapter spine.
2. Brand palette as single source of truth.
3. Per-app freedom for semantic + component layers.
4. Schema-compatible with the harness `design-adapter` spine.

## Non-Goals
- 1:1 token parity between desktop and mobile
- Replacing the harness's React+Tailwind adapter
- Theming variants (light/dark/brand)
- Tokenizing gradients/shapes/animation primitives
- Any visual change — purely a refactor

## Architecture

```
papercupai-workspace/
├── papercup/
│   ├── design-tokens/
│   │   ├── primitives.tokens.json         (palette only; ~50 tokens)
│   │   ├── desktop.semantic.tokens.json   (--accent → {color.sky.400})
│   │   ├── desktop.component.tokens.json
│   │   ├── README.md
│   │   └── style-dictionary.config.mjs
│   ├── apps/operator/app/
│   │   ├── _brand-primitives.css          (GENERATED)
│   │   ├── _semantic.css                  (GENERATED)
│   │   └── globals.css                    (uses var(--sky-400))
│   └── package.json                       (+style-dictionary ^4)
│
└── papercup-rust-mobile/
    ├── design-tokens/
    │   ├── primitives.tokens.json         (MIRRORED, hash-pinned)
    │   ├── mobile.semantic.tokens.json
    │   ├── mobile.component.tokens.json
    │   ├── mirror.mjs
    │   ├── style-dictionary.config.mjs
    │   └── README.md
    ├── android/.../PapercupTokens.kt      (GENERATED)
    ├── ios/.../PapercupTokens.swift       (GENERATED)
    └── package.json                       (+style-dictionary ^4)
```

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Canonical source location | `papercup/design-tokens/` |
| 2 | CSS var naming | Keep existing names (`--accent`, `--good`, `--bad`) |
| 3 | Mobile theme override files | Keep — useful indirection for gradients/shapes |
| 4 | Designer-agent integration | Defer to Phase 5 |
| 5 | Codegen tool | Style Dictionary v4 |

## Phases

### Phase 1 — Mobile DTCG migration (~45 min)
- Convert mobile `tokens.json` → DTCG (`$value`/`$type`, 8-digit hex, no `alpha` field)
- Split into primitives/semantic/component
- Add `style-dictionary` v4 devDep
- Replace custom `build.mjs` with SD config
- Update Make targets
- Verify pixel-identical output

### Phase 2 — Desktop primitives extraction (~60 min)
- Audit `globals.css` for brand-palette hex values
- Create `primitives.tokens.json` + `desktop.semantic.tokens.json`
- Add `style-dictionary` v4 to desktop, emit `_brand-primitives.css` + `_semantic.css`
- Add `pnpm tokens` script + regen-on-commit hook
- Do NOT modify `globals.css` yet

### Phase 3 — Desktop globals.css → primitives (~45 min)
- `@import` the generated CSS files at top of `globals.css`
- Replace hardcoded hex with `var(--sky-400)` etc.
- Visual diff confirms pixel-identical

### Phase 4 — Mobile mirrors canonical (~30 min)
- `mirror.mjs` rsyncs primitives from `papercup/`, fails on hash drift
- Run at build start
- CI override via `PAPERCUP_DESIGN_TOKENS_DIR` env

### Phase 5 (deferred) — Harness adapter unification (~2 hr, harness team)
- Wrap harness's in-house emitter around SD
- Wire harness Design tab "Tokens" pane to canonical store
- Designer-agent integration in `lib/design-spec/designer-prompt.ts`

## Risks & Mitigation

| Risk | Mitigation |
|---|---|
| CSS rounding diffs Phase 3 | Snapshot + freeze with 8-digit hex if needed |
| SD v4 Compose output gaps | Fall back to custom emitter for Kotlin only |
| Mirror breaks CI | `PAPERCUP_DESIGN_TOKENS_DIR` env override |
| Mobile npm dep concerns | Dev-only, build-time, no runtime cost |
| Tailwind shade naming gaps | Allow custom names (`--ink-popover`) for non-Tailwind values |

## What This Buys

1. One file edits brand colors across all surfaces
2. Cross-platform drift caught at build (hash check)
3. DTCG ecosystem unlocked (Tokens Studio, Figma, Specify, etc.)
4. Harness designer agents can eventually target mobile
5. Per-app theme freedom preserved
