import assert from 'node:assert/strict';

export const ROSTER_PROOF_KEYS = [
  'ROSTER_COORD_HTTP_PROOF', 'ROSTER_COORD_BROWSER_PROOF', 'ROSTER_STOP_BROWSER_PROOF',
  'ROSTER_HISTORY_BROWSER_PROOF', 'ROSTER_HUD_BROWSER_PROOF', 'ROSTER_HEALTH_BROWSER_PROOF',
  'ROSTER_WORK_BROWSER_PROOF', 'ROSTER_TESTING_BROWSER_PROOF', 'ROSTER_INSIGHTS_BROWSER_PROOF',
  'ROSTER_HARNESS_SETTINGS_BROWSER_PROOF', 'ROSTER_BRAINSTORM_BROWSER_PROOF', 'ROSTER_DOCS_BROWSER_PROOF',
  'ROSTER_PROJECT_HISTORY_BROWSER_PROOF', 'ROSTER_CALENDAR_BROWSER_PROOF', 'ROSTER_LEARNING_BROWSER_PROOF',
  'ROSTER_WORKFLOWS_BROWSER_PROOF', 'ROSTER_STATS_BROWSER_PROOF', 'ROSTER_GIT_BROWSER_PROOF',
  'ROSTER_CONVERSATIONS_BROWSER_PROOF', 'ROSTER_CREATE_DOCK_BROWSER_PROOF', 'ROSTER_OVERVIEW_BROWSER_PROOF',
  'ROSTER_PLANS_BROWSER_PROOF', 'ROSTER_INBOX_BROWSER_PROOF', 'ROSTER_DEV_BROWSER_PROOF',
  'ROSTER_SHORTCUT_BROWSER_PROOF', 'ROSTER_SETTINGS_BROWSER_PROOF', 'ROSTER_PROMPTS_BROWSER_PROOF',
  'ROSTER_CUPBOARD_BROWSER_PROOF',
] as const;

/** Serialize only fixture-owned controls, before with-test-pg removes ambient product state. */
export function rosterStopHttpControlArgs(source: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('ROSTER_') || !key.endsWith('_PROOF') || value === undefined || value === '' || value === '0') continue;
    assert.ok(ROSTER_PROOF_KEYS.some(known => known === key), `unknown roster fixture proof: ${key}`);
    assert.equal(value, '1', `roster fixture proof ${key} must be 1 or 0`);
    args.push(`--roster-proof=${key}`);
  }
  if (source.ROSTER_STOP_HTTP_MUTATION) {
    assert.equal(source.ROSTER_STOP_HTTP_MUTATION, 'misroute', 'unsupported roster fixture mutation');
    args.push('--stop-http-mutation=misroute');
  }
  return args;
}

/** Other argv belongs to the existing source/bundle preflights, not to this selector. */
export function parseRosterStopHttpControls(argv: readonly string[]) {
  const proofs: Partial<Record<typeof ROSTER_PROOF_KEYS[number], '1'>> = {};
  let healthCleanupProof = false;
  let healthPublicationProof = false;
  let mutation: 'misroute' | undefined;
  for (const arg of argv) {
    if (arg.startsWith('--roster-proof') || arg.startsWith('--browser-proof')) {
      const prefix = arg.startsWith('--roster-proof=') ? '--roster-proof=' : '--browser-proof=';
      assert.ok(arg.startsWith(prefix), 'roster fixture proof requires an explicit value');
      const key = arg.slice(prefix.length);
      assert.ok(ROSTER_PROOF_KEYS.some(known => known === key), `unknown roster fixture proof: ${key}`);
      const selected = key as typeof ROSTER_PROOF_KEYS[number];
      assert.equal(proofs[selected], undefined, `duplicate roster fixture proof: ${key}`);
      proofs[selected] = '1';
    } else if (arg.startsWith('--health-cleanup-proof')) {
      assert.equal(arg, '--health-cleanup-proof', 'invalid roster health cleanup control');
      assert.equal(healthCleanupProof, false, 'duplicate roster health cleanup control');
      healthCleanupProof = true;
    } else if (arg.startsWith('--health-publication-proof')) {
      assert.equal(arg, '--health-publication-proof', 'invalid roster health publication control');
      assert.equal(healthPublicationProof, false, 'duplicate roster health publication control');
      healthPublicationProof = true;
    } else if (arg.startsWith('--stop-http-mutation')) {
      assert.equal(arg, '--stop-http-mutation=misroute', 'unsupported roster fixture mutation');
      assert.equal(mutation, undefined, 'duplicate roster fixture mutation');
      mutation = 'misroute';
    }
  }
  assert.ok(!healthCleanupProof || !healthPublicationProof, 'roster health proof modes are mutually exclusive');
  if (healthCleanupProof || healthPublicationProof) {
    proofs.ROSTER_COORD_BROWSER_PROOF = '1';
    proofs.ROSTER_HEALTH_BROWSER_PROOF = '1';
    if (healthPublicationProof) proofs.ROSTER_COORD_HTTP_PROOF = '1';
  }
  return { proofs, healthCleanupProof, healthPublicationProof, mutation };
}
