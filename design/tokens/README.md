# Design tokens (DTCG)

Token store for the design phase. Read by:

- The design-phase plugin's `list_tokens` / `read_token` MCP tools
  (designer + implementer agents)
- The Token inventory pane in the design tab
- (future) `papercusp-design-react-tailwind`'s `tokens.emit()` for
  CSS vars + Tailwind preset codegen

## Files

- `base.json` — canonical token store. Hand-curated, semantically
  named (`color.bg.surface`, `space.md`, …). Edit this one.
- `seeded-from-harness-css.json` — seed produced by the
  `seed-dtcg-from-css.mjs` script (plan §17.5 step A). NOT a final
  store; its keys mirror the original CSS var names. Use as input to
  the human-driven semantic rename pass (step B).

## Workflow (plan §17.5)

```
       ┌────────────────────────┐
       │ harness.css            │
       └──────────┬─────────────┘
                  │  step A
                  ▼
       ┌────────────────────────┐
       │ seeded-from-           │
       │   harness-css.json     │  (technical names: h.topbar.surface)
       └──────────┬─────────────┘
                  │  step B (human / agent semantic rename)
                  ▼
       ┌────────────────────────┐
       │ base.json              │  (semantic: color.bg.elevated)
       └──────────┬─────────────┘
                  │  step C
                  ▼
       generated CSS vars + Tailwind preset
                  │  step D
                  ▼
       Lost Pixel verifies no regression
```

Step A is automated. Step B is the design judgment call — no tool
replaces it. Steps C & D are deferred until the React-Tailwind
adapter's `tokens.emit()` is wired into the operator's build.

## Running the seeder

```sh
node apps/operator/scripts/seed-dtcg-from-css.mjs \
  apps/operator/app/harness/harness.css \
  libs/papercusp/apps/web/app/harness/harness.css \
  --out=design/tokens/seeded-from-harness-css.json --force
```

Stats are printed to stderr. For the operator harness today: ~42
unique custom properties produced from ~391 declarations across the
two harness.css files (most are color values; many are
re-declarations across light/dark/responsive scopes).

## Editing `base.json`

Strict DTCG: every leaf has `$type` and `$value`. Groups have
neither. Mixing is invalid (the seeder pushes leaf-with-children to
`.default` to handle this).

Allowed `$type` values: `color`, `dimension`, `duration`,
`fontFamily`, `fontWeight`, `number`, `shadow`, `cubicBezier`. See
the design-phase plugin's IR schema for the canonical list.
