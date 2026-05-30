# Design tokens — the bluefrost theme
URL: /internal/docs/design/tokens

How the DTCG token pipeline generates the bluefrost CSS variables, the semantic scale, and the canonical status-color tables.

import { Aside } from '@astrojs/starlight/components';

The operator UI is themed by a single set of CSS custom properties — the
**bluefrost** palette (deep sky-tinted dark surfaces, frost-white text, a sky
accent). Those variables are **generated from DTCG token JSON**, not written by
hand. This page is the reference for what exists and how to change it.

`apps/operator/app/_brand-primitives.css` and `apps/operator/app/_semantic.css`
both start with `/** Do not edit directly, this file was auto-generated. */`.
Edit the token JSON and re-run the build — a hand edit is overwritten on the
next `pnpm tokens`.

## The pipeline

```
design-tokens/*.tokens.json        ← source of truth (DTCG)
        │  pnpm tokens  (Style Dictionary v4 — design-tokens/style-dictionary.config.mjs)
        ▼
apps/operator/app/_brand-primitives.css   ← primitives tier  (--sky-400, --emerald-400, …)
apps/operator/app/_semantic.css           ← semantic tier    (--bg, --fg, --accent, …)
        │  imported at the top of
        ▼
apps/operator/app/globals.css      → every operator + /adv surface
```

Source files under `design-tokens/`:

| File                           | Tier      | What it holds                                                                                                                     |
| ------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `primitives.tokens.json`       | primitive | Raw brand palette — `sky` / `emerald` / `amber` / `gold` / `rose` / `slate`. Canonical for **all** platforms (mobile mirrors it). |
| `desktop.semantic.tokens.json` | semantic  | Desktop `--bg` / `--fg` / `--accent` / `--warn` etc., aliased to primitives.                                                      |
| `desktop.motion.tokens.json`   | semantic  | `--ease-*` / `--dur-*` easing + duration tokens.                                                                                  |
| `style-dictionary.config.mjs`  | build     | SD v4 config that emits the two CSS files.                                                                                        |

Regenerate after editing any token JSON (the dev server does **not** auto-run it):

```bash
pnpm tokens     # re-emit _brand-primitives.css + _semantic.css
```

If you change a **primitive** (a brand color), also re-mirror mobile
(`make tokens` in `papercup-rust-mobile/`). Changing only a desktop **semantic**
needs no mobile touch. Full guide: `design-tokens/README.md`.

## The bluefrost semantic scale

These are the variables new UI should use — never a raw hex. Each has a fallback
baked in (`var(--bg, #07101d)`) so a component renders correctly even outside the
themed tree.

| Token                                        | Value                               | Use for                                                                                          |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `--bg`                                       | `#07101d`                           | Page / app background (deepest).                                                                 |
| `--bg-1`                                     | `#0b1220`                           | Panel background — one step up from the page.                                                    |
| `--bg-2` `--bg-3` `--bg-4`                   | translucent white 4.5% / 7.5% / 12% | Surface tiers: inputs, chips, hover, raised.                                                     |
| `--bg-popover`                               | `#0d1829`                           | Solid elevated surface for menus / hover cards / popovers.                                       |
| `--fg`                                       | `#e7f7ff`                           | Primary text.                                                                                    |
| `--fg-dim`                                   | `#b9d4e8`                           | Secondary text.                                                                                  |
| `--fg-mute`                                  | `#7f9bb4`                           | Tertiary / metadata text.                                                                        |
| `--border` `--border-strong`                 | sky-300 @ 0.15 / 0.32               | Hairline / emphasized borders (sky-tinted, the bluefrost signature).                             |
| `--accent` `--accent-strong` `--accent-cool` | sky-400 / sky-300 / sky-cool        | Interactive accent, hover, soft accent.                                                          |
| `--accent-ink`                               | `#051827`                           | Text **on** an accent-filled background.                                                         |
| `--good` `--warn` `--bad`                    | emerald / amber / rose              | Semantic status (success / warning / danger).                                                    |
| `--warn-bg` `--warn-border`                  | amber @ 0.1 / 0.35                  | Warning banner fill + border.                                                                    |
| `--ease-out` `--dur-fast` …                  | see `_semantic.css`                 | Motion — pair with `[data-anim]` per the [performance rules](/internal/docs/design/performance). |

**Tinting pattern.** Derive accent washes with `color-mix` rather than a new
hardcoded rgba — it tracks the accent automatically:

```css
background: color-mix(in oklab, var(--accent), transparent 86%); /* selected row */
border-color: color-mix(in oklab, var(--accent), transparent 55%);
```

## Status colors — one canonical source

Per-status coloring (feature status, issue severity, issue status) is **not** a
per-component decision. It lives in three Proxy-guarded tables in
`apps/operator/app/harness/theme.ts` and is rendered through the pills in
`apps/operator/app/harness/primitives.tsx`:

| Table          | Keys                                                                                    | Pill                             |
| -------------- | --------------------------------------------------------------------------------------- | -------------------------------- |
| `STATUS`       | `todo` · `in_progress` · `validating` · `failing` · `blocked` · `passed` · `deprecated` | `<StatusPill status={…} />`      |
| `SEVERITY`     | `critical` · `major` · `minor` · `nit`                                                  | `<SeverityPill severity={…} />`  |
| `ISSUE_STATUS` | `open` · `acknowledged` · `fixing` · `closed` · `wontfix`                               | `<IssueStatusPill status={…} />` |

Each entry is `{ solid, bg, text, label }`. The hues are semantic (red →
amber → sky → grey for severity, etc.) and chosen to read on the bluefrost dark
surfaces — `SEVERITY.minor` uses the sky accent rather than a legacy yellow to
stay on-theme. The same tables back the legacy `/harness` route, so `/adv` and
`/harness` show identical status coloring.

**Do** reach for a `var(--…)` semantic token and the `STATUS`/`SEVERITY`/`ISSUE_STATUS`
pills. **Don't** declare a local `STATUS_TONE` / `SEVERITY_TONE` map or a raw hex
in a component — that's the exact drift this single source exists to prevent
(three divergent copies had crept into the `/adv` Harness panels before the
2026-05-30 redesign consolidated them).

## See also

* [Library reference](/internal/docs/design/libraries) — the component wrappers (`StatusPill`, `Tooltip`, `Select`, `RichGrid`, …) that consume these tokens.
* [Design — UI library guide](/internal/docs/design) — the hard rules for which library to reach for.
* `design-tokens/README.md` — the full token-editing + mobile-mirror workflow.
