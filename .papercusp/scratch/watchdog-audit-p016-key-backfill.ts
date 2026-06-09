/**
 * watchdog-audit-2026-06-09 P-016 — one-off data fix over the live backlog:
 *
 *   1. Retitle the still-open checkpoint-prefixed red-test EIs to their
 *      normalized repo-relative paths (post-P-001 re-filings must dedup
 *      against them instead of each earning one renamed re-file).
 *   2. Stamp `payload.watchdogKey` on every OPEN watchdog-filed improvement
 *      whose stable signal key is derivable from its title — so the P-004
 *      key pre-filter covers the standing backlog, not just new captures.
 *
 * Uses the documented verbs (updateIssue / mergeIssuePayload), not raw SQL.
 * Idempotent: skips items that already carry a watchdogKey; title rewrites
 * are no-ops once normalized. Dry-run by default; APPLY=1 to write.
 *
 *   DATABASE_URL=... APPLY=1 npx tsx .papercusp/scratch/watchdog-audit-p016-key-backfill.ts
 */
import { listIssues, updateIssue, mergeIssuePayload, type EngineerIssue } from '../../packages/operator-core/lib/issues-engineer';
import { normalizeRedTestPath } from '../../packages/operator-core/lib/harness/improvements/watchdog';

/** Derive the stable watchdog key from a (current or legacy) watchdog title. */
function deriveKey(i: EngineerIssue): string | null {
  const t = i.title;
  let m = /^Test failing repeatedly: (.+)$/.exec(t);
  if (m) {
    const path = normalizeRedTestPath(m[1]);
    return path ? `red-test:${path}` : null;
  }
  m = /^Tool (\S+) returns a structural error$/.exec(t);
  if (m) return `repeated-tool-error:${m[1]}:structural`;
  m = /^Tool (\S+) timing out repeatedly$/.exec(t);
  if (m) return `repeated-tool-error:${m[1]}:transient`;
  m = /^Tool (\S+) repeatedly rejecting caller input$/.exec(t);
  if (m) return `repeated-tool-error:${m[1]}:caller`;
  // Legacy pre-P-008 title: those tools' standing errors are the structural class.
  m = /^Tool (\S+) erroring repeatedly$/.exec(t);
  if (m) return `repeated-tool-error:${m[1]}:structural`;
  m = /^Service (\S+) is down$/.exec(t);
  if (m) return `service-down:${m[1]}`;
  m = /^Smoke test failing in harness (\S+)$/.exec(t);
  if (m) return `smoke-fail:${m[1]}`;
  if (t === 'Many plan-item claims have expired (abandoned work piling up)') return 'expired-lease:expired-leases';
  m = /^Watchdog collector "(.+)" is failing$/.exec(t);
  if (m) return `watchdog-self:${m[1]}`;
  m = /^Role fire-path for (\S+)\/(\S+) is stuck in error-backoff$/.exec(t);
  if (m) return `fire-circuit-open:circuit:${m[1]}:${m[2]}`;
  m = /^Plan (\S+) appears stuck$/.exec(t);
  if (m) {
    const h = /\(harness ([\w-]+)\)/.exec(i.body)?.[1];
    return h ? `stuck-plan:stuck-plan:${h}:${m[1]}` : null;
  }
  // 'Agent spawns are failing repeatedly' (pre-P-008 single-key) and
  // 'Unresolved escalation…' (phase not derivable) stay key-less by design —
  // the title net still covers them.
  return null;
}

async function main(): Promise<void> {
  const apply = process.env.APPLY === '1';
  const open = await listIssues({ state: 'open', limit: 500 });
  const watchdogItems = open.filter((i) => i.foundDuring === 'improvement-watchdog' || i.foundDuring === 'improvement-watchdog-backfill');
  let retitled = 0, stamped = 0, skippedKeyed = 0, skippedUnderivable = 0;
  for (const i of watchdogItems) {
    // 1. Retitle checkpoint-prefixed red-test items to the normalized path.
    const m = /^Test failing repeatedly: (.+)$/.exec(i.title);
    if (m) {
      const normalized = normalizeRedTestPath(m[1]);
      if (normalized && normalized !== m[1]) {
        console.log(`${i.id}: retitle → Test failing repeatedly: ${normalized}`);
        if (apply) await updateIssue(i.id, { title: `Test failing repeatedly: ${normalized}`, silent: true, by: 'watchdog-audit-P-016' });
        retitled += 1;
        i.title = `Test failing repeatedly: ${normalized}`;
      }
    }
    // 2. Stamp the watchdogKey when derivable and not already present.
    const existingKey = (i.payload as Record<string, unknown> | null)?.watchdogKey;
    if (typeof existingKey === 'string' && existingKey) { skippedKeyed += 1; continue; }
    const key = deriveKey(i);
    if (!key) {
      console.log(`${i.id}: SKIP (key not derivable): ${i.title}`);
      skippedUnderivable += 1;
      continue;
    }
    console.log(`${i.id}: stamp watchdogKey = ${key}`);
    if (apply) await mergeIssuePayload(i.id, { watchdogKey: key });
    stamped += 1;
  }
  console.log(`\n${apply ? 'APPLIED' : 'DRY-RUN'}: ${watchdogItems.length} open watchdog items — ${retitled} retitled, ${stamped} keys stamped, ${skippedKeyed} already keyed, ${skippedUnderivable} underivable (title net covers them).`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
