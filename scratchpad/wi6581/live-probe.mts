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
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived, never hardcoded: this file sits at <repo>/scratchpad/wi6581/.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIB = join(REPO, 'packages/operator-core/lib');

const { rematerializeTranscript } = await import(`${LIB}/session-transcript-remat.ts`);
const { findCodexRolloutPath, findCodexRolloutPathByUuid, __resetTranscriptResolverCaches } =
  await import(`${LIB}/session-transcript-resolvers.ts`);
const { findArchivedSessionIdForAdv } = await import(`${LIB}/session-archive.ts`);
const { getOrgPg } = await import('@papercusp/db-org');
const { codexHomeForSessionKey } = await import(
  join(REPO, 'libs/papercusp/packages/orchestrator/src/session-launch-dirs.ts')
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

// ── 2b) The trap this bug turned on — checked BEFORE any restore, because the
//        resolver memoises by uuid and a homeOverride hit would poison it ─────
__resetTranscriptResolverCaches();
const globalHit = await findCodexRolloutPathByUuid(victim.session_id);
const keyHit = await findCodexRolloutPath(String(victim.adv_session_id));
check(
  'neither resolver DEFAULT can see the rollout — it exists only in the archive',
  globalHit === null && keyHit === null,
  `byUuid(global ~/.codex) => ${globalHit}; bySessionKey(natural home) => ${keyHit}` +
    ' — so the re-resolve MUST be pointed at the root the restore wrote to',
);
__resetTranscriptResolverCaches();

// ── 3) The full codex-session-key leg, restoring into a scratch root ─────────
__resetTranscriptResolverCaches();
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
__resetTranscriptResolverCaches();
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

// ── 5) The corpus: how many codex archive roots are NON-standard ─────────────
// A tempting simpler fix — restore, then re-resolve with the resolver's own
// default home — happens to work whenever session_root == the natural
// per-session home. It is wrong for any archive that does not, which is why
// this probe checks the real corpus rather than assuming the shape.
const allRoots = await sql<Array<{ session_id: string; session_root: string; adv_session_id: number }>>`
  SELECT session_id, session_root, adv_session_id
    FROM harness_shared.session_archives
   WHERE source_kind = 'codex' AND adv_session_id IS NOT NULL`;
const nonStandard = allRoots.filter(
  (r) => r.session_root !== codexHomeForSessionKey(r.adv_session_id),
);
console.log(
  `\ncorpus: ${allRoots.length} codex archives; ${nonStandard.length} with a NON-standard ` +
    `session_root (${nonStandard.map((r) => r.session_root).join(', ') || 'none'}) — ` +
    `a default-home re-resolve would silently miss those.\n`,
);

// ── 6) …and that a NON-standard-root archive still restores + resolves ───────
for (const odd of nonStandard) {
  const tmpD = mkdtempSync(join(tmpdir(), 'wi6581-odd-'));
  __resetTranscriptResolverCaches();
  const rOdd = await rematerializeTranscript(
    { kind: 'codex-session-key', sessionKey: String(odd.adv_session_id) },
    { targetRoot: tmpD },
  );
  check(
    `non-standard root (${odd.session_root}) still restores from the archive`,
    rOdd.reason === 'restored' || rOdd.reason === 'restored_but_unresolved',
    `adv=${odd.adv_session_id} reason=${rOdd.reason} path=${rOdd.path}`,
  );
  rmSync(tmpD, { recursive: true, force: true });
}

// ── 7) Scale of what this recovers ───────────────────────────────────────────
const recoverable = allRoots.filter((r) => !existsSync(r.session_root));
console.log(
  `\nimpact: ${recoverable.length} / ${allRoots.length} archived codex sessions have NO on-disk` +
    ` session_root left — every one of them rendered empty before this fix.`,
);

// ── 8) Sanity: a second, independent real archive ────────────────────────────
const second = cands.find((c) => c !== victim && !existsSync(c.session_root) && c.file_count > 0);
if (second) {
  __resetTranscriptResolverCaches();
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
