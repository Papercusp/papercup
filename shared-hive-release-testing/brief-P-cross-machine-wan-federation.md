# Brief P — Cross-machine / real-WAN federation

**Priority: S1 lane.** Live, multi-machine. The single biggest untested dimension.

## Objective
Prove federation works between **two separate machines** over the **public DHT**
(or a netem-shaped link) — NAT traversal, real latency/loss, and partition/heal —
not just two processes on one box sharing a local testnet DHT.

## Why it matters
EVERY live witness so far ran 2 instances on ONE box with
`PAPERCUSP_DHT_BOOTSTRAP=127.0.0.1:<port>` (a private testnet DHT, loopback
transport). That bypasses the entire real-world transport: DHT discovery on the
public network, NAT hole-punching/hairpinning, WAN RTT, packet loss, and asymmetric
partitions. A public hive's whole value is cross-machine — and Brief F explicitly
left WAN-latency convergence (C3) out of scope. Loopback green ≠ internet green.

## Scope / scenarios
1. **Two real machines** (the dev box + a Hetzner/peer host — see memory
   `HttpPeerRpcTransport ... loopback + Hetzner`), each running the fix-`.deb`. A on
   machine 1 publishes; B on machine 2 discovers over the **public DHT** (no
   bootstrap override) and joins. Assert topic-equal + content crosses both ways.
2. **NAT / discovery:** confirm DHT discovery + hole-punch succeed across real NATs;
   measure time-to-first-federation. Note any cases that need a relay.
3. **WAN latency/loss (netem):** shape the link (50/150/300ms RTT, 1–5% loss) and
   measure backfill + incremental federation latency + that it still converges.
4. **Partition / heal across machines:** sever the link mid-federation, keep writing
   both sides, heal → assert convergence (real transport, not the severable-pipe rig).
5. **Authority/locks cross-machine:** the lock/presence authority (`HttpPeerRpcTransport`)
   across machines — claims serialize, presence propagates, no split-brain under WAN.

## Method
- 2-machine harness (extend `vm-federation.sh` / the federation-asserts lib, or a
  netem-on-loopback approximation if a 2nd machine isn't available — state which).
- Verify via each machine's embedded-PG `origin` column. Measure latencies.

## Deliverables
- `findings-P.md`: cross-machine matrix (discovery, NAT, latency tiers, partition),
  latency numbers, any transport-only bug (the class loopback can't surface).

## Done / verdict
GREEN only when two SEPARATE machines federate bidirectionally over the public DHT
(or a faithfully-shaped WAN), survive partition/heal, and converge — with measured,
acceptable latency.
