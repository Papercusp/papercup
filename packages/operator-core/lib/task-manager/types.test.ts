import { describe, it, expect } from 'vitest';
import {
  TASK_STATES,
  TERMINAL_TASK_STATES,
  isTerminalState,
  isLiveOwnedState,
  newTaskId,
  isValidTaskId,
  serviceUnitForTask,
  scopeUnitForTask,
  taskIdFromScopeUnit,
  sliceForClass,
  isOwnedCgroupPath,
  TASK_ROOT_SLICE,
  sliceCgroupPath,
  scopeCgroupRelPath,
  deriveUserManagerRoot,
} from './types';

describe('task id + scope unit naming', () => {
  it('mints ids that are legal systemd unit-name components', () => {
    for (let i = 0; i < 200; i++) {
      const id = newTaskId();
      expect(isValidTaskId(id)).toBe(true);
      // A systemd unit name may not contain '/', whitespace or '@' in our usage.
      expect(id).toMatch(/^[0-9a-z]+$/);
    }
  });

  it('mints ids that sort by mint time', () => {
    const early = newTaskId(1_700_000_000_000);
    const late = newTaskId(1_800_000_000_000);
    expect(early < late).toBe(true);
  });

  it('round-trips taskId -> scope unit -> taskId exactly', () => {
    for (let i = 0; i < 200; i++) {
      const id = newTaskId();
      expect(taskIdFromScopeUnit(scopeUnitForTask(id))).toBe(id);
    }
  });

  it('round-trips taskId -> service unit -> taskId exactly', () => {
    for (let i = 0; i < 200; i++) {
      const id = newTaskId();
      expect(taskIdFromScopeUnit(serviceUnitForTask(id))).toBe(id);
    }
  });

  it('refuses an id that would produce an illegal unit name', () => {
    expect(() => scopeUnitForTask('has/slash')).toThrow(/invalid taskId/);
    expect(() => scopeUnitForTask('UPPER')).toThrow(/invalid taskId/);
    expect(() => scopeUnitForTask('')).toThrow(/invalid taskId/);
    expect(() => scopeUnitForTask('ab')).toThrow(/invalid taskId/); // too short
  });

  it('returns null for scopes that are not ours — the ours-vs-theirs test', () => {
    // This is the reconciler's only discriminator between "a scope we launched"
    // and "some other transient scope on this user manager". A false positive
    // here would make us claim (and potentially kill) a stranger's process.
    expect(taskIdFromScopeUnit('session-42.scope')).toBeNull();
    expect(taskIdFromScopeUnit('run-u1234.service')).toBeNull();
    expect(taskIdFromScopeUnit('pc-abc123.service')).toBe('abc123');
    expect(taskIdFromScopeUnit('xpc-abc123.scope')).toBeNull(); // prefix must be at the start
    expect(taskIdFromScopeUnit('pc-.scope')).toBeNull(); // empty id
    expect(taskIdFromScopeUnit('pc-ABC123.scope')).toBeNull(); // not a mintable id
  });

  it('tolerates surrounding whitespace from a systemctl listing', () => {
    const unit = scopeUnitForTask('abc123');
    expect(taskIdFromScopeUnit(`  ${unit}\n`)).toBe('abc123');
  });

  it('carries a human LABEL alongside the id, and still round-trips', () => {
    // `systemctl --user list-units | grep <something>` is how people have always
    // found a running fleet member. Enrolling a seam must not take that away —
    // the id is only meaningful to the reconciler, the label is for humans.
    const unit = scopeUnitForTask('abc123', 'bug-drain-member-3');
    expect(unit).toBe('pc-abc123--bug-drain-member-3.scope');
    expect(taskIdFromScopeUnit(unit)).toBe('abc123');
  });

  it('carries a human LABEL on a service unit and still round-trips', () => {
    const unit = serviceUnitForTask('abc123', 'bug-drain-member-3');
    expect(unit).toBe('pc-abc123--bug-drain-member-3.service');
    expect(taskIdFromScopeUnit(unit)).toBe('abc123');
  });

  it('sanitizes and bounds a hostile label without corrupting the id', () => {
    const unit = scopeUnitForTask('abc123', 'You are a member of the /bug drain/ fleet!!'.repeat(6));
    expect(taskIdFromScopeUnit(unit)).toBe('abc123');
    expect(unit).toMatch(/^pc-abc123--[A-Za-z0-9._-]+\.scope$/);
    expect(unit.length).toBeLessThan(90);
  });

  it('omits the separator entirely when the label sanitizes to nothing', () => {
    expect(scopeUnitForTask('abc123', '///')).toBe('pc-abc123.scope');
  });

  it('still rejects a labelled scope whose ID half is not ours', () => {
    expect(taskIdFromScopeUnit('pc-BAD--label.scope')).toBeNull();
    expect(taskIdFromScopeUnit('pc---label.scope')).toBeNull();
  });
});

describe('slice naming', () => {
  it('maps a class to a slice under the papercusp root', () => {
    expect(sliceForClass('bash-job')).toBe('papercusp-bash-job.slice');
    expect(sliceForClass('sidecar')).toBe('papercusp-sidecar.slice');
  });

  it('sanitizes anything that is not a legal slice token', () => {
    expect(sliceForClass('Test Run/2')).toBe('papercusp-test-run-2.slice');
    expect(sliceForClass('--weird--')).toBe('papercusp-weird.slice');
  });

  it('falls back to the root slice rather than emitting a nameless one', () => {
    expect(sliceForClass('///')).toBe(TASK_ROOT_SLICE);
    expect(sliceForClass('')).toBe(TASK_ROOT_SLICE);
  });
});

describe('scope cgroup path (WI-37509)', () => {
  const MGR = '/user.slice/user-1000.slice/user@1000.service';

  it('expands a slice NAME into the nested directories systemd actually creates', () => {
    // `-` is a hierarchy separator to systemd, so this is three directories, not one.
    expect(sliceCgroupPath('papercusp-agent-session.slice')).toBe(
      'papercusp.slice/papercusp-agent.slice/papercusp-agent-session.slice',
    );
    expect(sliceCgroupPath('papercusp-sidecar.slice')).toBe('papercusp.slice/papercusp-sidecar.slice');
    expect(sliceCgroupPath(TASK_ROOT_SLICE)).toBe('papercusp.slice');
  });

  it('derives the path a confined task will occupy, matching the live tree', () => {
    // Verified byte-for-byte against a real survivor on this box, 2026-08-09.
    expect(scopeCgroupRelPath(MGR, 'sidecar', 'pc-0msldixpfupa5t8454l.scope')).toBe(
      `${MGR}/papercusp.slice/papercusp-sidecar.slice/pc-0msldixpfupa5t8454l.scope`,
    );
    expect(scopeCgroupRelPath(MGR, 'agent-session', 'pc-abc.scope')).toBe(
      `${MGR}/papercusp.slice/papercusp-agent.slice/papercusp-agent-session.slice/pc-abc.scope`,
    );
  });

  it('stays absolute when there is no user manager (a container / system slice)', () => {
    expect(scopeCgroupRelPath(null, 'sidecar', 'pc-abc.scope')).toBe(
      '/papercusp.slice/papercusp-sidecar.slice/pc-abc.scope',
    );
  });

  it('round-trips with the manager root derived from a real operator cgroup path', () => {
    const root = deriveUserManagerRoot(`${MGR}/papercup-dev-api.service`);
    expect(root).toBe(MGR);
    // Note the INTERMEDIATE `papercusp-bash.slice`: a two-token class expands to two
    // levels. Verified against the live tree 2026-08-09, which holds exactly
    // `papercusp-bash.slice/papercusp-bash-job.slice/pc-0mslx760o13menyxs2f.scope`.
    expect(scopeCgroupRelPath(root, 'bash-job', 'pc-xyz.scope')).toBe(
      `${MGR}/papercusp.slice/papercusp-bash.slice/papercusp-bash-job.slice/pc-xyz.scope`,
    );
  });
});

describe('cgroup ownership', () => {
  it('recognises our slice anywhere in the path', () => {
    expect(
      isOwnedCgroupPath(
        '/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-bash-job.slice/pc-abc123.scope',
      ),
    ).toBe(true);
  });

  it('does not claim an unrelated user scope', () => {
    expect(isOwnedCgroupPath('/user.slice/user-1000.slice/session-3.scope')).toBe(false);
    expect(isOwnedCgroupPath('/system.slice/sshd.service')).toBe(false);
  });
});

describe('state algebra', () => {
  it('keeps the state list and the terminal subset consistent', () => {
    for (const s of TERMINAL_TASK_STATES) expect(TASK_STATES).toContain(s);
  });

  it('treats a strand as terminal but distinct from a clean exit', () => {
    expect(isTerminalState('stranded')).toBe(true);
    expect(isTerminalState('exited')).toBe(true);
    // The distinction matters: a strand means we never saw an exit code, so it
    // must never be reported as a clean completion.
    expect(TERMINAL_TASK_STATES).toContain('stranded');
  });

  it('does not treat residue classifications as live-owned', () => {
    // We must never signal an `unaccounted` or `foreign` row as if we owned it.
    expect(isLiveOwnedState('unaccounted')).toBe(false);
    expect(isLiveOwnedState('foreign')).toBe(false);
    expect(isLiveOwnedState('running')).toBe(true);
    expect(isLiveOwnedState('pending')).toBe(true);
  });
});
