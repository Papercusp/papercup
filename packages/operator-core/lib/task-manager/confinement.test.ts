/**
 * confinement.test.ts — P-023 / WI-2141828 / D-111.
 *
 * The load-bearing tests reject the stored cgroup_path AND class-based guesses. Historical
 * agent-session rows hold the SPAWNER's cgroup in that column (the pre-EI-9748
 * `papercup-dev-api.service` value), and D-111 binds this read surface never to present
 * one as current truth. A resolver that simply echoed the column would pass every other
 * assertion in this file, so that test is what separates a fix from a rename.
 *
 * No module mocking: a fake CgroupFs and same-request scan paths exercise the real resolver.
 */
import { describe, expect, it } from 'vitest';

import type { CgroupFs } from './cgroup-read';
import { observedTaskScopePaths, resolveTaskConfinement } from './confinement';

const USER_MANAGER = '/user.slice/user-1000.slice/user@1000.service';
/** Where the operator itself lives — and the exact wrong value the ledger recorded. */
const OPERATOR_CGROUP = `${USER_MANAGER}/papercup-dev-api.service`;

/** A fake /proc for the CURRENT process, which is how the resolver finds the user-manager root. */
function fsWithOwnCgroup(path: string): CgroupFs {
  return {
    readFile: (p: string) => (p === `/proc/${process.pid}/cgroup` ? `0::${path}\n` : null),
    readDir: () => [],
    isDir: () => false,
  };
}

const operatorFs = fsWithOwnCgroup(OPERATOR_CGROUP);

const AGENT_SESSION_SCOPE = `${USER_MANAGER}/papercusp.slice/papercusp-agent.slice/papercusp-agent-session.slice/pc-abc1234.scope`;
const agentObservations = observedTaskScopePaths([AGENT_SESSION_SCOPE]);

describe('resolveTaskConfinement', () => {
  it('ignores the stored spawner cgroup and uses the current exact scope observation (D-111)', () => {
    // Exactly the shape of a historical row: confined, a good scope_unit, and a
    // cgroup_path naming the operator because the /proc read caught the spawner.
    const c = resolveTaskConfinement(
      {
        taskId: 'abc1234',
        confined: true,
        scopeUnit: 'pc-abc1234.scope',
        class: 'agent-session',
        cgroupPath: OPERATOR_CGROUP,
      },
      operatorFs,
      agentObservations,
    );

    expect(c.source).toBe('observed-at-reconcile');
    expect(c.cgroupPath).toBe(AGENT_SESSION_SCOPE);
    // The point of the whole item: the wrong stored value must not survive the read.
    expect(c.cgroupPath).not.toBe(OPERATOR_CGROUP);
  });

  it('answers "an operator restart does not kill this agent" for a post-EI-9748 session', () => {
    const c = resolveTaskConfinement(
      { taskId: 'abc1234', confined: true, scopeUnit: 'pc-abc1234.scope', class: 'agent-session', cgroupPath: OPERATOR_CGROUP },
      operatorFs,
      agentObservations,
    );
    expect(c).toMatchObject({ confined: true, insideOperatorCgroup: false });
  });

  // Positive control for the assertion above: without it, an `insideOperatorCgroup` that
  // was hardcoded `false` — or a containment test that never matches anything — would look
  // exactly like a correct answer.
  it('reports insideOperatorCgroup TRUE when the operator really does contain the scope', () => {
    const nested = fsWithOwnCgroup(`${USER_MANAGER}/papercusp.slice`);
    const c = resolveTaskConfinement(
      { taskId: 'abc1234', confined: true, scopeUnit: 'pc-abc1234.scope', class: 'agent-session' },
      nested,
      agentObservations,
    );
    expect(c).toMatchObject({ confined: true, insideOperatorCgroup: true });
  });

  it('uses the reconcile-observed path for an exact unaccounted task scope', () => {
    const scopeUnit = 'pc-abc123.scope';
    const observedPath = `${USER_MANAGER}/papercusp.slice/papercusp-sidecar.slice/${scopeUnit}`;
    const c = resolveTaskConfinement(
      {
        taskId: 'abc123',
        state: 'unaccounted',
        confined: false,
        scopeUnit,
        class: 'other',
        cgroupPath: observedPath,
      },
      operatorFs,
      observedTaskScopePaths([observedPath]),
    );

    expect(c).toEqual({
      confined: true,
      cgroupPath: observedPath,
      scopeUnit,
      source: 'observed-at-reconcile',
      insideOperatorCgroup: false,
    });
  });

  it('does not infer a task scope when the unit ID differs from the residue ID', () => {
    const scopeUnit = 'pc-other123.scope';
    const c = resolveTaskConfinement(
      {
        taskId: 'abc123',
        state: 'unaccounted',
        confined: false,
        scopeUnit,
        class: 'other',
        cgroupPath: `${USER_MANAGER}/papercusp.slice/papercusp-sidecar.slice/${scopeUnit}`,
      },
      operatorFs,
    );

    expect(c).toMatchObject({ confined: false, scopeUnit: null, source: 'recorded-at-spawn' });
  });

  it.each(['papercusp.slice', 'papercusp.slice/papercusp-deploy.slice', 'papercusp.slice/legacy.slice'])(
    'uses the actual %s slice for a deploy unit instead of its class default', (slice) => {
      const scopeUnit = 'pc-release123.service';
      const actualPath = `${USER_MANAGER}/${slice}/${scopeUnit}`;
      const c = resolveTaskConfinement(
        { taskId: 'release123', confined: true, scopeUnit, class: 'deploy', cgroupPath: OPERATOR_CGROUP },
        operatorFs,
        observedTaskScopePaths([`${actualPath}/worker`]),
      );
      expect(c).toMatchObject({ cgroupPath: actualPath, source: 'observed-at-reconcile', insideOperatorCgroup: false });
    },
  );

  it('does not turn a class prediction or stored path into a current observation', () => {
    const c = resolveTaskConfinement(
      { taskId: 'abc1234', confined: true, scopeUnit: 'pc-abc1234.scope', class: 'agent-session', cgroupPath: AGENT_SESSION_SCOPE },
      operatorFs,
    );
    expect(c).toMatchObject({ confined: true, cgroupPath: null, scopeUnit: 'pc-abc1234.scope', source: 'not-derivable' });
    expect(c).not.toHaveProperty('insideOperatorCgroup');
    expect(c).toHaveProperty('reason', expect.stringContaining('live:true'));
  });

  it('rejects a current scope observation belonging to a different task', () => {
    const c = resolveTaskConfinement(
      { taskId: 'other', confined: true, scopeUnit: 'pc-abc1234.scope', class: 'agent-session' },
      operatorFs,
      agentObservations,
    );
    expect(c.cgroupPath).toBeNull();
    expect(c).not.toHaveProperty('insideOperatorCgroup');
  });

  it('does not retain an observation across requests or trust an old residue path', () => {
    const row = { taskId: 'abc1234', state: 'unaccounted' as const, confined: true, scopeUnit: 'pc-abc1234.scope', class: 'other', cgroupPath: AGENT_SESSION_SCOPE };
    expect(resolveTaskConfinement(row, operatorFs, agentObservations).cgroupPath).toBe(AGENT_SESSION_SCOPE);
    expect(resolveTaskConfinement(row, operatorFs).cgroupPath).toBeNull();
  });

  it('reports a confined task with no scope unit as UNKNOWN, never as unconfined', () => {
    const c = resolveTaskConfinement({ confined: true, scopeUnit: null, class: 'agent-session' }, operatorFs);

    expect(c.source).toBe('not-derivable');
    expect(c.cgroupPath).toBeNull();
    // The silent-wrong-answer this branch exists to prevent: a null path read as "nothing
    // confines it". `confined` must stay true so the caller cannot reach that reading.
    expect(c.confined).toBe(true);
  });

  it('keeps the spawn-time /proc read for an unconfined task, where it is correct', () => {
    const c = resolveTaskConfinement(
      {
        confined: false,
        class: 'bash-job',
        cgroupPath: OPERATOR_CGROUP,
        unconfinedReason: 'scope support unavailable',
      },
      operatorFs,
    );

    expect(c).toMatchObject({
      confined: false,
      source: 'recorded-at-spawn',
      cgroupPath: OPERATOR_CGROUP,
      reason: 'scope support unavailable',
    });
  });

  it('compares cgroup containment segment-wise, so a shared name prefix is not containment', () => {
    // `papercusp-agent.slice` is a string prefix of `papercusp-agent-session.slice`. A
    // startsWith() test without the separator would call this contained and report that an
    // operator restart kills the agent — the exact wrong answer, restored by a typo.
    const siblingFs = fsWithOwnCgroup(`${USER_MANAGER}/papercusp.slice/papercusp-agent.slice/papercusp-agent`);
    const c = resolveTaskConfinement(
      { taskId: 'abc1234', confined: true, scopeUnit: 'pc-abc1234.scope', class: 'agent-session' },
      siblingFs,
      agentObservations,
    );
    expect(c).toMatchObject({ insideOperatorCgroup: false });
  });

  it('leaves containment unknown when the operator cgroup read is unavailable', () => {
    const unreadable: CgroupFs = { readFile: () => null, readDir: () => [], isDir: () => false };
    const c = resolveTaskConfinement(
      { taskId: 'abc1234', confined: true, scopeUnit: 'pc-abc1234.scope', class: 'agent-session' }, unreadable, agentObservations,
    );
    expect(c.cgroupPath).toBe(AGENT_SESSION_SCOPE);
    expect(c).not.toHaveProperty('insideOperatorCgroup');
  });
});

describe('observedTaskScopePaths', () => {
  it.each([199, 200, 201, 1000])('finds the decisive path after %i unrelated observations', (count) => {
    const paths = Array.from({ length: count }, (_, i) => `${USER_MANAGER}/papercusp.slice/pc-task${i}.scope`);
    for (const scan of [[...paths, AGENT_SESSION_SCOPE], [AGENT_SESSION_SCOPE, ...paths]]) {
      expect(observedTaskScopePaths(scan).get('pc-abc1234.scope')).toBe(AGENT_SESSION_SCOPE);
    }
  });

  it('rejects conflicting roots in every scan order, including later corroboration', () => {
    const other = `${USER_MANAGER}/papercusp.slice/pc-abc1234.scope`;
    for (const paths of [[AGENT_SESSION_SCOPE, other, AGENT_SESSION_SCOPE], [other, AGENT_SESSION_SCOPE, other]]) {
      const observed = observedTaskScopePaths(paths);
      expect(observed.get('pc-abc1234.scope')).toBeNull();
      expect(resolveTaskConfinement(
        { taskId: 'abc1234', confined: true, scopeUnit: 'pc-abc1234.scope', class: 'agent-session' }, operatorFs, observed,
      ).cgroupPath).toBeNull();
    }
  });

  it('rejects paths outside the owned slice and noncanonical paths', () => {
    const invalid = [OPERATOR_CGROUP, AGENT_SESSION_SCOPE.slice(1), `${AGENT_SESSION_SCOPE}/..`, `${AGENT_SESSION_SCOPE}//worker`];
    expect(observedTaskScopePaths(invalid).size).toBe(0);
  });
});
