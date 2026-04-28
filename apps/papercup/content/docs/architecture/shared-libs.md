---
title: Shared component libraries
description: Four libs at libs/* are shared between the Restart admin app and the Papercup public site. Three are git submodules; one is a regular workspace package.
---

The Papercup admin UI (inside Restart) and the [papercupai.com](https://papercupai.com) public site render from the **same component code**. There is no fork — both apps consume the same source via npm workspace packages, three of which are git submodules so their content lives in standalone repos.

## The four shared libs

| Lib | Path | Source | Purpose |
|---|---|---|---|
| `@restart/papercup-shared` | `libs/papercup-shared/` | In-repo workspace | View tree shared between admin and public — `PapercupTabs`, `OrganizationView`, `DirectivesView`, `ProjectsView`, `TimelineView`, `BriefingsView`, `DocumentationFrame`. |
| `@restart/git-graph` | `libs/git-graph/` | Submodule → [`papercupai/git-graph`](https://github.com/papercupai/git-graph) | Git commit graph: `GitGraphPanel`, `CommitNode`, `CommitDetail`, `graphLayout`, `cache`, plus `git-graph.css`. |
| `@restart/agent-chat` | `libs/agent-chat/` | Submodule → [`papercupai/agent-chat`](https://github.com/papercupai/agent-chat) | Assistant-ui-based agent chat: `HarnessChat`, `useHarnessChatRuntime`, `PatchBlock`, `PromoteBlock`. |
| `@restart/ui-primitives` | `libs/ui-primitives/` | Submodule → [`papercupai/ui-primitives`](https://github.com/papercupai/ui-primitives) | Generic UI primitives: `Panel`, `StatCard`, `StatusPill`, `LogView`, `MarkdownView`, `JsonTree`. |

All three submodules live under the [`papercupai`](https://github.com/papercupai) GitHub account as **private** repos.

## Why submodules

The same source files used to live inline:

- `apps/web/app/harness/_ui/`        → now `@restart/ui-primitives`
- `apps/web/app/harness/chat/`       → now `@restart/agent-chat`
- `libs/git-graph/` (untracked)      → now `@restart/git-graph`

When `apps/public-site/` was carved out as its own repo (so papercupai.com could be deployed from a slim public source tree without leaking the rest of Restart), these libraries became things that had to exist in **two places**. We had three options:

1. **Duplicate the source** — fork drift would erode the "same code on both" guarantee.
2. **Publish as private npm packages** — versioning overhead, npm registry coupling, scoped tokens.
3. **Git submodules** — chosen. Each lib has its own repo + history; both consuming apps add it as a submodule at `libs/<name>/`. Workspace resolution does the rest.

`papercup-shared` is NOT a submodule (yet) because at the time of extraction it lived only in `apps/public-site/libs/papercup-shared/` and predates the submodule pattern. It's still consumed via the same `@restart/papercup-shared` package name; it just lives inside each consuming repo as a regular directory. May be migrated later for symmetry.

## How both apps consume them

In `~/Restart` (admin):

```
package.json: workspaces = ["apps/*", "libs/*"]
.gitmodules:
  [submodule "libs/git-graph"]    url = github.com/papercupai/git-graph.git
  [submodule "libs/agent-chat"]   url = github.com/papercupai/agent-chat.git
  [submodule "libs/ui-primitives"] url = github.com/papercupai/ui-primitives.git

apps/web/package.json:
  "@restart/git-graph": "*"
  "@restart/agent-chat": "*"
  "@restart/ui-primitives": "*"
```

In `~/papercup-public-site` (public):

```
package.json: workspaces = ["apps/public-site", "libs/papercup-shared", "libs/git-graph", "libs/agent-chat", "libs/ui-primitives"]
.gitmodules:
  same 3 submodules

apps/public-site/package.json:
  same 3 deps as above (plus other npm deps for the harness UI: monaco, blocknote, etc.)
```

The submodule SHAs are pinned per consumer. So Restart and Papercup-public can be on different versions of a shared lib if needed; usually they track the same commit.

## Working in a shared lib

The cardinal rule: **edit the submodule, not the consuming app.**

If you want to change `Panel`, `HarnessChat`, `GitGraphPanel`, or any other component owned by a submodule, the lifecycle is:

```sh
# 1. From either consuming repo, cd into the submodule
cd ~/Restart/libs/ui-primitives             # or ~/papercup-public-site/libs/ui-primitives

# 2. The submodule has its own git history; branch + edit
git checkout -b feat/your-change
# ... make edits ...
git add -A
git commit -m "Whatever change"
git push -u origin feat/your-change

# 3. Merge to main (PR or direct, your call)
git checkout main && git merge feat/your-change && git push

# 4. Back in the consuming repo, bump the submodule pointer
cd ../..
git add libs/ui-primitives
git commit -m "Bump ui-primitives to <new-sha>"
git push
```

If you edit files inside `libs/<submodule>/` and try to commit them in the consuming repo, the consuming repo will report a "dirty submodule" — the changes won't propagate. Always commit inside the submodule's own git history first.

## Pulling someone else's submodule update

```sh
cd ~/papercup-public-site                    # or ~/Restart
git submodule update --remote --merge libs/ui-primitives
git add libs/ui-primitives
git commit -m "Sync ui-primitives" && git push
```

For the public site, the push triggers a Cloudflare Workers Build — papercupai.com auto-deploys with the new code in ~90s.

## Consumers in code

`HarnessDashboard.tsx` in both apps imports from all three submodule packages:

```ts
import { Panel, StatCard, StatusPill, LogView, MarkdownView, JsonTree } from '@restart/ui-primitives';
import { preloadGitLog } from '@restart/git-graph';
const GitGraphPanel = dynamic(() => import('@restart/git-graph').then((m) => ({ default: m.GitGraphPanel })));
```

`ArchitectChat.tsx` and `brainstorm/BrainstormChat.tsx`:

```ts
import { HarnessChat, type ActionBlock } from '@restart/agent-chat';
import { PatchBlock } from '@restart/agent-chat';
```

The CSS for the git graph is imported once in each app's root layout:

```ts
import '@restart/git-graph/git-graph.css';
```

## Auth

The 3 submodule repos are private. To clone fresh, your local `gh` (or git credentials) must be authenticated as a user with read access to the `papercupai` org/account. Use `gh auth login` and pick the GitHub account that has access.
