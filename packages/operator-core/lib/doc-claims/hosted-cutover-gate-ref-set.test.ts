/**
 * Pin: the P-028 cut-over gate dereferences EXACTLY the references the hosted
 * runtime dereferences — no more, no less.
 *
 * WI-2141402 / D-046 was one direction of this drift. `--check-env` tested
 * `[[ -n "$NAME" ]]` over names whose value is the NAME of a secret to look up,
 * so `set` never meant "resolves" and the gate would have gone green with the
 * WorkOS secrets absent. The gate now resolves them.
 *
 * The OTHER direction is just as wrong and was live in the same fix:
 * `WORKOS_WEBHOOK_SECRET_KEY_REF` carries the `_REF` suffix but is never
 * dereferenced — `createWorkOsWebhookRoute` hands it to the receipt store,
 * which records it verbatim as provenance (`workos-webhook-intake.ts`
 * `safeExternalRef`). Resolving it in the gate turns a correctly configured
 * deployment RED and blocks a cut-over that should proceed.
 *
 * Both directions are the same defect class: the gate's predicate and the
 * runtime's predicate drifting apart. Neither can be caught by reading one side
 * alone, and both are silent — a false green publishes a broken profile behind
 * app.papercusp.com, a false red blocks the cut-over with no failing component
 * to point at. So the two lists are pinned to each other here (derived-truth
 * ladder rung 2: PIN prose/config that cannot be derived).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HOSTED_RUNTIME_RESOLVED_SECRET_REFS } from '../endpoint-route/hosted-runtime';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/**
 * Defaults to the real script. The override exists so falsifiability can be
 * proven against a frozen historical snapshot (`scripts/mutation-probe.sh
 * --against-commit`) instead of by mutating this shared, auto-committed tree.
 */
const SCRIPT =
  process.env.PAPERCUSP_HOSTED_CUTOVER_SCRIPT ??
  resolve(ROOT, 'apps/operator/scripts/systemd/deploy-hosted-control-plane.sh');

/** Read a literal `NAME=( a b c )` bash array. Throws if the array is absent. */
function bashArray(source: string, name: string): string[] {
  const match = new RegExp(`^${name}=\\(([^)]*)\\)`, 'm').exec(source);
  if (!match) throw new Error(`bash array not found in the cut-over script: ${name}`);
  return match[1]
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

describe('P-028 cut-over gate reference set', () => {
  const script = readFileSync(SCRIPT, 'utf8');

  it('dereferences exactly the references the hosted runtime dereferences', () => {
    expect(bashArray(script, 'REF_NAMES')).toEqual(HOSTED_RUNTIME_RESOLVED_SECRET_REFS.map((ref) => ref.env));
  });

  it('never dereferences a name the runtime only stores as a label', () => {
    const resolved = new Set<string>(HOSTED_RUNTIME_RESOLVED_SECRET_REFS.map((ref) => ref.env));
    const labels = bashArray(script, 'OPTIONAL_LABEL_NAMES');

    expect(labels).toContain('WORKOS_WEBHOOK_SECRET_KEY_REF');
    for (const label of labels) expect(resolved.has(label)).toBe(false);
    // A label must not be handed to the resolver entrypoint either — the gate
    // passes only REF_NAMES to it, so an --optional flag reaching that call is
    // the regression this line catches.
    expect(script).not.toMatch(/hosted-check-refs\.ts[^\n]*--optional/);
  });

  it('reads the two arrays it is pinning (fixture control)', () => {
    // Calibration: a broken reader would make BOTH assertions above vacuous.
    expect(bashArray(script, 'REF_NAMES').length).toBeGreaterThan(0);
    expect(bashArray(script, 'OPTIONAL_LABEL_NAMES').length).toBeGreaterThan(0);
    expect(() => bashArray(script, 'NAME_THAT_IS_NOT_IN_THE_SCRIPT')).toThrow(/bash array not found/);
  });
});
