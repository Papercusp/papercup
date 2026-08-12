/**
 * `readNamespaceRefForDevices` — the batched namespaced-ref read.
 *
 * The property under test is a COST property, and it is the entire reason the
 * function exists (EI-18808838427010743): reading ONE ref for N devices must cost
 * a CONSTANT number of `git` invocations, not N. The serial shape it replaced —
 * `for (const dev of devices) await readNamespaceRef(...)` — cost one spawn per
 * device, and a spawn charges fork()'s page-table copy (~40ms per GB of the
 * PARENT's RSS) as synchronous time on the calling thread. On a large-RSS host
 * that is ~165ms of dead event loop each, for a command git finishes in ~4ms.
 *
 * So the invocation-COUNT assertions below are not stylistic. They are the
 * regression guard, and they are self-falsifying: reintroducing a per-device loop
 * makes `calls` length N instead of 1, which is exactly the bug. A correctness-only
 * test (right shas, right devices) would pass just as happily against the slow
 * shape, which is how this regressed in the first place.
 */
import { describe, it, expect } from 'vitest';
import {
  readNamespaceRefForDevices,
  namespaceRefPath,
  type RunGit,
} from './storage';

const WORK_REF = 'refs/heads/work';
const OTHER_REF = 'refs/heads/other';

/** A valid raw-32 Ed25519 pubkey in base64 — deviceNamespaceKey rejects any other length. */
const dev = (seed: number): string => Buffer.alloc(32, seed).toString('base64');

/** A distinct, well-formed 40-hex sha per seed. */
const sha = (n: number): string => n.toString(16).padStart(40, '0');

/** A fake `git` serving a fixed ref table that RECORDS every invocation. */
function fakeGit(refTable: Record<string, string>, code = 0): {
  run: RunGit;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: RunGit = async (args: string[]) => {
    calls.push(args);
    if (code !== 0) return { code, stdout: '', stderr: 'fatal: not a git repository' };
    const stdout = `${Object.entries(refTable)
      .map(([full, s]) => `${s} ${full}`)
      .join('\n')}\n`;
    return { code: 0, stdout, stderr: '' };
  };
  return { run, calls };
}

/** Table mapping each device's WORK_REF to a distinct sha. */
function workRefTable(devices: string[]): Record<string, string> {
  const t: Record<string, string> = {};
  devices.forEach((d, i) => {
    t[namespaceRefPath(d, WORK_REF)] = sha(i + 1);
  });
  return t;
}

describe('readNamespaceRefForDevices — constant git-invocation cost', () => {
  it('reads one ref for MANY devices in exactly ONE git invocation', async () => {
    const devices = [dev(1), dev(2), dev(3), dev(4), dev(5), dev(6), dev(7), dev(8)];
    const { run, calls } = fakeGit(workRefTable(devices));

    const got = await readNamespaceRefForDevices('/repo', devices, WORK_REF, run);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      'refs/namespaces/',
    ]);
    expect(got.size).toBe(8);
    expect(got.get(devices[0])).toBe(sha(1));
    expect(got.get(devices[7])).toBe(sha(8));
  });

  it('stays at ONE invocation when the device count grows 10x (the anti-regression guard)', async () => {
    const few = [dev(1), dev(2), dev(3)];
    const many = Array.from({ length: 30 }, (_, i) => dev(i + 1));

    const a = fakeGit(workRefTable(few));
    await readNamespaceRefForDevices('/repo', few, WORK_REF, a.run);

    const b = fakeGit(workRefTable(many));
    const got = await readNamespaceRefForDevices('/repo', many, WORK_REF, b.run);

    // Constant, NOT proportional: a per-device loop would give 3 and 30 here.
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
    expect(got.size).toBe(30);
  });

  it('spawns NOTHING at all for an empty device list', async () => {
    const { run, calls } = fakeGit({});
    const got = await readNamespaceRefForDevices('/repo', [], WORK_REF, run);
    expect(calls).toHaveLength(0);
    expect(got.size).toBe(0);
  });
});

describe('readNamespaceRefForDevices — selection semantics', () => {
  it('omits devices that do not have the ref, rather than mapping them to null', async () => {
    const present = dev(1);
    const absent = dev(2);
    const { run } = fakeGit({ [namespaceRefPath(present, WORK_REF)]: sha(1) });

    const got = await readNamespaceRefForDevices('/repo', [present, absent], WORK_REF, run);

    expect(got.get(present)).toBe(sha(1));
    expect(got.has(absent)).toBe(false);
    expect(got.size).toBe(1);
  });

  it('ignores a DIFFERENT ref of a requested device, and the requested ref of an UNREQUESTED device', async () => {
    const asked = dev(1);
    const notAsked = dev(9);
    const { run } = fakeGit({
      // right device, wrong ref
      [namespaceRefPath(asked, OTHER_REF)]: sha(11),
      // right ref, device we never asked about
      [namespaceRefPath(notAsked, WORK_REF)]: sha(12),
      // the one true match
      [namespaceRefPath(asked, WORK_REF)]: sha(1),
    });

    const got = await readNamespaceRefForDevices('/repo', [asked], WORK_REF, run);

    expect(got.size).toBe(1);
    expect(got.get(asked)).toBe(sha(1));
    // A prefix/substring match instead of an exact full-refname compare would
    // have leaked one of the two decoys above into the result.
    expect([...got.values()]).not.toContain(sha(11));
    expect([...got.values()]).not.toContain(sha(12));
  });

  it('keys the result by the device pubkey AS PASSED IN, so callers need no hex conversion', async () => {
    const d = dev(3);
    const { run } = fakeGit({ [namespaceRefPath(d, WORK_REF)]: sha(3) });
    const got = await readNamespaceRefForDevices('/repo', [d], WORK_REF, run);
    expect(got.get(d)).toBe(sha(3));
  });

  it('returns an empty map (never throws) when git exits non-zero', async () => {
    const d = dev(1);
    const { run, calls } = fakeGit({}, 128);
    const got = await readNamespaceRefForDevices('/repo', [d], WORK_REF, run);
    expect(got.size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('tolerates blank and malformed lines in for-each-ref output', async () => {
    const d = dev(1);
    const calls: string[][] = [];
    const run: RunGit = async (args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        // a blank line, a line with no space separator, then the real entry
        stdout: `\nmalformed-no-space\n${sha(1)} ${namespaceRefPath(d, WORK_REF)}\n\n`,
        stderr: '',
      };
    };
    const got = await readNamespaceRefForDevices('/repo', [d], WORK_REF, run);
    expect(got.get(d)).toBe(sha(1));
    expect(got.size).toBe(1);
  });
});
