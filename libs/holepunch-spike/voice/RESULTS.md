# Voice spike results — 2026-06-05 (loopback, Linux x64, Node 25.9)

Plan: `holepunch-voice-channels-2026-06-05` P-001/P-002/P-003 + P-006/P-014 mesh.
80B synthetic-Opus frames @ 50fps, 300 frames/run.

| # | Path | conn setup | RTT p50 | p95 | p99 | max | loss |
|---|---|---|---|---|---|---|---|
| `01` | raw UDX datagram | n/a | 0.226ms | 0.409ms | 0.787ms | 5.65ms | 0% |
| `02` | Hyperswarm encrypted UDX stream (public DHT) | ~4.9s | 0.311ms | 0.556ms | 1.247ms | 13.6ms | 0% |
| `05` | WebRTC datachannel (node-datachannel) | ~1.0s | 0.450ms | 0.701ms | 0.862ms | 1.01ms | 0% |
| `04` | IPC unix-socket binary bridge (P-003) | n/a | 0.209ms | 0.437ms | 0.672ms | 1.77ms | 0% |
| `03` | 4-party mesh (3 peers, aggregate) | ~8.9s | 0.414ms | 0.719ms | 1.272ms | — | 0% |

## Verdict (Phase 0, loopback)

- **Transport overhead is negligible.** Encrypted UDX stream adds ~0.08ms p50 over raw
  datagrams; real mouth-to-ear will be dominated by WAN RTT + jitter buffer, not the stack.
  **P-001 loopback = PASS.**
- **UDX-native vs WebRTC (D-004):** UDX-native (0.31ms) beats WebRTC datachannel (0.45ms) on
  loopback, AND avoids a second native dep, AND reuses Holepunch's own encrypted stream +
  discovery. WebRTC's only edge here (faster local connect, ~1s) evaporates in production where
  it needs external signaling + STUN/TURN, which Holepunch's DHT replaces. **→ UDX-native; keep
  WebRTC documented as the fallback if cross-NAT hole-punch proves inadequate. P-002 = DONE.**
- **IPC bridge (P-003) = PASS:** binary-safe (0 corrupt over all byte values), lossless, one-way
  ~0.1ms. The operator-as-local-node audio bridge (D-002) is viable — needs a binary unix-socket
  channel, NOT the UTF-8 `sys:http` path.
- **Mesh (P-006/P-014) = PASS at 4-party:** one Node node held 3 concurrent encrypted peer
  streams, 900 frames, 0 loss, p50 0.41ms. (10-party result appended below if/when captured.)
- **Connection setup grows with peers** (~4.9s @ 2-party → ~8.9s @ 4-party via public DHT).
  Acceptable for "join channel" but a known optimization target (cached peer addr / persistent
  swarm / local bootstrap).

## What Phase 0 does NOT cover (the cross-NAT gate item + Phase 1+)

1. **Cross-NAT WAN** (P-001 tail / P-013) — needs a second machine on a different network;
   loopback omits real RTT + hole-punch success. **The one decisive number still missing — and
   it requires hardware I don't have solo.**
2. **Real Opus codec** in the loop (here: synthetic frames — correct wire shape, not real audio).
3. **N-peer MIX compute** (decode+sum) with a real decoder — pending the audio stack (P-005).

## Run

    cd libs/holepunch-spike
    node voice/01-udx-datagram-rtt.mjs
    node voice/02-swarm-frame-rtt.mjs
