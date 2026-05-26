---
title: Papercusp dogfood — Phase 9 (Cupboard + Discord + sync-with-main)
slug: papercusp-dogfood-phase9-cupboard-discord-sync-2026-05-24
created: 2026-05-24
updated: 2026-05-25
status: draft
---

# Papercusp dogfood — Phase 9 (Cupboard + Discord + sync-with-main)

## Now

**State:** **🟢 CODE-COMPLETE.** Only P-051b deploy remains (user step).

Shipped 2026-05-24: P-052 (Cupboard UI), P-054 (Discord deep-link + webhook), P-055 (sync-with-main badge + dialog).

Shipped 2026-05-25 (this loop):
- **P-051a** Cupboard server at `apps/operator-public/` — Hono on Cloudflare Workers + D1. 18/18 tests. D-001 records the Workers+D1 vs Next.js+PG infra call.
- **P-076** hourly stats indexer at `apps/operator-public/src/indexer.ts` — refreshes tier-A fields from GitHub API; 404 → auto-unlist; 429 → early-exit; batch-capped; audit row per run. 14/14 tests.
- **P-053** ShareWizard shared-public → Cupboard publish: client hook in ShareWizard step 9 + operator proxy route at `/api/harness/cupboard/publish`. The wizard POSTs to the operator; the operator forwards to Cupboard with the user's gh-token added server-side (browser never holds the token). Publish failure → inline 'publish later' warning; local finalize still succeeds. 10/10 wizard tests + 15/15 proxy-route tests.

**Next action:** **P-051b deploy is a user step.** Sequence in `apps/operator-public/README.md`:
  1. `wrangler d1 create papercusp-cupboard` + `wrangler kv:namespace create papercusp-cupboard-counters`; paste returned ids into wrangler.toml
  2. `npm run d1:apply:remote` (initial schema)
  3. `wrangler secret put GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / IP_HASH_PEPPER`
  4. DNS for chosen hostname + Cloudflare Workers route binding
  5. `npm run deploy`
  6. `echo 'PAPERCUSP_CUPBOARD_URL="https://<hostname>"' >> ~/.papercusp/env`

Cron is wired in wrangler.toml (`0 * * * *`); the indexer runs as soon as deploy lands.

## Background

Phase 9 implements `## Phase 9 — Cupboard + Discord + sync-with-main [L]` from v5 (~line 1271). The Cupboard server is a NEW deployable; this is the first phase that ships infrastructure outside the desktop operator.

**Gate:** Phase 7 complete (PR data shape stable for Cupboard listing extraction); Phase 1b P-068 complete (canonical binding service — Cupboard server extends it).

## Phase tasks

### P-051a — Cupboard server schema + auth + endpoints [M]

v5 §10.1-10.3 + addendum 1: extends Phase 1b binding service with public-listing schema, GitHub OAuth, rate-limit + report endpoints.

**Files (new app):**
- `apps/operator-public/` — new Next.js app, separate from desktop operator.
- `apps/operator-public/lib/cupboard-schema.sql` — `harnesses`, `reports`, `publish_rate_limit` per v5 §10.2.
- `apps/operator-public/app/api/harnesses/route.ts` — `POST /harnesses` (publish), `GET /harnesses` (list).
- `apps/operator-public/app/api/harnesses/[id]/route.ts` — `DELETE /harnesses/:id` (unlist).
- `apps/operator-public/app/api/reports/route.ts` — `POST /reports`.
- `apps/operator-public/app/api/binding/route.ts` — extends Phase 1b binding service for public lookup.

**Sub-acceptances:**
- **P-051a-1** — Publish (`POST /harnesses`): GitHub OAuth required; rate-limited at 5/hr per `github_user_id`; rejects private GitHub repos.
- **P-051a-2** — List (`GET /harnesses`): public, no auth, paginated.
- **P-051a-3** — Unlist (`DELETE`): only by original publisher OR Cupboard operator (on resolved abuse report).
- **P-051a-4** — Reports (`POST /reports`): GitHub OAuth; reporter identity recorded.

### P-051b — Cupboard server deployment [S]

v5: Cloudflare-fronted Next.js + managed Postgres at `cupboard.papercusp.dev`.

**Files:** deployment config (Wrangler / Vercel / whatever the team uses); DNS + cert.

**Sub-acceptances:**
- **P-051b-1** — Live at `cupboard.papercusp.dev` with TLS.
- **P-051b-2** — Postgres backups configured.
- **P-051b-3** — `PAPERCUSP_CUPBOARD_URL` env in desktop operator points at the deployment; self-host override path tested.

### P-052 — Cupboard UI in operator [M]

v5: navbar item, card grid (reuse Marketplace component family), filter + search + detail view.

**Files:**
- `apps/operator/app/cupboard/page.tsx` (new).
- `apps/operator/app/cupboard/CupboardClient.tsx` (new) — card grid client.
- `apps/operator/app/cupboard/[slug]/page.tsx` (new) — detail view.
- Reuses `apps/operator/app/marketplace/*` component patterns.

**Sub-acceptances:**
- **P-052a** — Navbar item, click navigates to /cupboard.
- **P-052b** — Card grid: card per harness with tier-A stats (per P-076 — contributor count, last-activity timestamp, languages from GitHub API at index time).
- **P-052c** — Search by name/description/language; filter by claimed/unclaimed.
- **P-052d** — Detail view: full harness metadata + claimed/unclaimed status + claim CTA for users with maintainer perm (links into Phase 8 P-069).
- **P-052e** — "Install this harness" runs Phase 1b P-009 Entry 4 flow with the harness link.

### P-053 — Publish-to-Cupboard from §5 wizard [S]

v5: wizard's `shared-public` path POSTs to Cupboard's `/harnesses`.

**Files:** patch to `apps/operator/app/harness/ShareWizard.tsx` (Phase 5a P-029).

**Sub-acceptances:**
- **P-053a** — Selecting `shared-public` in wizard step 6 triggers a POST to `${PAPERCUSP_CUPBOARD_URL}/api/harnesses` on wizard completion.
- **P-053b** — Failure path: if Cupboard publish fails, harness still becomes `shared-private` locally + user gets a "publish later" affordance in settings.

### P-054 — Discord integration [S]

v5: deep-link on harness switch (opt-in setting); optional outbound webhook.

**Files:**
- `apps/operator/app/_components/DiscordChannelLink.tsx` (new) — deep-link button in harness sidebar header.
- `apps/operator/lib/integrations/outbound-webhook.ts` (new) — POST to a configured webhook URL on harness events.

**Sub-acceptances:**
- **P-054a** — If `.harness/config.json:discord_channel` is set, sidebar header shows a Discord button. Click → `discord://discord.com/channels/<server>/<channel>`. Fallback: HTTPS URL in new tab.
- **P-054b** — Per-harness settings for `discord_webhook_url`. When set, hooks POST `{kind: 'feature_shipped', feature_id, title, github_pr_url}` etc. to the webhook on relevant events.
- **P-054c** — Webhook posts authenticated to webhook URL only (no Bearer token exposed).

### P-055 — Sync-with-main UI trio [M]

v5 §16.1-16.3: status badge + manual sync button (with `$EDITOR` fallback for conflicts) + auto-rebase-on-push (already wired in Phase 7 P-041).

**Files:**
- `apps/operator/app/harness/SyncWithMainBadge.tsx` (new).
- `apps/operator/app/harness/SyncWithMainDialog.tsx` (new) — drop-down with sync button + conflict resolution panel.

**Sub-acceptances:**
- **P-055a** — Status badge shows `up to date` / `behind <N>` / `ahead <N>`. `git rev-list --count user/<id>..origin/main` after background `git fetch origin main` every 60s.
- **P-055b** — Manual sync button runs `git fetch` + `git rebase origin/main` in user's worktree.
- **P-055c** — On conflict: opens `$EDITOR` (from `git config core.editor`, falling back to `$EDITOR` env, falling back to `vi`) per file. Inline panel lists conflicted files with "open in editor" / "mark resolved" / "abort rebase" buttons. No custom conflict-resolution UI per audit J.

### P-076 — Cupboard stats are tier-A only [S]

v5 addendum 3: Cupboard listing schema + indexer pull contributor count, last-activity timestamp, language tags from GitHub repo API at index time.

**Files:** patch to Cupboard server's listing indexer (lives in `apps/operator-public/`).

**Sub-acceptances:**
- **P-076a** — Index job runs hourly: for each listed harness, calls GitHub API to refresh stats.
- **P-076b** — No HYPERBEE-claimed numbers (queue depth, working count, etc.) appear in card display.
- **P-076c** — Cards display tier-A stats with ✓ badges.

## Decisions

### D-001 — Cupboard server is Hono + D1, not Next.js + Postgres
Date: 2026-05-25

**Question:** v5 §10.1 specified "Cloudflare-fronted Next.js + managed Postgres at cupboard.papercusp.dev." Should P-051a follow that literally, or pick a thinner shape now that the rest of the stack is in place?

**Resolution:** Hono on Cloudflare Workers + D1 (SQLite). Reasons:

1. **Scope:** Cupboard server is API-only. The listing UI lives in the desktop operator (P-052, shipped). A Next.js app would be 80% empty pages.
2. **Pattern reuse:** `apps/papercusp-publish` is already a Hono-on-Workers + D1 worker with the same auth/ratelimit/migration shape. Mirroring it cuts the dev/test/deploy surface.
3. **Latency:** D1 reads inside the Worker are <5ms p50. PG-on-Neon costs 50-100ms per query even on the fastest path.
4. **Cost:** D1 free tier covers v1 publish/list volume. PG-on-Neon would add a region pin and a separate cost line.
5. **Migration off:** D1 → PG is a one-week port if v1 ever justifies it (target volume: ≤10 publishes/day across the user base at launch). Easy to defer.

The plan body's §10.1 prose is now historical — `apps/operator-public/README.md` documents the actual deploy.

## Named fallback rollout

If Cupboard server deployment is contested or delayed:
- The desktop operator still works without Cupboard; `shared-public` is gracefully equivalent to `shared-private` locally + a "Cupboard not configured" toast.
- The binding service stays embedded-only; cross-engineer binding discovery requires manual harness-link sharing.

No formal rollout section needed.

## Cross-references

- Index: `papercusp-dogfood-execution-plan-index-2026-05-24.md`.
- Master: v5 `## Phase 9`, `### §10 — Cupboard registry`, `### §11 — Discord integration`, `### §16 — Sync-with-main`, addenda 1 + 3.
- Prereq plans: `phase1b`, `phase7`, `phase8`.
- D-013 (deep-link to GitHub), D-018 (poll not webhook), D-021 (Cupboard server required), D-023 (moderation v1), addendum 1 (claim), P-076 (tier-A only).

## Open questions

### Q-1 — Cupboard server tech stack confirmation?

v5 §10.1 names Next.js + managed Postgres + Cloudflare. Confirm before P-051a starts. If we're going with a different stack (e.g. Hono on Cloudflare Workers + Neon), schema migrations need to fit that.

### Q-2 — Discord webhook secret rotation?

P-054b stores a webhook URL per harness. Treat the URL as a secret (it carries auth via the path). Rotation flow: edit the URL in settings; old one stops being used immediately. No long-term webhook auth scheme in v1.

### Q-3 — Cupboard self-hosting story for v1?

Documenting the self-host path matters for trust + privacy. Suggested: README in `apps/operator-public/` covers minimal deployment (Docker compose, env vars, DB init). v1 doesn't need fancy install tooling.

## For the next agent (Phase 10 OR Phase 11)

Phase 10 (Hyperdrive peer-mirror) is OPTIONAL — can defer indefinitely if other priorities surface. Phase 11 (multi-engineer dogfood) is the next critical-path phase.

If Phase 10 is the next pick: it's M-sized, mostly plumbing on top of Phase 5a's Hypercore primitives. See its own plan when written.

If Phase 11: depends on all Phases 5/6/7/8/9 — see its plan.
