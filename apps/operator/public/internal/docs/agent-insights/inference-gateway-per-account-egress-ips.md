# Provisioning per-account egress IPs for the inference gateway (the per-IP → per-account capacity lever)
URL: /internal/docs/agent-insights/inference-gateway-per-account-egress-ips

Each Claude Max subscription can egress from its OWN outbound IP, so Anthropic's per-IP opus throttle becomes per-ACCOUNT — rotation actually works and aggregate RPM scales ~Nx with N accounts. The code is wired end-to-end (account-pool egress → resolver → gateway undici dispatcher); the owner provides the IPs/proxies. This is the step-by-step: provision N egress IPs (bound source IP or HTTP forward proxy), register each account's egress, restart the gateway, and verify per-account routing at three levels (unit test → socket → echo).

## Why this is the highest-leverage capacity fix

The hive inference gateway (`papercup-inference-gateway.service`, `127.0.0.1:8788`,
`packages/operator-core/lib/inference-gateway/gateway.ts`) is the **sole egress** to
`api.anthropic.com` for the bee fleet. By default every Max subscription's upstream
request leaves the box from the **same outbound IP**.

Anthropic enforces a meaningful slice of the opus rate limit **per source IP**. So when
N subscriptions all share one egress IP, the per-IP throttle caps the *whole pool* — the
extra accounts buy little headroom, and the "router is broken, accounts sit unused"
symptom recurs under concurrent opus load.

**Give each account its own egress IP and the per-IP throttle becomes per-account.**
Rotation/failover across accounts now multiplies real capacity (≈ N× aggregate RPM for N
accounts), instead of N accounts queueing behind one IP's limit. This is the single
biggest capacity lever for the consumer-Max basis.

## What is already wired (you do NOT need to write code)

The per-account egress dispatcher is wired end-to-end — `egress` flows from registration
to the actual upstream socket:

1. **Type + persistence** — `AccountEgress { proxyUrl?, localAddress? }` on each
   `ClaudeAccount` (`packages/operator-core/lib/deployment/account-pool.ts`),
   persisted in the single-row JSONB pool `harness_shared.operator_account_pool`.
2. **Registration** — the `accounts:register` MCP tool takes an `egress` object.
3. **Resolution** — `resolveAccountPool` / `resolveBoundAccount`
   (`inference-gateway/account-resolver.ts`) carry `egress` onto each resolved account.
4. **Launch** — `launch.ts` threads `egress` into each failover-pool entry.
5. **Egress** — per upstream attempt the gateway builds (and caches per-account) an
   **undici dispatcher** and passes it to the upstream `fetch`
   (`gateway.ts` → `dispatcherFor`):
   * `proxyUrl` (`http(s)://`) → `new ProxyAgent(proxyUrl)`
   * `localAddress` → `new Agent({ connect: { localAddress } })`
   * the dispatcher is keyed `<accountId>|<proxyUrl>|<localAddress>`, so each account
     gets its **own** dispatcher (one stable egress IP per account) and a failover that
     rotates the account rotates the dispatcher too.

Wiring is covered by unit tests in `inference-gateway/gateway.test.ts`
("per-account egress isolation…") and `account-resolver.test.ts`
("carries each account egress through…").

**The owner provides the IPs/proxies** (owner-gated infra, like the credentials
themselves). Everything below is "plug the IPs in".

## Choose a provisioning approach

Both forms are natively supported. Pick by what infra you have.

### A. Bound source IPs (`localAddress`) — simplest when the host has N public IPs

The box already has multiple public egress IPs (e.g. several elastic IPs / a /29 on the
NIC). Bind each account's upstream socket to a different one. No proxy process to run.

* Pro: zero extra infra, lowest latency, no proxy to babysit.
* Con: all IPs must terminate on (or route out of) **this** host; you need N genuinely
  distinct *public* egress IPs, not N private addresses that NAT to one public IP.

### B. HTTP / HTTPS forward proxies (`proxyUrl`) — when the IPs live elsewhere

Run (or rent) N forward proxies, each exiting from a different public IP, and point each
account at its own. The gateway routes that account's upstream through it via HTTP
CONNECT (undici `ProxyAgent`).

* Pro: IPs can live anywhere (other hosts, a proxy provider, datacenter egress IPs).
* Con: a proxy hop + you operate/trust the proxies. Use `https://` proxy URLs (or a
  private network) so the OAuth Bearer never crosses an untrusted plaintext hop.
* Self-hosting one IP per proxy: `tinyproxy`/`squid`, one instance per egress IP, e.g.
  `tinyproxy` with `Bind <egress-ip>` + `Allow 127.0.0.1`.

> **SOCKS is not yet supported.** undici's `ProxyAgent` only speaks HTTP CONNECT. A
> `socks://` / `socks5://` `proxyUrl` is **ignored** (the gateway logs a warning and
> falls back to `localAddress` if set, else the default shared egress) — it will NOT
> silently break the account, but it also won't tunnel. Native SOCKS egress is tracked
> in **WI-284**. Until then use a bound IP or an HTTP proxy.

## Steps

> Run MCP tools as the operator/superuser (the `papercusp-su` server). The gateway's
> workspace is `papercusp-workspace` (`PAPERCUSP_WORKSPACE` in its unit).

### 1. Provision the IPs (owner)

Stand up N distinct public egress IPs as either bound host IPs (A) or forward proxies
(B). Note, per account, the **value** to register: a `localAddress` IP or a `proxyUrl`.

### 2. Register each account's egress

`accounts:register` is idempotent — re-registering an existing id keeps its
credentialRef/bindings/rate state and just updates `egress`. So you can add egress to
already-registered accounts without re-supplying secrets… but `credentialRef` is
required by the tool, so pass the account's current ref (see `accounts:list`).

Bound source IP (approach A):

```
accounts:register {
  id: "aviynw6",
  credentialRef: "<its current ref from accounts:list>",
  egress: { localAddress: "203.0.113.21" }
}
```

HTTP forward proxy (approach B):

```
accounts:register {
  id: "aviynw6",
  credentialRef: "<its current ref from accounts:list>",
  egress: { proxyUrl: "http://10.0.0.21:3128" }
}
```

Repeat for every account, each with its **own** distinct IP/proxy. Confirm:

```
accounts:list      # each account row now shows its egress
```

### 3. Restart the gateway to pick up the egress

The gateway resolves the account pool **once at startup** and holds it for its lifetime
(a rebind is a restart, by design). An egress change is NOT hot — restart the service:

```bash
systemctl --user restart papercup-inference-gateway.service
# confirm it came back
curl -s http://127.0.0.1:8788/healthz | head -c 200
journalctl --user -u papercup-inference-gateway -n 20 --no-pager   # "up on 127.0.0.1:8788 → account '…'"
```

### 4. Verify per-account routing (three levels)

**Level 1 — wiring (already green, no IPs needed).** The unit tests prove account X →
X's dispatcher and that the resolver carries egress:

```bash
cd packages/operator-core
npx vitest run lib/inference-gateway/gateway.test.ts lib/inference-gateway/account-resolver.test.ts
```

**Level 2 — transport (the live gateway is actually using the egress).**
The route trace is already on (`PAPERCUSP_GATEWAY_ROUTE_LOG=1` in the unit) — it logs
`gw-route: … want=<pin> routed=<account>` and every response carries
`x-papercusp-routed-account`. To see the **egress IP** in use:

* Bound IP (A): inspect the gateway's upstream sockets — the local source address of
  each established connection to Anthropic should be the account's bound IP:
  ```bash
  GW_PID=$(systemctl --user show -p MainPID --value papercup-inference-gateway.service)
  ss -tnp 2>/dev/null | grep -w "pid=$GW_PID" | grep ':443'   # LocalAddress = the bound egress IP
  ```
* Proxy (B): the per-account proxy's own access log shows that account's CONNECT
  requests arriving (one proxy per account disambiguates which account routed where).

**Level 3 — definitive per-account egress IP (controlled echo, gold standard).**
Because the prod gateway proxies to `api.anthropic.com`, you cannot echo your own IP
through it. Spin up a **throwaway** gateway pointed at an IP-echo upstream, pinned to one
account, and read back the IP it egresses from:

```bash
# one account at a time; repeat per account and confirm the IPs differ
PAPERCUSP_GATEWAY_PORT=8799 \
PAPERCUSP_WORKSPACE=papercusp-workspace \
PAPERCUSP_ACCOUNT_ID=aviynw6 \
ANTHROPIC_BASE_URL_UPSTREAM=https://api.ipify.org \
  npx tsx packages/operator-core/lib/inference-gateway/bin.ts &

curl -s http://127.0.0.1:8799/         # → the egress IP for aviynw6 (proxy exit IP or bound IP)
# kill the throwaway gateway when done
```

`api.ipify.org` ignores the injected OAuth headers and returns the source IP as seen at
the far end — so a different IP per account is the end-to-end proof. (Use any echo
endpoint you trust; a self-hosted `/ip` echo avoids a third party.)

## Gotchas

* **Restart is required after an egress change** — the gateway caches the resolved pool
  for its lifetime. Forgetting the restart = your new egress silently does nothing.
* **N genuinely distinct PUBLIC egress IPs.** N private/NAT addresses that all egress
  from one public IP buy you nothing — Anthropic sees the one public IP. Verify with
  Level 3 (different account → different returned IP).
* **One stable IP per account.** The dispatcher is cached per account, so an account's
  bees all share one egress IP (good — that IP carries that account's cache/affinity).
  Don't expect per-request IP rotation *within* an account; rotation is *across*
  accounts.
* **HTTPS proxy URLs (or a private link) for approach B** — an `http://` proxy on an
  untrusted segment would expose the OAuth Bearer on the CONNECT hop.
* **SOCKS is ignored, not honored** (WI-284) — a `socks://` proxyUrl falls back to
  `localAddress`/default egress with a warning in the gateway log.
* **The Claude Code identity framing is already handled** — the gateway injects the
  OAuth Bearer + `oauth-2025-04-20` beta; real `claude` bees frame their first system
  block. (A raw curl straight at Anthropic without that framing hits a bogus instant
  429 — see `rate-limit-is-usually-account-routing-not-capacity`. The echo test above
  goes to ipify, not Anthropic, so it is immune.)
* **Failover still works with egress on** — `dispatcherFor(active)` runs per upstream
  attempt, so when the pool fails over to a healthy account, that account's egress
  dispatcher is used for the retry. Egress and failover compose.

## Rollback

Remove an account's egress and restart — it reverts to the default shared egress with no
other change:

```
accounts:register { id: "aviynw6", credentialRef: "<ref>", egress: {} }
systemctl --user restart papercup-inference-gateway.service
```

## See also

* `inference-gateway-wedge-admission-slot-squat` — the admission wedge runbook (a
  capacity-pressure symptom this fix relieves).
* `rate-limit-is-usually-account-routing-not-capacity` — a 429 is usually routing, not a
  real cap; per-account egress removes the per-IP confound.
* `llm-429-check-the-transport-not-the-account` — the missing-Claude-Code-framing instant
  429 (don't mistake it for exhaustion when testing egress directly).
