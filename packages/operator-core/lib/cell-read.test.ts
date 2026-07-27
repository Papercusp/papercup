/**
 * P-004 / D-058 — reading a cell's VALUE.
 *
 * The centre of gravity of this suite is the THREE-WAY distinction between `value`,
 * `unknown` and `absent`, and specifically the case D-058 found: a reader who passes
 * `canReadCell` but is refused by the resolver tool's own role gate. That case must
 * render as an ENUMERATED unknown — never as `absent` (a lie: the reader is entitled
 * to know the cell exists) and never as a throw (P-026 (f): an enrichment must not be
 * able to fail the operation it decorates).
 *
 * The `absent` tests matter for a different reason: `absent` is load-bearing as a
 * NON-oracle. If an out-of-audience read were distinguishable from an unregistered
 * one, a stranger could enumerate the narrow cells by probing — which is the exact
 * hazard D-042 closes.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchReadOnlyTool = vi.fn();

vi.mock('./events/await/predicate-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events/await/predicate-watch')>();
  return {
    ...actual,
    // Only the DISPATCH is faked — `valueAtPath` and the error classification are the
    // real ones, so a change to either fails here rather than passing on a fixture.
    dispatchReadOnlyTool: (...args: unknown[]) => dispatchReadOnlyTool(...args),
  };
});

import { readCell, unknownForDispatchError } from './cell-read';
import { ReadOnlyDispatchError } from './events/await/predicate-watch';
import { registerCell, __resetCellRegistryForTests, type CellSpec } from './cell-registry';

const ENV = { workspaceId: 'default', harnessSlug: 'papercusp', role: 'su' };
const READER = { ownerId: 'su-me', roles: ['su'], harnessSlug: 'papercusp', workItems: ['WI-1'] };

/** A registrable spec. Every axis is satisfied so the registry never refuses for a
 *  reason unrelated to what a given test is about. */
function spec(over: Partial<CellSpec> = {}): CellSpec {
  return {
    cell: 'test.cell',
    owner: 'test',
    headline: 'positions.deployed',
    falsifier: {
      field: 'serving.startedSinceCodeChange',
      measurement: 'process start time vs code mtime',
      kills: '"deployed ✓" read as "the running process executes my code"',
    },
    nullable: false,
    callerRelativity: { kind: 'global' },
    provenance: { obtainedBy: 'git rev-list', liveExercised: true, evidence: 'run live 2026-07-27' },
    resolver: 'git-pipeline-position.ts',
    visibility: { kind: 'workspace' },
    federation: { kind: 'local' },
    changeSignal: { kind: 'poll', tool: 'dev:pipeline_position', path: 'positions.deployed' },
    shape: '{ positions, serving }',
    ...over,
  };
}

beforeEach(() => {
  __resetCellRegistryForTests();
  dispatchReadOnlyTool.mockReset();
});

describe('readCell — the happy path', () => {
  it('dispatches the changeSignal tool and projects its declared path', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: true }, serving: {} });

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('value');
    if (r.status === 'value') {
      expect(r.value).toBe(true);
      expect(r.headline).toBe('positions.deployed');
      expect(r.resolver).toBe('git-pipeline-position.ts');
    }
    expect(dispatchReadOnlyTool).toHaveBeenCalledWith('dev:pipeline_position', {}, expect.objectContaining({ role: 'su' }));
  });

  it('a null AT the path is a VALUE, not an unknown — a nullable cell must be able to answer "null"', async () => {
    // P-016's goal cell is nullable:true, and "this agent has no goal" is a real
    // answer. If null collapsed to unknown, "no goal" would be indistinguishable from
    // "could not measure the goal" — opposite caller responses.
    registerCell(spec({ nullable: true, unknownHoist: 'goalUnknown' }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: null } });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('value');
    if (r.status === 'value') expect(r.value).toBeNull();
  });
});

describe('readCell — absent is a NON-oracle (P-019 / D-042)', () => {
  it('an UNREGISTERED cell is absent', async () => {
    expect((await readCell('nope.missing', READER, ENV)).status).toBe('absent');
  });

  it('a cell the reader is OUT OF AUDIENCE for is absent — byte-identical to unregistered', async () => {
    registerCell(spec({ cell: 'narrow.cell', visibility: { kind: 'owner', ref: 'su-someone-else' } }));

    const outOfAudience = await readCell('narrow.cell', READER, ENV);
    const unregistered = await readCell('nope.missing', READER, ENV);

    // Same SHAPE, not merely the same status — a caller must not be able to tell the
    // two apart by any field, or the refusal becomes a probe oracle.
    expect(outOfAudience).toEqual({ status: 'absent', cell: 'narrow.cell' });
    expect(Object.keys(outOfAudience).sort()).toEqual(Object.keys(unregistered).sort());
  });

  it('never dispatches for a cell the reader may not see', async () => {
    registerCell(spec({ cell: 'narrow.cell', visibility: { kind: 'role', ref: 'architect' } }));
    await readCell('narrow.cell', READER, ENV);
    // Gate 1 must short-circuit BEFORE gate 2: dispatching first would leak the cell's
    // existence through timing and through the tool_invocations audit row.
    expect(dispatchReadOnlyTool).not.toHaveBeenCalled();
  });
});

describe('readCell — ⚠ the TWO-GATE disagreement (D-058), the case this module exists for', () => {
  it('spec readable + resolver ROLE-REFUSED renders as an enumerated unknown, NOT absent', async () => {
    registerCell(spec()); // workspace-visible: gate 1 passes for everyone
    dispatchReadOnlyTool.mockRejectedValue(
      new ReadOnlyDispatchError('role_not_allowed', 'role_not_allowed: role "su" may not call this tool'),
    );

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      // `not-measured`, whose documented lever is "ask for it, not retry the same
      // call" — obtain the role. `resolver-failed` would send the caller to retry.
      expect(r.unknown.code).toBe('not-measured');
      expect(r.unknown.detail).toContain('role_not_allowed');
    }
  });

  it('EVERY access-family dispatcher code maps to not-measured, and everything else to resolver-failed', async () => {
    for (const code of [
      'role_not_allowed',
      'missing_role',
      'missing_capability',
      'capability_denied',
      'authorization_denied',
      'unauthorized',
      'ungated',
    ]) {
      expect(unknownForDispatchError(new ReadOnlyDispatchError(code, `${code}: x`)).code, code).toBe('not-measured');
    }
    for (const code of ['timeout', 'handler_error', 'harness_required', 'invalid_input', 'dispatch_failed']) {
      expect(unknownForDispatchError(new ReadOnlyDispatchError(code, `${code}: x`)).code, code).toBe('resolver-failed');
    }
  });

  it('a REGISTRATION defect (resolver not read-only) is resolver-failed and says it is not transient', async () => {
    // P-003 gap, D-058: validateCellSpec does not check changeSignal.tool's effect, so
    // this surfaces here at read time. The detail must not invite a pointless retry.
    registerCell(spec());
    dispatchReadOnlyTool.mockRejectedValue(
      new ReadOnlyDispatchError('not_read_only', 'tool "x:write" is not read-only (effect=write)'),
    );

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('resolver-failed');
      expect(r.unknown.detail).toContain('REGISTRATION defect');
    }
  });
});

describe('readCell — TOTALITY (P-026 rule f: an enrichment may never fail its caller)', () => {
  it('a NON-dispatcher throw still returns an unknown rather than propagating', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockRejectedValue(new TypeError('something unrelated exploded'));

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('resolver-failed');
      expect(r.unknown.detail).toContain('something unrelated exploded');
    }
  });

  it('a thrown non-Error does not break the classification', async () => {
    registerCell(spec());
    dispatchReadOnlyTool.mockRejectedValue('a bare string');
    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
  });
});

describe('readCell — axis 3 caller-relativity and the `as` subject', () => {
  it('a PARAMETER-relative cell with no subject is insufficient-data, and names the param', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'ownerId' } }));

    const r = await readCell('test.cell', READER, ENV);

    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('insufficient-data');
      expect(r.unknown.detail).toContain('ownerId');
    }
    expect(dispatchReadOnlyTool).not.toHaveBeenCalled();
  });

  it('a PARAMETER-relative cell passes the subject under the DECLARED param name', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'ownerId' } }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: 'x' } });

    await readCell('test.cell', READER, ENV, 'su-peer');

    expect(dispatchReadOnlyTool).toHaveBeenCalledWith(
      'dev:pipeline_position',
      { ownerId: 'su-peer' },
      expect.anything(),
    );
  });

  it('a blank subject counts as MISSING, not as a legitimate empty value', async () => {
    registerCell(spec({ callerRelativity: { kind: 'parameter', param: 'ownerId' } }));
    const r = await readCell('test.cell', READER, ENV, '   ');
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') expect(r.unknown.code).toBe('insufficient-data');
  });

  it('an AMBIENT cell IGNORES a supplied subject rather than injecting it', async () => {
    // Injecting it would silently convert an ambient cell into a parameter one and let
    // a caller redirect a read that is defined to be about ITSELF.
    registerCell(spec({ callerRelativity: { kind: 'ambient', source: 'caller identity' } }));
    dispatchReadOnlyTool.mockResolvedValue({ positions: { deployed: 1 } });

    await readCell('test.cell', READER, ENV, 'su-someone-else');

    expect(dispatchReadOnlyTool).toHaveBeenCalledWith('dev:pipeline_position', {}, expect.anything());
  });

  it('the subject NEVER widens the audience check — it is not an identity override', async () => {
    registerCell(
      spec({
        cell: 'narrow.cell',
        visibility: { kind: 'owner', ref: 'su-peer' },
        callerRelativity: { kind: 'parameter', param: 'ownerId' },
      }),
    );
    // Naming the owner the cell belongs to must NOT grant access to it.
    const r = await readCell('narrow.cell', READER, ENV, 'su-peer');
    expect(r.status).toBe('absent');
    expect(dispatchReadOnlyTool).not.toHaveBeenCalled();
  });
});

describe('readCell — an event-signalled cell has nothing to poll', () => {
  it('is not-measured and points at state:subscribe, rather than pretending to be absent', async () => {
    registerCell(spec({ changeSignal: { kind: 'event', key: 'deploy:landed' } }));

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('not-measured');
      expect(r.unknown.detail).toContain('state:subscribe');
    }
    expect(dispatchReadOnlyTool).not.toHaveBeenCalled();
  });
});

describe('readCell — path drift', () => {
  it('resolver answered but the declared path is absent ⇒ insufficient-data, not resolver-failed', async () => {
    // The resolver WORKED. Calling this `resolver-failed` would send a caller to retry
    // a call that will keep succeeding and keep not containing the path.
    registerCell(spec());
    dispatchReadOnlyTool.mockResolvedValue({ somethingElse: true });

    const r = await readCell('test.cell', READER, ENV);
    expect(r.status).toBe('unknown');
    if (r.status === 'unknown') {
      expect(r.unknown.code).toBe('insufficient-data');
      expect(r.unknown.detail).toContain('positions.deployed');
    }
  });
});
