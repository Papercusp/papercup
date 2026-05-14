# TESTING — @papercusp/docs

Standalone Fumadocs build serving the public docs at `:3070` *while the Tauri dev shell is running*. The standalone webapp path is retired (2026-05-14); to bring up the docs site for verdict checks, launch the Tauri dev shell first:

```bash
cd /home/marsh-office/papercupai-workspace/papercusp-desktop && npm run dev
```

The content source is shared with the operator via Pattern A (see `project_fumadocs_pattern_a.md`).

## What this project's tests cover

- (none) — content correctness is verified by:
  - Operator's TypeScript build (the same `content/docs/**` tree
    type-checks via Fumadocs' `.source/` types).
  - `verdict` smoke against `:3070` for visual rendering (Tauri dev shell must be running).

## What they don't cover

- Markdown link integrity across docs — there's no automated check.
  Phase 5 candidate: a `lychee` link-checker job in nightly CI.
- Search index quality — verified manually.

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| `content/docs/**` markdown          | rebuild operator: `cd apps/operator && npm run build` (Pattern A shares source) |
| Layout / navigation                 | launch Tauri dev (above) and visual smoke at `:3070`  |
| Anything visible to users           | Tauri dev + `verdict` against `http://localhost:3070/docs` |

See repo-root `CLAUDE.md` and `apps/operator/content/docs/testing/` for the full strategy.
