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
 *
 * WI-2141766: the first version of this pin covered only the REFERENCE leg, so
 * the gate's LITERAL_NAMES could still drift from the runtime — the very defect
 * the pin exists to prevent, moved one array to the left. The gate necessarily
 * holds its own copy of the literal/reference PARTITION, because it has to test
 * the two halves differently, so every name in that partition needs pinning,
 * not just the half that failed first.
 *
 * The closure is against `readHostedRuntimeConfiguration` ITSELF, exercised
 * rather than re-read: the catalogues are proven to be exactly the names it
 * requires (drop one and it must refuse; supply only them and it must succeed;
 * its result must carry no field the catalogues do not name). A new required
 * name therefore fails here even if someone remembers to update both the
 * runtime catalogue and the script — which is the case a list-vs-list pin is
 * blind to.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HOSTED_RUNTIME_LITERAL_CONFIGURATION,
  HOSTED_RUNTIME_OPTIONAL_LABELS,
  HOSTED_RUNTIME_RESOLVED_SECRET_REFS,
  readHostedRuntimeConfiguration,
  type HostedRuntimeConfiguration,
} from '../endpoint-route/hosted-runtime';

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

type ConfigurationName = { readonly field: keyof HostedRuntimeConfiguration; readonly env: string };

/** Every name the gate treats as REQUIRED, in the order it tests them. */
const REQUIRED_CATALOGUE: readonly ConfigurationName[] = [
  ...HOSTED_RUNTIME_LITERAL_CONFIGURATION,
  ...HOSTED_RUNTIME_RESOLVED_SECRET_REFS,
];

/**
 * Check a catalogue against the reader ITSELF rather than against another list,
 * and return the first divergence (or null).
 *
 * Supply exactly the catalogued names: the reader must succeed, produce exactly
 * the catalogued fields, and route each value to its own field. Then drop each
 * name in turn: the reader must refuse, naming that name. A list-vs-list pin
 * cannot distinguish "agrees with the runtime" from "agrees with a stale copy
 * of the runtime"; this can, because the runtime is what answers.
 *
 * `read` is injectable ONLY so the controls can run this against a
 * deliberately-wrong reader — production always passes the real one.
 */
function catalogueClosureFailure(
  catalogue: readonly ConfigurationName[],
  read: (env: NodeJS.ProcessEnv) => HostedRuntimeConfiguration = readHostedRuntimeConfiguration,
): string | null {
  const complete = Object.fromEntries(catalogue.map((one) => [one.env, `value-for-${one.env}`]));

  let configuration: HostedRuntimeConfiguration;
  try {
    configuration = read(complete);
  } catch (error) {
    // The reader needs a name the catalogue does not carry.
    return `incomplete: ${error instanceof Error ? error.message : String(error)}`;
  }

  const produced = Object.keys(configuration).sort();
  const catalogued = catalogue.map((one) => one.field).sort();
  if (produced.join(',') !== catalogued.join(',')) return `field set: ${produced.join(',')} != ${catalogued.join(',')}`;
  for (const { field, env } of catalogue) {
    if (configuration[field] !== `value-for-${env}`) return `misrouted: ${env} did not land in ${field}`;
  }

  for (const { env } of catalogue) {
    const { [env]: _dropped, ...missingOne } = complete;
    try {
      read(missingOne);
      return `not required: ${env}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(`hosted_runtime_configuration_missing:${env}`)) {
        return `wrong refusal for ${env}: ${message}`;
      }
    }
  }
  return null;
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

  it('tests literally exactly the names the runtime uses as literal configuration', () => {
    expect(bashArray(script, 'LITERAL_NAMES')).toEqual(HOSTED_RUNTIME_LITERAL_CONFIGURATION.map((one) => one.env));
  });

  it('never dereferences a literal, and never literal-tests a reference', () => {
    // The mirror of the label assertion above, and the same false-RED failure:
    // a literal has no entry in the secret store, so resolving one would fail a
    // correctly configured deployment. The gate hands ONLY REF_NAMES to the
    // resolver entrypoint, so a LITERAL_NAMES expansion reaching that line is
    // the regression this catches.
    const resolverCall = /npx tsx bin\/hosted-check-refs\.ts[^\n]*/.exec(script)?.[0] ?? '';
    expect(resolverCall).toContain('REF_NAMES');
    expect(resolverCall).not.toContain('LITERAL_NAMES');
    expect(resolverCall).not.toContain('OPTIONAL_LABEL_NAMES');
    // And the required set is COMPOSED from the two pinned arrays rather than
    // hand-listed a fourth time, which is what keeps the pin exhaustive.
    expect(bashArray(script, 'REQUIRED_NAMES')).toEqual(['"${LITERAL_NAMES[@]}" "${REF_NAMES[@]}"']);
  });

  it('pins both catalogues to what readHostedRuntimeConfiguration actually requires', () => {
    // A name belongs to exactly one bucket; a reference that is also a literal
    // would make the gate test the same name two incompatible ways.
    expect(new Set(REQUIRED_CATALOGUE.map((one) => one.env)).size).toBe(REQUIRED_CATALOGUE.length);
    expect(new Set(REQUIRED_CATALOGUE.map((one) => one.field)).size).toBe(REQUIRED_CATALOGUE.length);

    expect(catalogueClosureFailure(REQUIRED_CATALOGUE)).toBeNull();

    // The labels are the complement: read, but never required.
    const complete = Object.fromEntries(REQUIRED_CATALOGUE.map((one) => [one.env, `value-for-${one.env}`]));
    for (const { field, env } of HOSTED_RUNTIME_OPTIONAL_LABELS) {
      expect(readHostedRuntimeConfiguration(complete)[field]).toBeUndefined();
      expect(readHostedRuntimeConfiguration({ ...complete, [env]: `label-${env}` })[field]).toBe(`label-${env}`);
    }
    expect(bashArray(script, 'OPTIONAL_LABEL_NAMES')).toEqual(HOSTED_RUNTIME_OPTIONAL_LABELS.map((one) => one.env));
  });

  it('would catch a catalogue that drifted from the reader in any direction (controls)', () => {
    // Deliberately-wrong catalogues and a deliberately-wrong reader, kept here
    // permanently: the assertion above is a claim ABOUT a closure check, and a
    // broken closure check would pass it silently. One control per branch.

    // FALSE GREEN — a name the reader requires is missing from the catalogue,
    // so the gate would not test it at all (the WI-2141402 direction).
    expect(catalogueClosureFailure(REQUIRED_CATALOGUE.slice(1))).toMatch(/^incomplete:/);

    // FALSE RED — a catalogued name the reader does not actually require, so
    // the gate would block a correctly configured cut-over (the D-048 direction).
    expect(catalogueClosureFailure([...REQUIRED_CATALOGUE, ...HOSTED_RUNTIME_OPTIONAL_LABELS])).toMatch(
      /^not required: WORKOS_WEBHOOK_SECRET_KEY_REF$/,
    );

    // UNCATALOGUED FIELD — a new field neither catalogue names. It is invisible
    // to both branches above (nothing is missing, nothing is unrequired), which
    // is why the field-set comparison is a separate leg.
    expect(
      catalogueClosureFailure(REQUIRED_CATALOGUE, (env) => ({
        ...readHostedRuntimeConfiguration(env),
        publicOriginHost: 'derived',
      })),
    ).toMatch(/^field set:/);
  });

  it('reads the arrays it is pinning (fixture control)', () => {
    // Calibration: a broken reader would make every assertion above vacuous.
    for (const name of ['LITERAL_NAMES', 'REF_NAMES', 'OPTIONAL_LABEL_NAMES', 'REQUIRED_NAMES']) {
      expect(bashArray(script, name).length).toBeGreaterThan(0);
    }
    expect(() => bashArray(script, 'NAME_THAT_IS_NOT_IN_THE_SCRIPT')).toThrow(/bash array not found/);
  });
});
