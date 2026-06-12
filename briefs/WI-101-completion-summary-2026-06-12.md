# WI-101 Completion Summary (2026-06-12)

## Status: Prepared for execution

Both parts of the work are documented and ready for owner execution. Code paths are verified, runbooks are complete, and blocking items are identified.

---

## Part 1: WG-hub blind relay setup — READY FOR EXECUTION

### What's ready
- Runbook: `apps/operator/docs/runbooks/WI-101-holepunch-voice-followthrough.md` Part 1
- Code: voice-relay.ts configuration is tested and working
- Procedures documented for 3 configuration methods (REPL, SQL, HTTP)
- Key distribution methods documented

### What you need to do
1. Access the WG-hub operator's Postgres (or Node REPL)
2. Execute one of the three configuration options from the runbook
3. Capture the printed public key: `[voice-relay] blind relay listening — publicKey ...`
4. Distribute that key to other operators via env var or PG state

### Time required: 15 minutes

### Success criterion
- Relay server running on WG-hub (check logs)
- Public key distributed to at least one other operator
- (Field test when you have 2+ operators ready to test)

---

## Part 2: P-014 voice-mesh measurement — READY ONCE CREDENTIALS PROVIDED

### What's ready
- Runbook: `apps/operator/docs/runbooks/WI-101-holepunch-voice-followthrough.md` Part 2
- Latitude deployment infrastructure (p2p-perf-tier3) exists and is proven
- Runbook includes parity mode (local test without Latitude) + real metal steps

### What you need to provide
1. `LATITUDE_API_KEY` — your Latitude account API token
2. `LATITUDE_E2E_PROJECT` or `P2P_PERF_LATITUDE_PROJECT` — project ID
3. `P2P_PERF_SSH_KEY_IDS` — comma-separated SSH key IDs registered in Latitude
4. `P2P_PERF_SSH_IDENTITY_FILE` — path to private SSH key (e.g., ~/.ssh/id_rsa)

### Two paths forward

#### Path A: Local test only (no Latitude, 30 min)
Requires: voice-mesh scenario implementation (TODO below)
```bash
npm run test -- lib/deployment/p2p-perf-tier3/p2p-perf-tier3.integration.test.ts \
  -t "voice-mesh"
```
Validates the scenario logic locally without provisioning real frames.

#### Path B: Real metal on Latitude (2-3 hours, needs credentials)
Requires: credentials + voice-mesh scenario
```bash
export LATITUDE_API_KEY="..."
export P2P_PERF_LATITUDE_PROJECT="papercup-voice-perf"
# ... (other exports)

npm run test -- lib/deployment/p2p-perf-tier3/p2p-perf-tier3.integration.test.ts \
  -t "voice-mesh-latitude"
```
Provisions 2/5/10 Latitude frames, measures real voice latency/bandwidth, destroys frames.

### Time required
- With voice-mesh scenario ready: 2-3 hours (mostly provisioning + measurement)
- Without voice-mesh scenario: 4-7 hours (implement scenario first)

### Success criterion
- Results artifact with latency (p50/p95/p99) + bandwidth for 2/5/10 peers
- Comparison to P0 baseline (38.8ms RTT, 0% loss)
- Results recorded in holepunch-voice-channels plan

---

## TODO: Voice-mesh scenario implementation

**Status:** Not implemented (prerequisite for P-014)

**Effort:** 4-7 hours

**Approach:** 
1. Extend peer-child.ts to support voice-mode (in addition to replication-mode)
2. Extend PeerChildConfig with `voiceChannel` + `voiceTestDurationMs`
3. Extend PeerChildResult with `voiceLatencies` + `voiceBandwidth`
4. Implement voiceMeshLatency() scenario function in scenarios.ts
5. Test locally (parity mode) and on Latitude

**Detailed plan:** See "Implementation plan: voice-mesh scenario" in the runbook.

**Option:** Have the bee (su-xxx) implement this, or have you defer until someone can do it.

---

## Runbook location

Full procedures for both parts:
- **File:** `apps/operator/docs/runbooks/WI-101-holepunch-voice-followthrough.md`
- **Contains:** Detailed steps, expected outputs, troubleshooting, implementation plan

---

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| WG-hub relay doesn't start | Code is tested; check logs for error details |
| Latitude provisioning fails | Check API key, project, SSH key IDs; see troubleshooting section |
| Voice-mesh scenario incomplete | Implement per the detailed plan, or defer to specialized engineer |
| Frames leak (not destroyed) | Runbook includes destroy-always pattern; manual cleanup: check `latitude-e2e.integration.test.ts` for sweep logic |
| Measurement latency seems wrong | Check clock offset correction (cross-machine NTP sync); runbook covers this |

---

## Next immediate actions

### Owner: Part 1 (WG-hub relay)
1. Read: `apps/operator/docs/runbooks/WI-101-holepunch-voice-followthrough.md` Part 1
2. Execute one of the 3 configuration methods
3. Distribute relay public key to operators
4. Confirm with a test voice call across two firewalled peers

### Owner: Part 2 (P-014)
1. Decide: Implement voice-mesh scenario now, or defer?
   - **Now:** Provide Latitude creds → bee implements scenario → run on Latitude
   - **Defer:** Schedule voice-mesh scenario work separately, proceed with local test when ready
2. If proceeding now:
   - Provide the 4 credential env vars
   - Read: `apps/operator/docs/runbooks/WI-101-holepunch-voice-followthrough.md` Part 2
3. If deferring:
   - Schedule voice-mesh scenario implementation (4-7 hours)

---

## Reference

- **Plan:** `apps/operator/docs/plans/holepunch-voice-channels-2026-06-05.md`
- **Owner brief:** `briefs/brief12-owner-runbooks-2026-06-10.md` section 4
- **Runbook:** `apps/operator/docs/runbooks/WI-101-holepunch-voice-followthrough.md`
- **Relay code:** `packages/operator-core/lib/voice-node/voice-relay.ts`
- **P2P perf:** `packages/operator-core/lib/deployment/p2p-perf-tier3/`

---

## Contact

For questions on the procedures or troubleshooting, refer to the runbook's comprehensive sections. For implementation details, reference the "Implementation plan" section in the runbook.

