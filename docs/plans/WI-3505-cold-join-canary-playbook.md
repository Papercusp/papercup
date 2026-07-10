# WI-3505 — Cold-join to canary hive playbook (P-403)

**Task:** Prove the joiner path on a real hive by cold-joining a fresh third instance to the canary hive via G-8 bootstrap.

**Blocker:** P-403 is blocked on P-401 (canary activation), which is blocked on P-308 (Phase 3 chaos), which is blocked on P-302-307 (Phase 3 drill legs). Phase 0 (LIVE rig) is RED waiting on iMac build update.

**Prerequisite checklist before starting:**
- [ ] P-401 DONE: Canary hive activated in bridged mode
- [ ] P-402 started: 72h soak underway (canary stable, divergence quiet)
- [ ] Phase 3 drill (P-301-308) LIVE: 2-machine real hive-git loop proven
- [ ] Canary hive slug confirmed (default: `shared-hive-test`)
- [ ] At least 2 members live in canary hive (tower + iMac from Phase 3 drill)
- [ ] G-8 bootstrap callable (P-205 landed, WI-3494 confirmed live)

---

## Step 1: Understand the canary hive setup

### 1.1 — Identify canary hive details

**What to check:**
- Hive slug: confirm it's `shared-hive-test` or document if different (per P-401 "disclose if different")
- Hive mode: verify `hiveGit.mode='bridged'` (query `harness_shared.hive_settings`)
- Members: list all live members via swarm/federation
- Git state: check that integrator has published canonical staging (refs/namespaces/<integrator-key>/published/staging)

**Query (direct PG):**
```sql
-- Canary hive mode
SELECT value FROM harness_shared.hive_settings 
  WHERE setting_key='hiveGit.mode' 
  AND harness_slug='shared-hive-test';

-- Members (from the operational state, or from the federation log)
SELECT DISTINCT device_pubkey FROM harness_shared.coord_event_log 
  WHERE body ILIKE '%member%' ORDER BY ts DESC LIMIT 10;
```

**Document in checkpoint:**
- Canary hive slug
- Current mode (should be 'bridged')
- Live member device keys (base64 format)
- Integrator device key (the one publishing staging)
- Tower/iMac connectivity status

### 1.2 — Prepare the joiner machine

**Requirements:**
- Fresh Papercusp instance (desktop app or headless sidecar)
- Empty hive-git repo mirror (or delete any prior namespaces)
- Device key generated (via the app's identity.ts or pre-generated)
- Network connectivity to at least one live member peer (swarm DHT bootstrap same as canary)
- Same workspace as canary hive

**Setup steps:**
1. If using desktop app: fresh install, start the app, let it generate device keys
2. If using headless sidecar: `bin/hive-git-drill.sh` pattern — extract .deb, spin up fresh instance
3. Verify: `ls -la $PAPERCUSP_HIVE_GIT_ROOT/<hive-slug>/` — should be empty or not exist yet
4. Capture joiner device key: read from the app's core state or from the sidecar logs

---

## Step 2: Prepare bootstrap inputs

The bootstrap requires:
1. **Local repo path** — `$PAPERCUSP_HIVE_GIT_ROOT/<hive-slug>/<repo-key>.git`
2. **Duplex stream** — a connection to a peer member over the swarm (via Protomux hive-git channel)
3. **Joiner device key** — the machine's own Ed25519 public key (base64)
4. **Peer member** — any live member (tower or iMac)

### 2.1 — Establish peer connection

Via the running joiner app/sidecar:
```typescript
// Pseudocode (actual wiring is in sync/hive-git/join-drive.ts or similar)
const duplex = await connectToPeerOverSwarm(peerDeviceKey, 'hive-git');
```

The joiner must:
1. Be able to reach the swarm DHT (same PAPERCUSP_DHT_BOOTSTRAP as canary)
2. Know a live peer's device key (tower or iMac device key from Step 1.1)
3. Establish the Protomux hive-git channel with that peer

### 2.2 — Prepare bootstrap call

```typescript
import { bootstrapFromPeer } from './sync/hive-git/bootstrap';
import { Duplex } from 'stream';

const result = await bootstrapFromPeer(
  '/path/to/hive/repo.git',
  duplex,
  {
    selfDevicePubkey: joinerDeviceKey,  // WI-1559: squat guard
    timeoutMs: 30000,
  }
);

console.log({
  ok: result.ok,
  namespaces: result.namespaces,
  skippedExisting: result.skippedExisting,
  skippedSelf: result.skippedSelf,
});
```

**Expected outcomes:**
- `ok: true` — bootstrap succeeded
- `namespaces: [...]` — array of device keys that were seeded (all members except joiner)
- `skippedExisting: []` — should be empty on a fresh joiner
- `skippedSelf: <joinerKey>` — confirms joiner's namespace was not seeded from peer

---

## Step 3: Execute the cold-join

### 3.1 — Invoke bootstrap

1. In the joiner app/sidecar, trigger the bootstrap:
   - Select the canary hive
   - Click "join" or equivalent
   - Select a peer member (tower or iMac)
   - Confirm (this dials the peer and calls `bootstrapFromPeer`)

2. Monitor the operation:
   - Watch logs for `bootstrap` / `bootstrapFromPeer` traces
   - Expect 30s timeout window
   - Check that namespaces are being seeded

### 3.2 — Verify bootstrap success

```bash
# After bootstrap completes, check local namespaces
git -C $LOCAL_REPO_PATH for-each-ref --format='%(refname)' refs/namespaces/

# Should see refs like:
# refs/namespaces/<tower-key>/refs/heads/work
# refs/namespaces/<iMac-key>/refs/heads/work
# refs/namespaces/<integrator-key>/published/staging
# etc.

# Do NOT see:
# refs/namespaces/<joiner-key>/... (WI-1559 guard working)
```

### 3.3 — Verify sigrefs and join the replication loop

After bootstrap, the joiner must:
1. **Reconcile fetched heads** (G-4): run `reconcileFetchedHeads` on each seeded namespace
   - Verify sigrefs for each member (device signatures)
   - Reject tampered/unsigned heads
   - Accept only members in the admission set

2. **Subscribe to announcements** (G-3): listen for ref-announce events
   - The peer members will continue to emit ref-announce events as they commit
   - Joiner fetches the announced namespaces

3. **Publish own namespace** (G-0): joiner commits in its own namespace
   - Integrator (or steer tier) will see the announce
   - Joiner's namespace enters the replication loop

### 3.4 — Join the integrator loop (if applicable)

If the joiner is a voting member (tier != 'message'):
1. Add its device key to the integrator's `memberDevicePubkeysBase64` list
2. Joiner's heads will enter the integration-requests queue
3. Integrator will compute a new canonical staging including joiner's commits

---

## Step 4: Validation checks

### 4.1 — Storage validation

**Check:** All seeded namespaces are present locally
```bash
for ns in $(cd $LOCAL_REPO_PATH && git for-each-ref --format='%(refname:lstrip=3)' refs/namespaces/ | cut -d/ -f1 | sort -u); do
  echo "Namespace $ns:"
  git -C $LOCAL_REPO_PATH for-each-ref "refs/namespaces/$ns/"
done
```

**Expected:** At least tower + iMac + integrator namespaces; NOT the joiner's own namespace.

### 4.2 — Sigrefs validation

**Check:** Each seeded member has valid sigrefs
```bash
# For each member namespace, verify:
# 1. sigrefs file is present and parseable
# 2. Signature validates against the member's device key
# 3. Version/epoch is sensible (>= the watermark when bootstrapped)
```

**Tool:** Run `reconcileFetchedHeads` in verbose/logging mode to trace verification.

### 4.3 — Replication flow validation

**Check:** Joiner receives new announcements from peers
1. Tower or iMac commits a change
2. They emit ref-announce event
3. Joiner's subscription fires
4. Joiner fetches the new namespace head

**Observable:**
- Logs show `ref-announce received`
- `fetchOverDuplex` traces for the announced namespace
- Local ref is updated to match peer's new head

### 4.4 — Integration-requests queue (if joiner is steer/message tier)

**Check:** Joiner's commits appear in the integration-requests queue
```sql
SELECT * FROM hive_integration_requests 
  WHERE pot_slug='shared-hive-test' 
  AND device_pubkey='<joiner-key>'
  ORDER BY created_at DESC LIMIT 5;
```

**Expected:**
- Joiner's work refs appear as rows with `state='pending'`
- Reason reflects the tier (`steer` / `below-steer-tier` / etc.)
- Integrator processes them and includes in canonical staging

### 4.5 — Worktree bridge validation (if joiner has a worktree)

**Check:** Joiner's worktree advances to canonical staging
1. Integrator publishes a new staging
2. Joiner receives staging-advance event (via federation or direct pull)
3. Joiner's worktree fast-forwards (if not dirty)

**Observable:**
- Logs show `staging-advance received`
- Local worktree HEAD moves to the new canonical staging SHA
- No local edits are lost (dirty file check prevents clobber)

---

## Step 5: Monitoring and logging

### 5.1 — Enable comprehensive logging

Set env vars to trace the entire join process:
```bash
# On the joiner instance:
PAPERCUSP_DEBUG=hive-git:*    # All hive-git traces
PAPERCUSP_DEBUG=sync:*         # All sync layer traces
PAPERCUSP_LOG_BOOTSTRAP=1      # Verbose bootstrap logs
```

### 5.2 — Capture log lines to verify

**Bootstrap start:**
```
bootstrap: starting from peer <peer-key>
```

**Quarantine fetch:**
```
fetchOverDuplex: fetching +refs/namespaces/*:refs/bootstrap-quarantine/*
fetchOverDuplex: 200 OK, <N> objects, <size> bytes
```

**Seeding progress:**
```
bootstrap: seeding namespace <key> (refs: <count>)
bootstrap: skipped existing namespace <key>
bootstrap: skipped self namespace <key>
```

**Bootstrap success:**
```
bootstrap: completed ok=true, namespaces=<count>, skipped=<count>, self=<key>
```

**Replication join:**
```
reconcileNamespace: verifying sigrefs for <key>
reconcileNamespace: verified signature, watermark=<version>
reconcileNamespace: joined namespace <key>
```

**First announce received:**
```
ref-announce: received from <peer-key>, namespace <key>, refs=[...]
fetchOverDuplex: fetching announced namespace <key>
```

### 5.3 — Set up monitoring queries

**Real-time progress queries:**

```bash
# Watch for new seeded namespaces (should complete within 30s)
watch -n1 'git -C $LOCAL_REPO_PATH for-each-ref refs/namespaces/ | wc -l'

# Watch for integration-requests from joiner (if applicable)
watch -n5 "psql '$DSN' -c \"SELECT count(*) FROM hive_integration_requests 
  WHERE pot_slug='shared-hive-test' AND device_pubkey='<joiner-key>';\""

# Watch federation logs for incoming announces
tail -f /var/log/papercusp-sidecar.log | grep 'ref-announce'
```

---

## Step 6: Success criteria

**P-403 DONE when:**

1. **Bootstrap completes successfully**
   - `bootstrapFromPeer` returns `ok: true`
   - All canary members' namespaces are seeded
   - Joiner's own namespace is NOT seeded (WI-1559 guard verified)

2. **Sigrefs verified**
   - `reconcileFetchedHeads` passes for all seeded namespaces
   - Device signatures are valid
   - No tampered or unsigned refs accepted

3. **Joiner enters the replication loop**
   - Joiner receives at least one ref-announce from a peer member
   - Fetches announced namespace successfully
   - Namespace heads are updated to match peers

4. **Integration flow works (if joiner is voting member)**
   - Joiner's commits appear in integration-requests queue
   - Integrator includes joiner's heads in canonical staging computation
   - Staging-advance events propagate to joiner

5. **No data loss or corruption**
   - Dirty files on joiner never touched
   - Peer namespaces never rewound/reset
   - Sigrefs watermarks are consistent

---

## Failure recovery

If bootstrap fails or validation fails:

1. **Check logs for root cause** — is it network, auth, git error, or logic?
2. **Verify peer is still live** — query federation logs on tower/iMac
3. **Check peer has published staging** — `git -C <peer-repo> show refs/namespaces/<integrator>/published/staging`
4. **Re-run bootstrap against a different peer** — the op is idempotent and safe to retry
5. **If repeated failures:** File WI with logs + the specific failure mode

---

## Timeline and dependencies

```
P-401 (canary activation)
  ↓ (hiveGit.mode='bridged' set on shared-hive-test)
P-402 (72h soak)  ← P-403 CAN START HERE (canary is stable)
  ↓
[Monitor for 72h]
  ↓
P-308 Phase 3 chaos (already completed as prerequisite)
  ↓
[P-403 execution happens here, in parallel with P-402 soak]
  ↓
P-403 DONE (cold-join proven on real hive)
P-404 (owner decision)
```

**Timing:** P-403 can execute AS SOON AS P-401 completes and canary is live. It does NOT need to wait for the full 72h soak to finish.

---

## References

- **G-8 bootstrap code:** `packages/operator-core/lib/sync/hive-git/bootstrap.ts`
- **G-4 reconciliation:** `packages/operator-core/lib/sync/hive-git/reconcile.ts`
- **G-3 announce/fetch:** `packages/operator-core/lib/sync/hive-git/announce.ts`, `fetch-transport.ts`
- **Phase 3 drill:** `papercusp-desktop/bin/hive-git-drill.sh`
- **Ops runbook:** `apps/operator-docs/src/content/docs/agent-insights/hive-git-p2p-ops-runbook-2026-07-09.mdx`
- **Plan:** `p2p-git-live-activation-2026-07-09`, items P-401 to P-403
