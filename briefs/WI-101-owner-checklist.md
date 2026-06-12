# WI-101 Owner Checklist — Ready to execute

Two-part holepunch-voice-channels follow-through. Both parts are documented and ready.

---

## ✓ PART 1: WG-hub blind relay setup (15 min)

**What:** Enable voice_relay.serve=true on WG-hub, get public key, distribute to fleet

**Checklist:**

- [ ] Read `apps/operator/docs/runbooks/WI-101-holepunch-voice-followthrough.md` § "Part 1"
- [ ] Choose one of 3 configuration methods:
  - [ ] Node REPL (fastest if you have shell access)
  - [ ] SQL (if you have psql access)
  - [ ] HTTP endpoint (if it's exposed)
- [ ] Execute the configuration
- [ ] Capture the public key from stdout: `[voice-relay] blind relay listening — publicKey ...`
- [ ] Distribute key to other operators via:
  - [ ] Environment: `PAPERCUSP_VOICE_RELAY_KEYS="<key>"`
  - [ ] Or PG state: update their `voice_relay.relayKeys`
  - [ ] Or both (env wins)
- [ ] (Optional) Test with 2 operators behind NAT → should relay through WG-hub

**Success:** Relay is running, key is distributed, operators can relay voice through WG-hub

---

## ✓ PART 2: P-014 voice-mesh measurement (depends on decisions below)

**What:** Measure voice latency+bandwidth at 2/5/10 peers on Latitude frames

**Prerequisites:**

- [ ] Latitude credentials (only needed if running on real metal):
  - [ ] `LATITUDE_API_KEY` — your Latitude account API token
  - [ ] `LATITUDE_E2E_PROJECT` or `P2P_PERF_LATITUDE_PROJECT` — project ID
  - [ ] `P2P_PERF_SSH_KEY_IDS` — comma-separated SSH key IDs (registered in Latitude)
  - [ ] `P2P_PERF_SSH_IDENTITY_FILE` — path to private SSH key (~/.ssh/id_rsa or similar)

**Decision point: Test locally or run on real metal?**

### Option A: Local test only (30 min, no Latitude creds needed)

- [ ] Read `apps/operator/docs/runbooks/WI-101-holepunch-voice-followthrough.md` § "Implementation plan"
- [ ] Implement voice-mesh scenario (or have bee implement it: 4-7 hours)
- [ ] Run local parity mode test:
  ```bash
  npm run test -- lib/deployment/p2p-perf-tier3/p2p-perf-tier3.integration.test.ts -t "voice-mesh"
  ```
- [ ] Verify artifact has `latencyMs` + `bandwidthBytesPerSec` metrics
- [ ] Review locally-measured numbers (loopback will be <1ms, expected)

**Success:** Voice-mesh scenario is implemented and tested locally

### Option B: Real metal on Latitude (2-3 hours, needs credentials + scenario)

- [ ] Complete Option A first (scenario + local test)
- [ ] Set Latitude credential env vars:
  ```bash
  export LATITUDE_API_KEY="<your-token>"
  export LATITUDE_E2E_PROJECT="papercup-voice-perf"
  export P2P_PERF_SSH_KEY_IDS="key1,key2"
  export P2P_PERF_SSH_IDENTITY_FILE="$HOME/.ssh/id_rsa"
  ```
- [ ] Run on Latitude (co-located, same region):
  ```bash
  npm run test -- lib/deployment/p2p-perf-tier3/p2p-perf-tier3.integration.test.ts \
    -t "voice-mesh-latitude"
  ```
- [ ] Verify frames are provisioned and SSH works
- [ ] Wait for measurement to complete (~60 min per peer-count)
- [ ] Check that all frames are destroyed (no billing leaks):
  ```bash
  # Should show 0 papercup-voice-* frames
  latitude devices list --project P2P_PERF_LATITUDE_PROJECT
  ```
- [ ] Capture the artifact JSON (result metrics)
- [ ] Compare to P0 baseline:
  - P0: 38.8ms RTT, 0% loss (home ↔ Ashburn)
  - Your run: latency at 2/5/10 peers, bandwidth scaling
- [ ] Update the holepunch-voice-channels plan with results

**Success:** P-014 measurements complete, results recorded, frames destroyed

---

## ✓ Voice-mesh scenario implementation (if not done yet)

**Status:** TODO

**Effort:** 4-7 hours

**Decision:**
- [ ] Have bee (su-xxx) implement (add task to queue with 4-7h estimate)
- [ ] Defer (schedule separately, proceed with Part 1 only for now)

**Implementation checklist (if proceeding):**

- [ ] Read implementation plan in runbook § "Implementation plan"
- [ ] Extend `peer-child.ts`:
  - [ ] Add `voiceChannel`, `voiceTestDurationMs` to PeerChildConfig
  - [ ] Add `voiceLatencies`, `voiceBandwidth` to PeerChildResult
- [ ] Implement `voiceMeshLatency()` in `scenarios.ts`
  - [ ] Launch N operator voice-nodes (not replication peers)
  - [ ] Measure mouth-to-ear latency
  - [ ] Measure Opus bandwidth per stream
  - [ ] Fold into PerfArtifact
- [ ] Test locally (parity mode)
- [ ] Document results format (for Latitude run)

---

## 📋 Files to reference

1. **Detailed runbook:** `apps/operator/docs/runbooks/WI-101-holepunch-voice-followthrough.md`
   - Setup procedures, expected outputs, troubleshooting, implementation plan
2. **Completion summary:** `briefs/WI-101-completion-summary-2026-06-12.md`
   - High-level status, what's ready, what's blocking
3. **Original plan:** `apps/operator/docs/plans/holepunch-voice-channels-2026-06-05.md`
   - Full context, decisions, architecture

---

## ✅ Success criteria

### Part 1
- [ ] WG-hub relay running (`[voice-relay]` logs visible)
- [ ] Public key distributed
- [ ] Operators configured with relay key

### Part 2 (if proceeding with real metal)
- [ ] Voice-mesh scenario implemented
- [ ] Artifact complete with latency + bandwidth metrics
- [ ] Results at 2/5/10 peers recorded
- [ ] Compared to P0 baseline (38.8ms RTT)
- [ ] Plan updated with P-014 results
- [ ] Frames destroyed (zero billing leaks)

---

## 🚀 Next step

1. Start with Part 1 (15 min, low-risk)
2. Decide on Part 2 path (local test vs real metal)
3. If real metal: provide Latitude credentials
4. If scenario missing: decide on implementation (queue or defer)

