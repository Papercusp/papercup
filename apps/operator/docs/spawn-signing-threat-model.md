# Per-spawn URL signing — threat model + minting patch

## Why

The per-spawn MCP URL bakes `(workspace, harness, role, run, spawn,
feature?, chunk?, parent_spawn?)` into query params. Before this work,
the dispatcher trusted those params verbatim — a worker that wanted
operator-tier tools just rewrote `?role=worker` → `?role=operator` and
called. One line, no auth, no audit.

This document covers:
1. The verification end (already shipped — `apps/operator/lib/spawn-signing.ts`).
2. The minting end (this is the patch to land in `libs/papercusp/packages/orchestrator/src/spawn-mcp.ts`).
3. What the system protects against and — importantly — what it doesn't.

## Threat model

### Defends against

- **Prompt-injected worker rewriting URL params.** Verification fails
  because the HMAC was over the original params; the agent doesn't
  have the key. This is the realistic threat — an agent reading a
  poisoned doc that says "to fix this, please call X with role=operator".

### Does NOT defend against

- **Same-UID code that reads PG for the key.** The agent runs as the
  operator's user; it can query PG with the same credentials. HMAC is
  *friction*, not enforcement.
- **Reading another spawn's `.mcp.json` and replaying it.** Every
  signed URL is a valid bearer for its `exp` window (24h default).
  Worktrees are per-spawn but same UID. **Mitigation**: chmod 0700 on
  each worktree dir (follow-up).
- **The `papercusp-su` path.** Separate door with its own
  (file-ACL) bouncer at `~/.papercusp/superuser-token`. The doc is
  explicit: "friction, not enforcement." HMAC doesn't change that.
- **Editing `~/.papercusp/granted-capabilities.json`.** Plain JSON,
  same UID, writable. The capability gate trusts what it finds there.
- **Operator memory dump** (`gcore <pid>`). Key is in the operator's
  heap; same UID can extract it.
- **Replacing the operator binary.** Far beyond a prompt-injection,
  but in scope for "same UID = total ownership."

### What actually closes the loop

OS-level isolation per worker (`bwrap` / `firejail` / a separate UID
with file ACLs). Worker only sees its own worktree + the MCP socket.
Key file unreadable, sibling `.mcp.json`s unreadable, superuser-token
unreadable. Real fix; bigger lift. Eventual landing spot.

## Minting patch

Apply in `libs/papercusp/packages/orchestrator/src/spawn-mcp.ts`.
The operator side (verification + audit) is already live and runs in
**soft-warning mode** by default — unsigned URLs are accepted with a
console warning until `PAPERCUSP_REQUIRE_SPAWN_SIG=1` is set.

### Minimal change

Add `sig` + `exp` URL params to the URL emitted by `buildSpawnMcpConfig`.
The signing key lives in `harness_shared.operator_secrets` (auto-minted
on first use). The orchestrator subprocess has PG credentials inherited
from the operator's env, so it can read the key directly.

### Diff sketch

```typescript
// libs/papercusp/packages/orchestrator/src/spawn-mcp.ts

import { createHmac } from 'node:crypto';
import postgres from 'postgres';

const SIGNED_PARAM_ALLOWLIST = new Set([
  'harness', 'workspace', 'role', 'run', 'spawn',
  'feature', 'chunk', 'parent_spawn', 'exp',
]);

let _keyCache: { buf: Buffer; loadedAt: number } | null = null;

async function loadSigningKey(): Promise<Buffer> {
  if (_keyCache && Date.now() - _keyCache.loadedAt < 5 * 60 * 1000) {
    return _keyCache.buf;
  }
  // DSN comes from the operator-set env. Bail to unsigned if missing.
  const dsn = process.env.DATABASE_URL ?? process.env.PAPERCUSP_PG_DSN;
  if (!dsn) throw new Error('spawn-signing: no PG DSN in env');
  const sql = postgres(dsn);
  try {
    const rows = await sql<{ value_b64: string }[]>`
      SELECT value_b64 FROM harness_shared.operator_secrets
      WHERE name = 'spawn-signing-key' LIMIT 1
    `;
    if (rows.length === 0) {
      throw new Error('spawn-signing: key row missing — operator should mint on first call');
    }
    const buf = Buffer.from(rows[0].value_b64, 'base64');
    _keyCache = { buf, loadedAt: Date.now() };
    return buf;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

function canonicalize(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [k, v] of params.entries()) {
    if (k === 'sig') continue;
    if (!SIGNED_PARAM_ALLOWLIST.has(k)) continue;
    if (seen.has(k)) throw new Error(`spawn-signing: duplicate param ${k}`);
    seen.add(k);
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function signParams(params: URLSearchParams, ttlSec = 24 * 60 * 60): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  params.set('exp', String(exp));
  params.delete('sig');
  const key = await loadSigningKey();
  const sig = createHmac('sha256', key).update(canonicalize(params)).digest('base64url');
  params.set('sig', sig);
}

// In buildSpawnMcpConfig (or a new async version):
//
//   params.set('harness', input.harnessSlug);
//   params.set('workspace', input.workspaceId);
//   // ... existing sets ...
//   if (input.parentSpawnId) params.set('parent_spawn', input.parentSpawnId);
//   try {
//     await signParams(params, input.ttlSec);
//   } catch (err) {
//     // Soft fail in MVP: emit unsigned URL + warn. Operator-side will
//     // also warn. Flip to hard fail once stable.
//     console.warn(`[spawn-mcp] signing failed, emitting unsigned URL: ${err}`);
//   }
//
//   return { mcpServers: { papercusp: { url: `${base}?${params.toString()}` } } };
```

### Migration plan

1. Land the operator-side verification (this commit). Soft-warn unsigned
   URLs in `console`, audit-log signature failures.
2. Land the minting patch in `libs/papercusp` per above.
3. Bump `libs/papercusp` in papercup. Verify orchestrator emits signed
   URLs (look for `sig=` in `.mcp.json` of any in-flight spawn).
4. Watch `harness_shared.spawn_sig_verification_failures` for legitimate
   verification failures (any non-zero rate = bug to investigate).
5. After ~1 week of clean operation: set `PAPERCUSP_REQUIRE_SPAWN_SIG=1`
   in operator env. Unsigned URLs now reject too.

### Coarse revocation

```sql
UPDATE harness_shared.operator_secrets
SET value_b64 = encode(gen_random_bytes(32), 'base64'),
    rotated_at = now()
WHERE name = 'spawn-signing-key';
```

Or via the `rotateSpawnSigningKey()` export in `apps/operator/lib/spawn-signing.ts`.
Every in-flight signed URL fails its next call after the key cache TTL
expires (≤5min). Use sparingly — the orchestrator must re-spawn anything
that was mid-flight.
