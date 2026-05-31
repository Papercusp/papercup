---
title: Team-proxy witness pattern — substrate for cross-engineer verifiable LLM-side stats
slug: proxy-witness-pattern-2026-05-24
status: ready
created: 2026-05-24
updated: 2026-05-24
owner: avi@storewolf.com
---

# Team-proxy witness pattern — substrate for cross-engineer verifiable LLM-side stats

## Now

**State:** **draft stub.** Carved out from the `papercusp-dogfood-v5`
arc (addendum 2) after the question "how do you prevent token-spend
stats from being faked?" surfaced a broader truth: **anything an
engineer's local operator claims about an LLM call** (spend, latency,
model choice, call count, success rate, refusal rate, throttling) is
structurally self-asserted and cross-engineer-unverifiable — *unless*
every operator routes through a shared witness. The team already has
that witness in the form of the Claude Bridge / Meridian proxy. This
is the plan for turning the proxy from a routing convenience into a
cryptographic source of truth for LLM-side facts.

Spend-witness is the motivating use case (deferred from dogfood-v5
per its addendum 2; v5 currently ships spend as `self-reported` ⏱ tier-D
on the Insights "Spend" card); the pattern is wider.

**Next action:** pick this up after dogfood-v5 ships its non-spend
collaboration layer. First concrete step when picked up: decide
whether the proxy gets a small first-class API for signed
reconciliation feeds, or whether the proxy just commits signed JSON
into shared-harness GIT buckets via a side-channel. Then one
end-to-end spike on spend to validate the substrate before adding
more `kind`s.

## Background

Every harness collaboration stat falls into one of two trust tiers:

- **Tier A — verification anchor exists outside the operator.** Git
  commits, merged PRs, spec files on `main`. Anyone can re-derive
  truth from the canonical remote.
- **Tier B — no anchor.** Token spend, request latency, which model
  was chosen, prompt content, refusal rate. Anthropic/OpenAI know;
  the engineer's operator knows; nobody else does.

For tier-B stats, peer-claimed numbers can be silently fabricated.
The dogfood-v5 plan (post-addendum 3) surfaces tier-D stats with a
visible ⏱ "self-reported" label on the Insights Spend card and as a
viewer-only pill on Contributor rows — but the only way to *upgrade*
those numbers from tier-D to tier-A/B (✓) is a shared witness. That
upgrade is what this pattern provides.

The team's existing proxy sits in the exact right place to fix this:
every LLM call already passes through it, attributed by issued
sub-key.

## What the pattern is

The proxy holds an Ed25519 keypair (`proxy_pubkey`, published in
`.harness/shared.json` per shared harness). Every N minutes/hours it
emits a **signed reconciliation report** covering some range of past
activity:

```json
{
  "period_start": "2026-05-24T00:00:00Z",
  "period_end":   "2026-05-24T00:15:00Z",
  "harness_slug": "papercup",
  "facts": [
    { "kind": "spend",        "pubkey": "...", "cents": 1234, "calls": 87 },
    { "kind": "latency_p95",  "pubkey": "...", "ms": 4200 },
    { "kind": "model_calls",  "pubkey": "...", "model": "opus-4-7", "calls": 12 },
    { "kind": "refusals",     "pubkey": "...", "count": 0 }
  ],
  "signed_by": "<proxy_pubkey>",
  "signature": "<ed25519-over-canonical-json>"
}
```

The report is written as a file under
`.harness/state/proxy-reports/<period>.json` and rides the standard
git-as-sync path. Peers verify on read; verified facts feed their UI
as tier-A-equivalent ground truth. Anything *not* in a verified
report stays labeled "self-reported."

**Bypass posture:** engineers can technically run their operator
straight to Anthropic, but their activity won't appear in the
proxy's reports. Their Contributor card then shows `unreported` for
everything covered by the proxy — a visible social signal, not a
silent inflation.

## Use cases — the reason this is bigger than spend

| Use case | Today | With proxy-as-witness |
|---|---|---|
| **Token spend** | Hyperbee-claimed, trivially faked | Signed per-engineer spend per period |
| **Latency / throughput** | Self-reported `tool_invocations.duration_ms` | Signed p50/p95 per engineer per period |
| **Model choice attribution** | "Bob used Opus all sprint" — Bob says so | Signed per-model call counts |
| **Abuse / refusal tracking** | Local-only | Signed refusal counts; spike alerts |
| **Rate-limit visibility** | Each engineer sees their own 429s | Aggregate harness-wide saturation events |
| **Per-feature cost attribution** | Hyperbee-claimed via operator-tagged `feature_id` | Signed if the proxy preserves the tag |
| **Cost-budget enforcement** | `operator:budget` is local, bypassable by another engineer's spend | Proxy is the policy point — refuses calls past a harness cap |
| **Anti-abuse for shared-public harnesses** | Cupboard-listed harness has no spend ceiling; joiners can drain | Proxy meters joiners; rejects past a per-pubkey quota |
| **Provider-failover transparency** | Silent (operator switches provider; no peer signal) | Signed report shows which provider served each call |

The first three are dogfood-relevant. The others become important as
soon as the team scales past three engineers OR Cupboard joiners are
real.

## Sketch of the work — rough, not committed

Three layers, increasing depth:

**1. Proxy-side: emit signed reports.** The proxy already has a DB
of every routed call. Add a per-harness reconciliation job: aggregate
the period's facts, sign with the proxy keypair, write the JSON.
Commit/upload via whichever transport ends up cheapest (push to a
designated branch, HTTP POST to a per-harness operator endpoint,
Hyperbee row written by an operator co-located with the proxy).

**2. Operator-side: verify + project.** On reading
`.harness/state/proxy-reports/<period>.json`, verify the signature
against `proxy_pubkey` from `shared.json`. Project verified facts
into PG (a `harness_shared.proxy_verified_facts` table — LOCAL,
since each operator re-derives from the GIT-synced files; never
synced as Hyperbee state to avoid double-trust). UI reads from this
table with a ✓ badge.

**3. UI-side: tier surfacing.** Insights "Spend" card, Contributor
stats, anywhere a tier-B stat appears: render verified facts with
✓ and a "from proxy report" tooltip; render self-reported deltas
with ⏱ and a "not yet reconciled" tooltip. Same pattern Q1 of
dogfood-v5 §17 already established for tier-A/B/C/D.

## Goals — when this gets picked up

- Spend stats become tier-A on Insights for engineers routing through
  the proxy.
- One reusable verifier in the operator; every use case above plugs
  in by adding a `kind` to the proxy's report format.
- Bypass surfaces visibly on Contributor cards; never silently.
- Per-harness `proxy_pubkey` makes proxy rotation a single config
  flip + a freshness re-sign.

## Non-goals — for the eventual execution plan

- Replacing Claude Bridge / Meridian. Pattern wraps what's there;
  doesn't redesign it.
- Provider-side signed receipts. Anthropic doesn't ship them; we
  don't try.
- Hard-refusing LLM calls that don't go through the proxy. Bypass is
  a social signal, not a kernel-level block (proxies go down).
- Cupboard-public harnesses running through a single team proxy. Public
  joiners will need a separate "trust the listing's proxy or don't"
  UX; deferred to its own design pass.

## Open questions

- **Q-1** Where does the proxy publish? Push commits to a
  `proxy-reports/*` ref on the harness repo? POST to an operator
  endpoint? Hyperbee row from a co-located operator? Affects the
  proxy's auth/permissions story.
- **Q-2** Period granularity? Sub-minute (low-latency UX, more proxy
  load), 15-min (cheap, OK UX), nightly (cheapest, bad UX)?
- **Q-3** Key rotation for the proxy keypair — when, by whom, how do
  peers learn? Probably a `shared.json` commit + grace window.
- **Q-4** Heterogeneous-proxy story: must all shared harnesses use
  the same team proxy, or can each harness pick its own? Implies a
  small registry of trusted proxy pubkeys per workspace.
- **Q-5** Privacy: a signed report attributes activity by pubkey.
  For shared-public harnesses on the Cupboard, that's a lot of
  disclosure. Aggregate-only mode for public listings?
- **Q-6** Replay/freshness: what stops a proxy from re-publishing an
  old period? Period inclusion in the signed body + monotonic period
  sequence + peers ignore overlap.
- **Q-7** Failure mode when the proxy is down: do operators queue
  calls and retry, fall back to direct-Anthropic (bypass-mode), or
  hard-stop? Probably fall back with a visible "unreported window"
  marker.

## Decisions

None yet — stub. Captured here when the plan moves out of stub
status.

## Cross-references

- `papercusp-dogfood-v5-2026-05-23.md` — the parent arc this carves
  out of (addendum 2). The spend section there already points here
  and labels spend as "deferred to proxy-witness pattern; surface as
  self-reported only for now." See also v5 §17 (trust tiers) for the
  tier-D → tier-A/B upgrade path this pattern enables.
- Memory: `reference_claude_bridge_models` (bridge has sonnet-4-6 +
  haiku-4-5 only); `project_ts_orchestrator_default` (meridian
  backend is default for runAgentChat). The proxy candidates the
  pattern would wrap.
