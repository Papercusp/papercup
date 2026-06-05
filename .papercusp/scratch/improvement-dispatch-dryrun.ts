/**
 * Dry-run of the auto-implement dispatch decision against the LIVE backlog
 * (close-the-self-improvement-loop-2026-06-05 P3 prep). READ-ONLY — simulates
 * flagEnabled:true + a runner so we can see exactly WHAT an armed loop would
 * dispatch, before any owner arms it. Run:
 *   DATABASE_URL=... npx tsx .papercusp/scratch/improvement-dispatch-dryrun.ts
 */
import { readImprovementItems } from '../../packages/operator-core/lib/harness/improvements/read-items';
import { buildDigest } from '../../packages/operator-core/lib/harness/improvements/digest';
import { planImplementRun } from '../../packages/operator-core/lib/harness/improvements/plan-implement';

async function main(): Promise<void> {
  const items = await readImprovementItems({});
  const open = items.filter((i) => (i.state ?? 'open') === 'open');
  const digest = buildDigest(items, { nowMs: Date.now() });
  const plan = planImplementRun({
    items: open,
    flagEnabled: true, // SIMULATED — the real flag is OFF
    runnerHarness: 'improvement-runner', // SIMULATED
    maxPerRun: 3,
  });

  console.log(JSON.stringify({
    totals: { captured: items.length, open: open.length },
    headline: digest.headline,
    autoLane: digest.autoEligible.map((s) => ({ id: s.id, sev: s.severity, score: s.score, title: s.title.slice(0, 70), why: s.tierReason.slice(0, 60) })),
    humanQueue: digest.humanQueue.map((s) => ({ id: s.id, kind: s.kind, title: s.title.slice(0, 70), why: s.tierReason.slice(0, 80) })),
    likelyDuplicates: digest.likelyDuplicates,
    wouldDispatch: { action: plan.action, message: plan.message, candidates: plan.candidates.map((c) => c.id) },
  }, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
