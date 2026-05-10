# TESTING — @papercusp/docs

Standalone Fumadocs build serving the public docs at `:3070`. The
content source is shared with the operator via Pattern A (see
`project_fumadocs_pattern_a.md`).

## What this project's tests cover

- (none) — content correctness is verified by:
  - Operator's TypeScript build (the same `content/docs/**` tree
    type-checks via Fumadocs' `.source/` types).
  - `verdict` smoke against `:3070` for visual rendering.

## What they don't cover

- Markdown link integrity across docs — there's no automated check.
  Phase 5 candidate: a `lychee` link-checker job in nightly CI.
- Search index quality — verified manually.

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| `content/docs/**` markdown          | rebuild operator: `cd apps/operator && npm run build` (Pattern A shares source) |
| Layout / navigation                 | `npm run dev --workspace @papercusp/docs` and visual smoke |
| Anything visible to users           | manual: `verdict` against `http://localhost:3070/docs` |

See repo-root `CLAUDE.md` and `apps/operator/content/docs/testing/` for the full strategy.
