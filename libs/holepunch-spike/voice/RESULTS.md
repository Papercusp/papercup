# Voice spike results — 2026-06-05 (loopback, Linux x64, Node 25.9)

Plan: `holepunch-voice-channels-2026-06-05` P-001/P-002. 80B frames @ 50fps, 300 frames/run.

| Path | conn setup | RTT p50 | p95 | p99 | max | loss | one-way≈ | jitter |
|---|---|---|---|---|---|---|---|---|
| `01` raw UDX datagram | n/a | 0.226ms | 0.409ms | 0.787ms | 5.65ms | 0% | 0.11ms | 0.11ms |
| `02` Hyperswarm encrypted UDX stream (via public DHT) | ~4.9s | 0.311ms | 0.556ms | 1.247ms | 13.6ms | 0% | 0.16ms | 0.20ms |

## Verdict

- **Transport overhead is negligible.** Noise encryption + UDX stream + framing adds only
  ~0.08ms p50 over raw datagrams. Real-world mouth-to-ear will be dominated by WAN RTT +
  jitter buffer, NOT by the Holepunch stack. P-001 loopback = **PASS**.
- **UDX-from-Node is fast enough** — the core worry (Node event-loop / native-binding overhead
  killing real-time audio) is disproven on loopback.
- **Connection setup ≈ 5s** via the public DHT. Acceptable for "join channel" but worth
  optimizing later (cached peer addr / local bootstrap / persistent swarm).

## What this does NOT yet cover (remaining for the P-004 gate)

1. **Cross-NAT WAN** — needs a second machine on a different network; loopback omits real RTT +
   hole-punch success. The decisive real-world number.
2. **WebRTC-media comparison** (P-002 other half) — `02` exercises the UDX-native path (Keet
   way). The Hyperswarm-discovery + WebRTC-media path (Quibble way) not yet built/compared.
3. **N-peer mix** (3–10) and **real Opus** codec in the loop (here: synthetic frames).
4. **operator-as-local-node IPC bridge** (P-003) — not yet exercised.

## Run

    cd libs/holepunch-spike
    node voice/01-udx-datagram-rtt.mjs
    node voice/02-swarm-frame-rtt.mjs
