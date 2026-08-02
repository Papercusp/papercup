/**
 * WI-6581 live verification — against REAL archived codex rollouts, not a
 * fixture. The item demanded this explicitly: "the keying difference IS the
 * bug, so a fixture that assumes the claude shape would pass while the real
 * path stays broken".
 *
 * Run: npx tsx scratchpad/wi6581/live-probe.mts
 */
delete (process.env as Record<string, string | undefined>).VITEST;

import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LIB = '/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib';

const { rematerializeTranscript } = await import(`${LIB}/session-transcript-remat.ts`);
const { findCodexRolloutPath, findCodexRolloutPathByUuid } = await import(
  `${LIB}/session-transcript-resolvers.ts`
);
const { findArchivedSessionIdForAdv } = await import(`${LIB}/session-archive.ts`);
const { getOrgPg } = await import(`${LIB}/org-pg.ts`);
const { codexHomeForSessionKey } = await import(
  '/home/marsh-office/papercupai-workspace/papercusp/libs/papercusp/packages/orchestrator/src/session-launch-dirs.ts'
);

const { sql } = getOrgPg();
let failures = 0;
const check = (name: string, ok: boolean, detail: string) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};

// ── 0) Pick a REAL codex archive whose rollout is GONE from disk ─────────────
const cands = await sql<
  Array<{ session_id: string; session_root: string; adv_session_id: number; file_count: number }>
>`SELECT session_id, session_root, adv_session_id, file_count
    FROM harness_shared.session_archives
   WHERE source_kind = 'codex' AND adv_session_id IS NOT NULL
   ORDER BY archived_at DESC LIMIT 40`;

const victim = cands.find(
  (c) => !existsSync(c.session_root) && c.file_count > 0,
);
if (!victim) {
  console.log('FAIL  no codex archive with a MISSING session_root — cannot prove the bug');
  process.exit(1);
}
console.log(
  `subject: adv=${victim.adv_session_id} rollout=${victim.session_id}\n` +
    `         session_root=${victim.session_root} (ABSENT from disk)\n`,
);

// ── 1) The pre-fix behaviour, stated structurally ────────────────────────────
// The old ternary was: sessionId ? claude : ompThreadId ? omp : null — and a
// codex stream carries NEITHER param, so it produced null and never restored.
const preFixKey = (p: { sessionId?: string; ompThreadId?: string }) =>
  p.sessionId ? 'claude' : p.ompThreadId ? 'omp' : null;
check(
  'pre-fix: a codex stream produced NO archive key at all',
  preFixKey({}) === null,
  `old rematKey({codexSessionKey:${victim.adv_session_id}}) => ${preFixKey({})}`,
);

// ── 2) adv row id -> rollout uuid, via the archive's own index ───────────────
const mapped = await findArchivedSessionIdForAdv(victim.adv_session_id);
check(
  'adv-session row id maps to the ROLLOUT uuid the archive is keyed by',
  mapped === victim.session_id,
  `findArchivedSessionIdForAdv(${victim.adv_session_id}) => ${mapped}`,
);

// ── 3) The full codex-session-key leg, restoring into a scratch root ─────────
const tmpA = mkdtempSync(join(tmpdir(), 'wi6581-key-'));
const byKey = await rematerializeTranscript(
  { kind: 'codex-session-key', sessionKey: String(victim.adv_session_id) },
  { targetRoot: tmpA },
);
check(
  'codex-session-key: restored AND re-resolved to a real rollout on disk',
  byKey.reason === 'restored' && !!byKey.path && existsSync(byKey.path),
  `reason=${byKey.reason} path=${byKey.path}`,
);
if (byKey.path) {
  const raw = readFileSync(byKey.path, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let parsed = 0;
  for (const l of lines.slice(0, 50)) { try { JSON.parse(l); parsed++; } catch { /* noop */ } }
  check(
    'the restored rollout is real, parseable codex JSONL',
    lines.length > 0 && parsed === Math.min(50, lines.length),
    `${lines.length} lines, ${parsed}/${Math.min(50, lines.length)} head lines parsed as JSON, ${raw.length} bytes`,
  );
  check(
    'the restored file is the rollout for THIS session uuid',
    byKey.path.toLowerCase().endsWith(`-${victim.session_id.toLowerCase()}.jsonl`),
    byKey.path,
  );
}

// ── 4) The by-uuid (transcript-search deep-link) leg ─────────────────────────
const tmpB = mkdtempSync(join(tmpdir(), 'wi6581-uuid-'));
const byUuid = await rematerializeTranscript(
  { kind: 'codex-rollout', rolloutId: victim.session_id },
  { targetRoot: tmpB },
);
check(
  'codex-rollout: restored AND re-resolved inside the RESTORED root',
  byUuid.reason === 'restored' && !!byUuid.path && byUuid.path.startsWith(tmpB),
  `reason=${byUuid.reason} path=${byUuid.path}`,
);

// ── 5) The trap this bug turned on: the by-uuid resolver's DEFAULT home ──────
const globalHit = await findCodexRolloutPathByUuid(victim.session_id);
check(
  'the by-uuid resolver DEFAULT (global ~/.codex) cannot see a per-session rollout',
  globalHit === null,
  `findCodexRolloutPathByUuid(${victim.session_id}) with no homeOverride => ${globalHit}` +
    ' — which is why the re-resolve must be pointed at the restored root',
);

// ── 6) The production default root IS what the session-key resolver scans ────
const allRoots = await sql<Array<{ session_id: string; session_root: string; adv_session_id: number }>>`
  SELECT session_id, session_root, adv_session_id
    FROM harness_shared.session_archives
   WHERE source_kind = 'codex' AND adv_session_id IS NOT NULL`;
const mismatched = allRoots.filter(
  (r) => r.session_root !== codexHomeForSessionKey(r.adv_session_id),
);
check(
  'every codex archive session_root == codexHomeForSessionKey(adv_session_id)',
  mismatched.length === 0,
  `${allRoots.length} codex archives checked, ${mismatched.length} mismatched` +
    ` — so the no-targetRoot production restore lands exactly where findCodexRolloutPath(sessionKey) walks`,
);

// ── 7) Scale of what this recovers ───────────────────────────────────────────
const recoverable = allRoots.filter((r) => !existsSync(r.session_root));
console.log(
  `\nimpact: ${recoverable.length} / ${allRoots.length} archived codex sessions have NO on-disk` +
    ` session_root left — every one of them rendered empty before this fix.`,
);

// ── 8) Sanity: a second, independent real archive ────────────────────────────
const second = cands.find((c) => c !== victim && !existsSync(c.session_root) && c.file_count > 0);
if (second) {
  const tmpC = mkdtempSync(join(tmpdir(), 'wi6581-2nd-'));
  const r2 = await rematerializeTranscript(
    { kind: 'codex-session-key', sessionKey: String(second.adv_session_id) },
    { targetRoot: tmpC },
  );
  check(
    'a SECOND independent real codex archive also restores + resolves',
    r2.reason === 'restored' && !!r2.path && existsSync(r2.path),
    `adv=${second.adv_session_id} reason=${r2.reason} path=${r2.path}`,
  );
  rmSync(tmpC, { recursive: true, force: true });
}

// ── 9) Nothing was written to the real per-session homes ─────────────────────
check(
  'the probe did NOT resurrect the real session_root (targetRoot honoured)',
  !existsSync(victim.session_root),
  victim.session_root,
);

for (const t of [tmpA, tmpB]) rmSync(t, { recursive: true, force: true });
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await sql.end({ timeout: 5 });
process.exit(failures === 0 ? 0 : 1);
