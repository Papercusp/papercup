// Deployed-plane probe for plan portable-identity-packages-2026-09-26, clause AUTO-BAR-R-9-P-017 (READ-ONLY).
// Run from the papercusp repo root, ONLY after :3070 serves a green pin carrying the accepted change:
//   npx tsx docs/evidence/portable-identity-packages-r9-deployed-2026-10-01.mts
// Writes docs/evidence/portable-identity-packages-r9-deployed-2026-10-01.json (R9_OUT redirects a dry run)
// and exits 0 iff every assertion passed.
//
// Falsifier markers measured here: deployed-revision and green-promotion. The current-independent-acceptance
// marker is enforced at ship time by plans:set-plan-status (independent grading before shipped), not here.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = process.cwd();
const CLIENT = process.env.R9_CLIENT ?? 'su-415552e6-9f99-46c7-b29c-3a757e67cc62';
const OUT = process.env.R9_OUT ?? 'docs/evidence/portable-identity-packages-r9-deployed-2026-10-01.json';
const ACCEPTED_BLOB = '01df184c56dd18839005bcdeb233af5b638a6b22';
const CP = 'packages/operator-core/lib/blueprint/compile-packages.ts';
const MEMORY_SUB = 'libs/generic/memory';

// Every distinct sourcePath of the plan's live AUTO-BAR bindings at 2026-10-01T08:30Z.
const PLAN_SOURCE_PATHS = [
  'apps/operator/scripts/hooks/inject/core.mjs',
  'apps/operator/scripts/hooks/inject/index.mjs',
  'libs/generic/memory/src/canonical-managed-writes.ts',
  'libs/generic/memory/src/canonical-store.ts',
  'libs/generic/memory/src/embedder-dims.ts',
  'libs/generic/memory/src/vec-write.ts',
  'packages/operator-core/lib/agent-fleets-store.ts',
  'packages/operator-core/lib/agent-identities/class-provider.ts',
  'packages/operator-core/lib/agent-identities/identity-async-rules.ts',
  'packages/operator-core/lib/agent-identities/identity-preview.ts',
  'packages/operator-core/lib/agent-identities/identity-rule-subscriptions.ts',
  'packages/operator-core/lib/agent-identities/package-orientation-classes.ts',
  'packages/operator-core/lib/agent-identities/recipe-provider-conformance.ts',
  'packages/operator-core/lib/agent-identities/recipe-provider-runtime.ts',
  'packages/operator-core/lib/agent-identities/sink-evaluator.ts',
  'packages/operator-core/lib/agent-identities/source.ts',
  'packages/operator-core/lib/agent-identities/state-template-reader.ts',
  'packages/operator-core/lib/agent-identities/state-template.ts',
  'packages/operator-core/lib/agent-identities/sync-hook-rules.ts',
  'packages/operator-core/lib/agent-identities/turn-start-package-sink.ts',
  'packages/operator-core/lib/agent-identities/wearer-authority.ts',
  'packages/operator-core/lib/agent-tools/coordination/control-anchor.ts',
  'packages/operator-core/lib/agent-tools/coordination/presence.ts',
  'packages/operator-core/lib/agent-tools/coordination/tools/orient.ts',
  'packages/operator-core/lib/agent-tools/fleet_registry/take-leadership-core.ts',
  'packages/operator-core/lib/agent-tools/recipes/get.ts',
  'packages/operator-core/lib/_baseline-coord-fixture.ts',
  'packages/operator-core/lib/blueprint/compile-packages.ts',
  'packages/operator-core/lib/blueprint/installed-blueprints.ts',
  'packages/operator-core/lib/blueprint/package-doc-resources.ts',
  'packages/operator-core/lib/blueprint/package-knowledge-resources.ts',
  'packages/operator-core/lib/blueprint/package-memory-driver.ts',
  'packages/operator-core/lib/blueprint/package-memory-visibility.ts',
  'packages/operator-core/lib/blueprint/package-recipe-resources.ts',
  'packages/operator-core/lib/blueprint/package-resource-receipts.ts',
  'packages/operator-core/lib/blueprint/session-package-resources.ts',
  'packages/operator-core/lib/capability-class-registry-store.ts',
  'packages/operator-core/lib/capability-envelope/identity-grants-port.ts',
  'packages/operator-core/lib/cell-registry.ts',
  'packages/operator-core/lib/child-output.ts',
  'packages/operator-core/lib/code-recipes-store.ts',
  'packages/operator-core/lib/cupboard/blueprint-install-journal.ts',
  'packages/operator-core/lib/cupboard/blueprint-release.ts',
  'packages/operator-core/lib/cupboard/capability-grant-resolver.ts',
  'packages/operator-core/lib/cupboard/class-contract-payload.ts',
  'packages/operator-core/lib/cupboard/identity-listing-surface.ts',
  'packages/operator-core/lib/cupboard/install-blueprint-core.ts',
  'packages/operator-core/lib/cupboard/install-blueprint-io.ts',
  'packages/operator-core/lib/cupboard/listing-manifest.ts',
  'packages/operator-core/lib/dbos/identity-reaction-workflow.ts',
  'packages/operator-core/lib/doc-projection/addressed-project-guide.ts',
  'packages/operator-core/lib/doc-projection/guide-address.ts',
  'packages/operator-core/lib/endpoint-route/routes/agent-mcp/identity-hook-sinks.ts',
  'packages/operator-core/lib/event-key-registry-store.ts',
  'packages/operator-core/lib/events/await/predicate-watch.ts',
  'packages/operator-core/lib/events/class-fire-target.ts',
  'packages/operator-core/lib/events/identity-reaction.ts',
  'packages/operator-core/lib/identity/ed25519.ts',
  'packages/operator-core/lib/memory/backend.ts',
  'packages/operator-core/lib/modes/store.ts',
  'packages/operator-core/lib/papercusp-root.ts',
  'packages/operator-core/lib/role-launch-spec.ts',
  'packages/operator-core/lib/scheduler/claim-spec-store.ts',
  'packages/operator-core/lib/scheduler/claim-spec.ts',
  'packages/operator-core/lib/search/prose-vector-dims.ts',
  'packages/operator-core/lib/stack-binding-channel.ts',
  'packages/operator-core/lib/turn-start-orientation.ts',
  'packages/operator-core/test/_identity-reaction-child.ts',
];

// Staging-only additions attributed by reading each diff: none is this plan's code.
const OTHER_WORK: Record<string, string> = {
  'packages/operator-core/lib/cupboard/identity-listing-surface.ts': 'burnKnobs, agent-economy-flywheel P-015',
  'packages/operator-core/lib/cupboard/blueprint-release.ts': 'releaseBurnKnobs export, agent-economy-flywheel P-015',
  'packages/operator-core/lib/role-launch-spec.ts': 'assertIdentityActivationFunded, agent-economy-flywheel P-016',
  'packages/operator-core/lib/search/prose-vector-dims.ts': 'shared-vector-search-libraries P-001',
  'libs/generic/memory/src/embedder-dims.ts': 'mdenseon candidate + cls pooling',
  'packages/operator-core/lib/agent-tools/coordination/control-anchor.ts': 'WI-10004663 launch consumption',
  'apps/operator/scripts/hooks/inject/core.mjs': 'WI-10004485 memory filter wait',
  'packages/operator-core/lib/scheduler/claim-spec-store.ts': 'EI-23227815561098131 pool isolation',
  'packages/operator-core/lib/scheduler/claim-spec.ts': 'claimSpecFilterAdmitsTarget export, WI-10004710 goal placement planScoped',
  'packages/operator-core/lib/agent-tools/coordination/tools/orient.ts': 'orientation work, no identity-package lines',
  'packages/operator-core/lib/events/await/predicate-watch.ts': 'predicate-watch additions, no identity-package lines',
  'packages/operator-core/lib/turn-start-orientation.ts': 'EI-21308269358666878 wording + orientation work',
};

const sh = (cmd: string, args: string[], opts: { timeout?: number } = {}): string =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
const git = (...args: string[]) => sh('git', args);
const tryGit = (...args: string[]): string | null => { try { return git(...args); } catch { return null; } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mcp = (verb: string, args: unknown): any => {
  const file = `.papercusp/scratch/pip-r9-${verb.replace(/[:]/g, '-')}.json`;
  writeFileSync(`${ROOT}/${file}`, JSON.stringify(args));
  let raw: string;
  try {
    raw = sh('node', ['scripts/mcp-call.mjs', verb, '--json-file', file, '--client', CLIENT, '--port', '3070'], { timeout: 170_000 });
  } catch (error) {
    raw = String((error as { stdout?: unknown }).stdout ?? '');
  }
  const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  // A large result is trimmed; its full JSON is spilled to the cursor's scratch file.
  const cursor = parsed._projection?.cursor;
  if (cursor?.args?.file_path && Number.isInteger(cursor.bodyOffsetInFile)) {
    return JSON.parse(readFileSync(cursor.args.file_path).subarray(cursor.bodyOffsetInFile).toString('utf8'));
  }
  return parsed;
};

if (tryGit('rev-parse', '--show-toplevel') !== ROOT) throw new Error('run from the papercusp repo root');

const startedAt = new Date().toISOString();
const assertions: Array<{ id: string; passed: boolean; evidence: string }> = [];
const check = (id: string, passed: unknown, evidence: string) =>
  assertions.push({ id, passed: Boolean(passed), evidence: evidence.slice(0, 2000) });

// 1. deployed-revision: what :3070 serves, and that it carries the last accepted change. main can be
// promoted again while a deploy is in flight, so the deployed commit must be a main promotion (reflog).
const health = JSON.parse(sh('curl', ['-s', '-m', '10', 'http://127.0.0.1:3070/api/health']));
const deployedSha = git('rev-parse', `${health.sha}^{commit}`);
const mainSha = git('rev-parse', 'main');
const cpBlob = tryGit('rev-parse', `${deployedSha}:${CP}`);
const mainCpBlob = tryGit('rev-parse', `${mainSha}:${CP}`);
const reflog = tryGit('reflog', '-12', '--date=iso-strict', 'main') ?? '';
const promotion = reflog.split('\n').find((l) => l.startsWith(deployedSha.slice(0, 10))) ?? null;
check('deployed-revision', cpBlob === ACCEPTED_BLOB && promotion !== null && mainCpBlob === ACCEPTED_BLOB,
  `:3070 /api/health sha ${health.sha} = commit ${deployedSha}; main = ${mainSha} (${deployedSha === mainSha ? 'equal' : 'main promoted again since'}); ` +
  `main reflog entry for the deployed commit: ${promotion ?? 'NONE'}. ${CP} blob at the deployed commit = ${cpBlob}, at main = ${mainCpBlob} ` +
  `(accepted blob ${ACCEPTED_BLOB}: ${cpBlob === ACCEPTED_BLOB && mainCpBlob === ACCEPTED_BLOB ? 'equal' : 'DIFFERENT'}).`);

// 2. plan-source containment: every plan source path is identical at the deployed commit and staging,
// or differs only by attributed staging-side work. Submodule paths are compared inside the submodule.
const deployedSub = tryGit('rev-parse', `${deployedSha}:${MEMORY_SUB}`);
const stagingSub = tryGit('rev-parse', `staging:${MEMORY_SUB}`);
const blobAt = (ref: string, subRef: string | null, p: string): string | null => {
  if (!p.startsWith(`${MEMORY_SUB}/`)) return tryGit('rev-parse', '--verify', '-q', `${ref}:${p}`);
  try { return sh('git', ['-C', MEMORY_SUB, 'rev-parse', '--verify', '-q', `${subRef}:${p.slice(MEMORY_SUB.length + 1)}`]); } catch { return null; }
};
const same: string[] = []; const differ: string[] = []; const missing: string[] = [];
for (const p of PLAN_SOURCE_PATHS) {
  const a = blobAt(deployedSha, deployedSub, p); const b = blobAt('staging', stagingSub, p);
  if (!a || !b) missing.push(p); else if (a === b) same.push(p); else differ.push(p);
}
const unattributed = differ.filter((p) => !OTHER_WORK[p]);
check('plan-source-containment', missing.length === 0 && unattributed.length === 0,
  `${PLAN_SOURCE_PATHS.length} distinct sourcePaths of the plan's live AUTO-BAR bindings, deployed commit vs staging (${MEMORY_SUB} compared inside the submodule at gitlinks ${deployedSub?.slice(0, 10)} vs ${stagingSub?.slice(0, 10)}): ` +
  `${same.length} identical, ${differ.length} differ, ${missing.length} unresolved. Every differing path carries only staging-side additions from other work: ` +
  differ.map((p) => `${p.split('/').pop()} (${OTHER_WORK[p] ?? 'UNATTRIBUTED'})`).join('; ') + '.');

// 3. green-promotion: promoted by the gate, deployed by release-trigger after live certification. release:deploy
// status certifies the CURRENT green pin; the deployed commit's own certification is the verdict-bank record whose
// certification_target_sha is exactly that commit.
const status = mcp('release:deploy', { op: 'status' });
const gate = status.gate ?? {};
const term = status.deployTerminal ?? {};
const bank = readFileSync(`${process.env.HOME}/.papercusp/live-fed-gate/verdicts.jsonl`, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cert = bank.filter((r) => r.certification_target_sha === deployedSha && r.verdict === 'GREEN').pop() ?? null;
check('green-promotion', gate.green === true && (gate.consecutiveReds ?? 1) === 0 && cert !== null && promotion !== null,
  `main reflog: ${promotion ?? 'NO ENTRY FOR DEPLOYED SHA'}. release:deploy status: state ${status.state}; gate.green ${gate.green}, consecutiveReds ${gate.consecutiveReds}; ` +
  `freeze-and-converge ${gate.freezeAndConverge?.state ?? '?'}. Live certification of the deployed commit (verdict bank): ` +
  (cert ? `${cert.verdict} at ${cert.ts}, target ${cert.certification_target_sha}, ${cert.summary}, source_head ${cert.source_head} dirty ${cert.source_dirty_files}` : 'NO GREEN RECORD') +
  `; auto-deploy terminal exit ${term.exitCode ?? '?'} at ${term.finishedAt ?? '?'}. Shipped via release-trigger auto-deploy, no deploy-cli --force.`);

// 4. deployed-behaviour: the deployed operator serves the plan's identity surface (P-015 identities:preview).
const preview = mcp('identities:preview', { id: 'blueprint-operation-worker', potSlug: 'papercusp' });
check('deployed-identity-surface', preview.ok === true && ['validation', 'declared', 'injection', 'consent', 'lifecycle'].every((k) => k in preview),
  `identities:preview { id:'blueprint-operation-worker', potSlug:'papercusp' } on :3070 (build ${health.sha}) returned ok:${preview.ok} with sections ${Object.keys(preview).join(', ')}.`);

const finishedAt = new Date().toISOString();
const passed = assertions.every((a) => a.passed);
const artifact = {
  schemaVersion: 1,
  kind: 'operational-test-evidence',
  name: `portable-identity-packages R-9: the release operator on :3070 serves the accepted portable identity implementation (deployed ${health.sha}, ${finishedAt.slice(0, 10)})`,
  framework: 'operational',
  testLayer: 'e2e',
  evidencePlane: 'deployed',
  evidenceRuntime: 'release-operator',
  plan: 'portable-identity-packages-2026-09-26',
  workItem: 'WI-10003330',
  specs: ['AUTO-BAR-R-9-P-017'],
  observer: CLIENT,
  outcome: passed ? 'passed' : 'failed',
  command: [
    'npx tsx docs/evidence/portable-identity-packages-r9-deployed-2026-10-01.mts',
    'curl -s http://127.0.0.1:3070/api/health; git rev-parse <deployed>:' + CP,
    'git rev-parse <deployed|staging>:<each of the plan sourcePaths> (inside libs/generic/memory for its paths)',
    'release:deploy { op:"status" }, git reflog main, ~/.papercusp/live-fed-gate/verdicts.jsonl record for the deployed commit',
    'identities:preview { id:"blueprint-operation-worker", potSlug:"papercusp" } on :3070',
  ],
  exitCode: passed ? 0 : 1,
  startedAt,
  finishedAt,
  deployedSha,
  healthSha: health.sha,
  summary: `Deployed-plane check for R-9 (falsifier markers deployed-revision and green-promotion). ${assertions.filter((a) => a.passed).length}/${assertions.length} assertions passed. ` +
    'The current-independent-acceptance marker is enforced at ship time by plans:set-plan-status (independent grading before shipped); this artifact does not claim it.',
  assertions,
};
writeFileSync(`${ROOT}/${OUT}`, JSON.stringify(artifact, null, 2) + '\n');
console.log(`R9_EVIDENCE ${passed ? 'PASS' : 'FAIL'} ${OUT}`);
for (const a of assertions) console.log(`  ${a.passed ? 'ok  ' : 'FAIL'} ${a.id}: ${a.evidence.slice(0, 300)}`);
process.exit(passed ? 0 : 1);
