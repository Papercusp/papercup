# Running harnesses on Hetzner

The papercupai.com production box can now run the autonomous harness
runtime end-to-end. Phase 1 (this doc): a harness can be invoked one role
at a time via the operator API, with claude calling claude.ai over OAuth.
Phase 2 (deferred): a persistent run-loop service per harness.

## What's baked into the operator image

| Component | Path | Purpose |
|---|---|---|
| `claude` CLI | `/usr/local/bin/claude` | Every role spawns it. OAuth from mounted creds. |
| `gh` CLI | `/usr/bin/gh` | GitHub-side ops (PRs, comments). Token mount. |
| `papercusp` CLI | `/usr/local/bin/papercusp` | Plugin host + harness orchestrator wrapper. |
| `tsx` | global npm | Used by the papercusp wrapper script. |
| `git`, `bash`, `python3`, `psql`, `jq`, `curl`, `ripgrep` | std PATH | run.sh + plugin hook helpers shell out. |
| Harness substrate | `/opt/harness` | Copy of `libs/papercusp/packages/harness` — run.sh + prompts + templates. `PAPERCUSP_HARNESS_DIR` points here. |
| node-pty native | `node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node` | Required for the operator's PTY routes; explicit COPY because Next's tracer skips `.node` files. |

## Why debian-slim, not alpine

`@lydell/node-pty-linux-x64` ships only a glibc prebuild. On alpine (musl)
the operator 500s every harness route with
`Cannot find module './prebuilds/linux-x64/pty.node'`. We switched the
runner stage to `node:20-bookworm-slim`. Image is ~1 GB, vs ~250 MB on
alpine, but the entire harness stack works without rebuild dances.

## Auth: claude OAuth

The local laptop's `~/.claude/.credentials.json` is staged at
`/opt/papercup-data/claude-credentials.json` on the Hetzner host (mode 0600)
and mounted read-only into the operator container at
`/root/.claude/.credentials.json`. `claude auth status` reports `loggedIn:
true`. Same identity as the local box — billing and rate limits converge.

> **Rotation note.** The OAuth tokens in this file appeared in chat
> transcripts during deploy iteration. Run `claude auth login` on the
> local box to mint fresh tokens, then re-stage the file:
>
> ```sh
> scp ~/.claude/.credentials.json root@178.156.253.226:/opt/papercup-data/claude-credentials.json
> ssh root@178.156.253.226 'chmod 0600 /opt/papercup-data/claude-credentials.json && \
>   docker compose -p papercup -f /opt/papercup-wip/docker-compose.papercup.prod.yml restart operator'
> ```

`ANTHROPIC_API_KEY` is also wired in compose as an optional fallback —
unset by default; set it in `.env.papercup.production` if you want
API-key auth instead of OAuth.

## Verifying

```sh
ssh root@178.156.253.226 'docker exec papercup-operator-1 sh -c "
  claude --version
  papercusp doctor 2>&1 | head -10
  curl -sS -X POST -H content-type:application/json \
    -d \"{\\\"role\\\":\\\"orchestrator\\\",\\\"actor\\\":\\\"human:smoke\\\"}\" \
    http://127.0.0.1:3055/api/harness/papercup-coding/invoke
"'
```

Expected: `claude --version` returns `2.1.126 (Claude Code)`. The invoke
returns a JSON envelope with `decisionLine` populated by the orchestrator
prompt (it'll either dispatch to a real role or, if SPEC.md is empty, end
with `did not produce required artifacts`).

## Phase 2 — continuous run loop (deferred)

Currently every role invocation is one HTTP POST to
`/api/harness/:slug/invoke`. To run a harness *autonomously* you need
something keeping the loop fired. Three options, in increasing complexity:

### A. systemd-equivalent inside the operator container

Add a runtime CMD that wraps both the Next server and a `papercusp run
<slug>` per registered harness. Bad: tightly couples runtime lifecycles;
killing one harness restarts the operator.

### B. Sidecar `harness-runner-<slug>` containers (recommended)

For each long-lived harness, add a service to compose:

```yaml
runner-papercup-coding:
  image: operator:latest          # same image; reuses tooling
  restart: unless-stopped
  command: ["papercusp", "run", "papercup-coding"]
  environment:
    PAPERCUSP_HARNESS_DIR: /opt/harness
    HARNESS_DATABASE_URL: ${HARNESS_DATABASE_URL}
    PAPERCUP_PAPERCUSP_UPSTREAM: http://operator:3055
  volumes:
    - /opt/papercup-data/projects:/papercusp-projects
    - /opt/papercup-data/claude-credentials.json:/root/.claude/.credentials.json:ro
  networks: [coolify, restart_internal]
  depends_on: [operator]
```

Logs are per-harness (`docker logs papercup-runner-papercup-coding-1`).
Each runner can be restarted independently. This is the path I recommend
when you're ready to flip a harness from local-box-driven to fully
autonomous on Hetzner.

### C. Separate worker pool with k8s job semantics

Overkill for current scale; only worth doing if 20+ harnesses run
concurrently or you need spot-instance preemption.

## Switching a harness from local→Hetzner

Once Phase 2 is in place for a given slug:

1. **Stop the local runner**: `papercusp stop <slug>` on the laptop (or kill
   the `papercusp run <slug>` process).
2. **Verify state in Postgres** matches what's expected — replication should
   have caught up. Check `harness_<slug>.harness_features` count via psql.
3. **Deploy the runner sidecar** for that slug on Hetzner.
4. **Drop the slug from `papercup_mirror`** publication on local (so the now-
   authoritative Hetzner data isn't overwritten by the laptop snapshot):
   ```sql
   ALTER PUBLICATION papercup_mirror DROP TABLE harness_<slug>.harness_features,
     harness_<slug>.harness_issues, harness_<slug>.harness_proposals,
     harness_<slug>.harness_snapshots, harness_<slug>.agent_runs,
     harness_<slug>.feature_audit;
   ```
   Then on Hetzner: `ALTER SUBSCRIPTION papercup_from_local REFRESH PUBLICATION;`
5. **Watch papercupai.com** for the harness's live counts continuing to update.

When *all* harnesses have moved to Hetzner runners, drop the subscription +
publication + tunnel + autossh systemd unit entirely. Hetzner becomes
authoritative; local box is just a developer machine.

## What's still rough

- `gh` CLI auth: the bundled `gh auth login` flow needs a keyring; on the
  bare debian image there's no dbus. Workaround: `gh auth login --with-token
  < /root/.config/gh/gh-token.txt`. The current mount ships a `hosts.yml`
  but `gh` may still prompt under some flows. If a harness needs gh auth,
  test before declaring done.
- `papercusp doctor` still flags postgres unreachable because it probes
  `harness_app@localhost` instead of reading `HARNESS_DATABASE_URL`.
  Cosmetic — actual harness DB writes go through libs/db/connection.ts
  which honors the env. Worth fixing in papercusp.ts:doctor() but not
  blocking.
- `@papercusp/export-state` import error in `papercusp doctor`'s snapshot
  binary probe. Snapshot binaries unused for now; this surfaces only as a
  warning line.
