# Branding
URL: /internal/docs/branding

Visual identity assets, token packs, icon exports, and flag-gated The Swarm usage.

import { Aside } from '@astrojs/starlight/components';

Papercusp currently has two visual identity layers:

* **Classic Papercusp** is the default product identity and remains the active skin when `papercusp-the-hive` is off.
* **The Swarm** is a flag-gated visual layer for the bee lexicon and swarm-intelligence direction. It changes presentation assets, theme tokens, favicon, and labeled nouns only; it does not rename code identifiers, database rows, or tools.

The flag-on product-facing name is **The Swarm**. The implementation pack id remains `the-hive` for reversibility and because the user creates or joins a **Hive**; inside a Hive, many **Swarms** can run.

## Classic Identity

Classic assets stay in their existing locations and must not be overwritten by Hive work:

| Surface                     | Path                                                       |
| --------------------------- | ---------------------------------------------------------- |
| Operator logo component     | `apps/operator/app/_components/OperatorLogoMark.tsx`       |
| Operator wordmark component | `apps/operator/app/_components/OperatorWordmarkLockup.tsx` |
| Operator favicon/icon       | `apps/operator/app/icon.svg`                               |
| Public wordmark             | `apps/operator/public/wordmark.svg`                        |
| Desktop icon set            | `papercusp-desktop/src-tauri/icons/`                       |

## The Swarm Identity

The Swarm direction is engineered swarm intelligence: honey-amber signal color on charcoal, precise hex geometry, a primary bee-swarm mark for the app, and a distinct Queen mark for the brain.

| Asset                   | Path                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Primary mark            | `apps/operator/public/brand/the-hive/primary-mark.svg`                                                    |
| Primary monochrome mark | `apps/operator/public/brand/the-hive/primary-mark.mono.svg`                                               |
| Queen mark              | `apps/operator/public/brand/the-hive/queen-mark.svg`                                                      |
| Queen monochrome mark   | `apps/operator/public/brand/the-hive/queen-mark.mono.svg`                                                 |
| Wordmark                | `apps/operator/public/brand/the-hive/wordmark.svg`                                                        |
| Wordmark lockup         | `apps/operator/public/brand/the-hive/wordmark-lockup.svg`                                                 |
| Favicon                 | `apps/operator/public/brand/the-hive/favicon.svg` and `favicon.png`                                       |
| Comb motif              | `apps/operator/public/brand/the-hive/comb-motif.svg`                                                      |
| Lexicon icons           | `apps/operator/public/brand/the-hive/icons/*.svg`                                                         |
| Desktop icon pack       | `papercusp-desktop/src-tauri/icons/the-hive/` and `libs/papercusp/apps/desktop/src-tauri/icons/the-hive/` |
| React mark components   | `apps/operator/app/_components/HiveVisualIdentity.tsx`                                                    |

## Runtime Behavior

The Swarm skin is selected by `FLAGS.THE_HIVE` / `papercusp-the-hive`.

* Logo components switch from the classic cup marks to The Swarm primary mark via `useLexiconPackId()`.
* `HiveThemeBridge` forces `data-theme="honeycomb"`, sets `document.title` to the literal `HIVE_TITLE = 'The Swarm'`, and injects the Hive favicon while the flag is on.
* When the flag turns off, `HiveThemeBridge` restores the user’s saved active theme and the classic title `CLASSIC_TITLE = 'Papercusp Operator'`.
* The selectable Honeycomb theme is generated from the repo-root `design-tokens/honeycomb.semantic.tokens.json` into `apps/operator/app/_semantic.honeycomb.css` by the repo-root `npm run tokens` script (style-dictionary), which emits the CSS under the `[data-theme="honeycomb"]` selector.
* The legacy `hive` selector remains as an implementation-pack alias; new runtime usage should prefer `honeycomb`.
* The Swarm desktop icons are parallel exports only. `tauri.conf.json` still points to the classic icon set until packaging explicitly opts into the Swarm pack.

The flag-on `document.title`/wordmark renders `The Swarm`. EI-230 weighed this against D-005 (classic runtime titles) and D-007 (`Swarm` = deployment unit); the owner **resolved** it on 2026-06-10 (D-008 in `the-hive-lexicon-2026-06-06`, status: shipped): `The Swarm` is ratified as the product sub-brand, so `HIVE_TITLE` / `OperatorWordmarkLockup` stay pointed at `The Swarm` (deliberately **not** repointed to `The Hive`).

## Lexicon

The flag-on nouns are presentation-only:

| Classic concept                          | Flag-on term |
| ---------------------------------------- | ------------ |
| Project / deployable group               | Hive         |
| Live set of working agents               | Colony       |
| Brain / high-judgment orchestrator       | Queen        |
| Always-on operator                       | Sentinel     |
| AI agent                                 | Bee          |
| Human member                             | Keeper       |
| Unit of work                             | Cell         |
| Shared store                             | Comb         |
| Machine / deployment instance            | Swarm        |
| Agent signal / handoff (optional flavor) | Waggle       |
| Collaboration substrate                  | Hive Mind    |

The live agent collective is the **Colony** (term key `fleet`); **Swarm** (term key `node`) is the deployment-to-instance unit — a deployment of a Hive to a single machine. Owner revision D-007 (plan P-009) reassigned `Swarm` from the live-agent row to the deployment row and folded the earlier `Frame` machine/region term into `Swarm`. `Sentinel` was renamed from `Sentinel Bee` by owner directive 2026-06-09 (hive-agent-tabs P-003). The shaping icon file is still named `icons/sentinel-bee.svg`, but the lexicon term is `Sentinel`. This is consistent with the note above that, inside a Hive, many Swarms can run.

## Color Tokens

There are three distinct The Swarm color sources — do not conflate them:

* **Shipped Honeycomb theme tokens** — the values the selectable `honeycomb` theme actually emits at runtime, from `design-tokens/honeycomb.semantic.tokens.json` (muted honey, accent `#C68E24`). Documented in the table below.
* **SVG mark palette** — `HIVE_BRAND_COLORS` in `apps/operator/app/_components/HiveVisualIdentity.tsx` (honey `#F6B72F`, deep honey `#B97812`, cream `#FFF2C2`). These are the colors the brand SVGs (`primary-mark.svg`, `queen-mark.svg`, `favicon.svg`) actually render with.
* **Prototype demo palette** — the brighter `#EAB308`/`#FDE68A` honey used only in the `/dev/swarm-logos` exploration page (`swarm-logos.module.css`). Not a runtime theme.

The shipped Honeycomb token pack is dark-first and WCAG-oriented (values are the runtime CSS variables emitted under `[data-theme="honeycomb"]`):

| Token              |     Value | Use                       |
| ------------------ | --------: | ------------------------- |
| Background         | `#070704` | app shell base            |
| Deepest background | `#030303` | maximum depth             |
| Popover surface    | `#11100B` | cards and elevated panels |
| Raised surface     | `#15130B` | elevated chrome           |
| Text               | `#F4EBD4` | primary foreground        |
| Muted text         | `#9F9378` | secondary foreground      |
| Primary accent     | `#C68E24` | muted honey action color  |
| Strong accent      | `#D6A64A` | hover/focus accent        |
| Accent ink         | `#130D03` | text on honey             |

Semantic colors remain distinct from the primary honey accent: success green (`#68D391`), danger rose (`#E06F69`), and warning honey (`#D6A64A`).

## Motif Rules

Use hexagons as layout structure, not wallpaper. The comb motif works for background texture, dividers, empty states, and swarm/loading states when it is low-contrast and aligned to the UI grid.

Do not use cartoon bees, playful yellow-on-white compositions, or random honeycomb decoration. The Swarm should feel like an engineered distributed system.

## Preview And Exports

* Preview the system at `/dev/operator-logo` in the operator app.
* Editable SVG and raster export notes live in `apps/operator/public/brand/the-hive/README.md`.
* Regenerate theme CSS with `npm run tokens` after editing token JSON.
* Rebuild docs with `cd apps/operator-docs && npm run build` after changing this page so `apps/operator/public/internal/docs/` is refreshed.
