// T4 pipeline probe (memory-backend-benchmark P-009): run ONE memory
// boot-recall scenario against the live operator brain via the existing
// llm-testing runner. MEM00 is the unseeded control (no live memory
// write) — it proves the operator-target + sim-user + judge pipeline is
// reachable before any seeded run.
import { runScenario } from '@papercusp/testing-shell/llm';
import { operatorRunnerDeps } from '../../packages/operator-core/lib/llm-testing/deps';
import { SCENARIOS } from '../../packages/operator-core/lib/llm-testing/scenarios';

const id = process.argv[2] ?? 'op-MEM00-control-unseeded';
const scenario = SCENARIOS.find((s) => s.id === id);
if (!scenario) {
  console.error('scenario not found:', id, '— have:', SCENARIOS.filter((s) => s.id.startsWith('op-MEM')).map((s) => s.id).join(', '));
  process.exit(2);
}

const deps = operatorRunnerDeps({ persist: false });
console.log('running', id, 'against', process.env.PAPERCUSP_LLM_TEST_OPERATOR_URL ?? 'http://127.0.0.1:3070');
try {
  const report = await runScenario(scenario, { forceRepeat: 1 }, deps);
  const run = report.runs[0];
  const turns = run.summary.turns;
  console.log('--- RESULT ---');
  console.log('verdict:', report.verdict, '| status:', run.status);
  console.log('turns:', turns.length, '| finishReason:', run.summary.finishReason);
  console.log('violations:', JSON.stringify(run.violations.map((v) => ({ k: v.assertKind, s: v.severity, claim: v.claim?.slice(0, 80) }))));
  const allText = turns.map((t) => t.assistantText).join(' ');
  console.log('seeded-token present in any assistant turn:', /31785|salt|migration|isolate/i.test(allText) ? 'CHECK→' + (allText.match(/\b(31785|[A-Z_]{6,})\b/)?.[0] ?? '') : 'no obvious token');
  console.log('last assistant text (first 400):', turns[turns.length - 1]?.assistantText.slice(0, 400));
  console.log('judge scores:', JSON.stringify(run.judge.scores));
} catch (e) {
  console.error('RUN FAILED:', (e as Error).message);
  console.error((e as Error).stack?.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
process.exit(0);
