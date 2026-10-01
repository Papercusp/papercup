# Anthropic usage credits and API-key accounts in the inference gateway
URL: /internal/docs/agent-insights/anthropic-usage-credits-and-api-key-accounts

How the inference gateway uses Anthropic usage credits (subscription overage) and Console API credits. Covers registering an API-key account, the included-first / metered-overflow selection policy, the meteredPolicy opt-out, credit-exhaustion walls, and where to read per-account metered spend.

# Anthropic usage credits and API-key accounts

The Claude pool behind the inference gateway (`:8788`) can serve from three billing classes:

| class           | what it is                                                                                 | how it is billed        |
| --------------- | ------------------------------------------------------------------------------------------ | ----------------------- |
| `included`      | a Claude subscription serving inside its plan allowance                                    | flat-rate               |
| `usage-credits` | a Claude subscription in **overage** (usage credits enabled on claude.ai, allowance spent) | per token, at API rates |
| `api-credits`   | an Anthropic Console **API-key** account                                                   | per token, at API rates |

The last two are **metered**. The policy (plan `anthropic-credits-gateway-2026-09-30`, D-003) is **included allowance first; metered is overflow**.

## Registering an API-key account

API keys are a credential kind of the `claude` provider, not a separate provider (D-002). They join the same pool, so failover can cross from subscription to API and back. Register with `accounts:register` and an `apikey:` credential ref:

```
accounts:register { id: 'console-key-1', provider: 'claude', credentialRef: 'apikey:credentials' }
```

| credentialRef        | where the key is read from                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apikey:credentials` | the operator credentials store's `anthropic_api_key`, written by `setup:save_key { provider: 'anthropic' }` |
| `apikey:env:NAME`    | the gateway process's environment variable `NAME`                                                           |
| `apikey:file:<path>` | a file holding the key                                                                                      |

The ref is a **reference**, never the secret. The key is read once and cached. An upstream 401 invalidates the cache, so a rotated key is picked up on the next request without a gateway restart. A subscription OAuth token stored at an `apikey:` source is refused with a message naming the right `token:` form. API-key accounts authenticate with `x-api-key`, not the OAuth bearer.

Registering an API-key account **is** the opt-in to API-credit spend. Enabling usage credits on claude.ai **is** the opt-in to overage spend. Spend caps are enforced upstream by Anthropic (Console spend limits, the usage-credit monthly cap), so there is no dark flag.

## Selection: included first, metered as overflow

`auto` routing scores every account (`accountHealthKey` in `account-failover.ts`). A metered account (`billing: 'metered'`: an API-key account, or a subscription whose live headers say it is in usage-credits overage) carries a fixed `METERED_LOAD_BUCKET` penalty. It ranks behind every serviceable included account, but it is not unselectable. When every included account is parked or walled, a metered account still serves.

* **Explicit header pins are honoured.** A request pinned (`x-papercusp-account`) to an API-key account is served by that account even while included accounts are free.
* **Session affinity yields.** Affinity is an implicit pin kept only for prompt-cache savings. When the affinity account is metered and an included account can serve, the affinity is dropped (`autoAffinityTally.yields`), so cache savings never buy per-token spend (D-007).

## Opting an account out: `meteredPolicy: 'never'`

```
accounts:register { id: 'max-2', credentialRef: 'token:~/.claude/max-2.token', meteredPolicy: 'never' }
```

`meteredPolicy` is `overflow` (default) or `never`. With `never`, usage-credit overage is treated as a **wall**, and three independent guards enforce it:

1. the pool score returns `Infinity` for a metered `never` account;
2. the gateway **parks** it in the failover pool until the allowance reset its own response named (`pool.onExhausted`). It does not use a governor pause, because each reprobe would itself be a metered charge;
3. a pre-dispatch guard refuses (shed, `metered-never wall`, with `Retry-After`) if routing still lands on it, for example a hard pin or every alternative unserviceable.

## Credit exhaustion is a wall, not a transient (D-004)

These responses mean the account cannot serve until billing changes or the period resets. They pause the account and fail over; they are never retried in place:

* `402` `billing_error`;
* `400` "You have reached your specified ... API usage limits";
* `429` with `error.details.error_code = enforced_spend_limit_reached` and no `retry-after`;
* a subscription response with `overage-status: rejected` plus a disabled reason.

An ordinary API `429` **with** `retry-after` stays a transient rate window. Parsing and classification live in `anthropic-billing.ts`.

## Reading metered spend

`GET http://127.0.0.1:8788/stats` returns a `billing` section:

* `billing.byAccount[<id>]`: `state` (`included` / `usage-credits` / `walled` / `api-credits` / `unknown`), `stateUntil`, `meteredNow`, `authMode`, `meteredPolicy`, `classes` (a per-class tally), and `metered` (usage-credits + api-credits combined);
* `billing.metered`: the pool-wide metered sum.

Each tally holds `requests`, `inputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `outputTokens`, `usageKnown` and `outputKnown`. The last two count the requests whose usage was actually observed; a stream that closed early contributes a request without tokens. Counters are **in-memory since gateway boot**: a restart zeroes them.

`accounts:list` shows each account's registered `credentialRef` (an `apikey:` scheme marks an API-key account) and `meteredPolicy`. Live billing state and metered totals come from the gateway, not the pool store, so read `/stats` for them.

## Tests

`anthropic-billing.test.ts` (header and body parsing, walls), `metered-selection.test.ts` (included-first, overflow, `never`, pins), `metered-spend.test.ts` (billing class, per-account totals, billing state), `credential-store-apikey.test.ts` and `claude-auth-mode.test.ts` (API-key credentials, auth mode).
