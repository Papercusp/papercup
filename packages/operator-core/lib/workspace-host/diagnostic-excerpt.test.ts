/**
 * Regression cover for the excerpt rule that decides WHICH part of an expensive failure's output
 * survives into a release-gate issue.
 *
 * The bug this file exists to prevent is subtle and has now recurred three times in three
 * different shapes (see the module docblock): each fix moved the excerpt window to where the
 * PREVIOUS failure's cause happened to sit, and the next failure put its cause somewhere else.
 * So these tests assert the property — "the earliest failure signal survives" — rather than any
 * particular window, and every positive assertion is paired with a control showing the assertion
 * could actually fail.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DIAGNOSTIC_HEAD_FRACTION,
  excerptDiagnostic,
  spillDiagnostic,
} from './diagnostic-excerpt.js';

/**
 * Shaped like the real r18 packer failure: boilerplate at BOTH ends, cause in the middle.
 *
 * Packer frames every build with instance-creation chatter up front and teardown chatter at the
 * end, so head+tail weighting keeps two stretches of pure noise and elides the provisioner output
 * between them.
 */
function packerFailureOutput(filler: number): string {
  return [
    '1787983233,,ui,say,==> workspace_host: Checking image does not exist...',
    '1787983236,,ui,say,==> workspace_host: no persistent disk to create',
    ...Array.from(
      { length: filler },
      (_, i) => `1787983240,,ui,say,==> workspace_host: creation chatter ${String(i)}`,
    ),
    '1787983336,,ui,say,==> workspace_host: /var/tmp/papercusp-image.XXXX/server.tgz: FAILED',
    '1787983337,,ui,say,==> workspace_host: sha256sum: WARNING: 1 computed checksum did NOT match',
    ...Array.from(
      { length: filler },
      (_, i) => `1787983391,,ui,say,==> workspace_host: teardown chatter ${String(i)}`,
    ),
    '1787983395,,ui,say,==> workspace_host: Deleting instance...',
    '1787983395,,ui,say,==> workspace_host: Builds finished but no artifacts were created.',
  ].join('\n');
}

/** The excerpt rule as it behaved BEFORE the cause band — the control implementation. */
function headTailOnly(text: string, budget: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) return trimmed;
  const headChars = Math.ceil(budget * DIAGNOSTIC_HEAD_FRACTION);
  return trimmed.slice(0, headChars) + trimmed.slice(-(budget - headChars));
}

describe('excerptDiagnostic', () => {
  it('keeps the failure line when it sits in the middle, where packer puts it', () => {
    const output = packerFailureOutput(200);
    const excerpt = excerptDiagnostic(output, 1_200);

    // The line that names WHICH artifact mismatched — the whole reason to read this at all.
    expect(excerpt).toContain('server.tgz: FAILED');
    expect(excerpt).toContain('did NOT match');
  });

  it('CONTROL: the previous head+tail rule dropped that same line', () => {
    const output = packerFailureOutput(200);

    // If this ever starts passing, the fixture stopped reproducing the bug and the test above
    // is no longer proving anything.
    expect(headTailOnly(output, 1_200)).not.toContain('server.tgz: FAILED');
  });

  it('still shows both ends, so the cause band is an addition and not a replacement', () => {
    const excerpt = excerptDiagnostic(packerFailureOutput(200), 1_200);

    expect(excerpt).toContain('Checking image does not exist');
    expect(excerpt).toContain('no artifacts were created');
    expect(excerpt).toMatch(/chars omitted from the middle/);
  });

  it('stays inside the budget it was given', () => {
    const budget = 1_200;
    const excerpt = excerptDiagnostic(packerFailureOutput(400), budget);
    const markers = excerpt.match(/… \[\d+ chars omitted from the middle of the output\] …/g) ?? [];
    const markerChars = markers.reduce((sum, marker) => sum + marker.length, 0);

    // Content stays within budget; the elision markers themselves are the only overhead.
    expect(excerpt.length - markerChars).toBeLessThanOrEqual(budget + markers.length * 4);
  });

  it('reports honestly how much it dropped on each side', () => {
    const output = packerFailureOutput(200);
    const excerpt = excerptDiagnostic(output, 1_200);
    const counts = [...excerpt.matchAll(/\[(\d+) chars omitted/g)].map((m) => Number(m[1]));

    expect(counts).toHaveLength(2);
    for (const count of counts) expect(count).toBeGreaterThan(0);
  });

  it('leaves the head-anchored shape alone: one elision, cause still first', () => {
    // The clean-room shape — cause on line 1. Adding a cause band here would be pure loss, so
    // the two-band path must still be what runs.
    const output = [
      'Error: Cannot find module rocksdb-native.node. Candidates:',
      ...Array.from({ length: 500 }, (_, i) => `  middle noise line ${String(i)}`),
      'papercusp-workspace.service: Consumed 8.465s CPU time.',
    ].join('\n');
    const excerpt = excerptDiagnostic(output, 400);

    expect(excerpt).toContain('Cannot find module rocksdb-native.node');
    expect(excerpt).toContain('Consumed 8.465s CPU time.');
    expect([...excerpt.matchAll(/chars omitted from the middle/g)]).toHaveLength(1);
  });

  it('falls back to two bands when nothing in the output looks like a failure', () => {
    const output = Array.from({ length: 500 }, (_, i) => `progress line ${String(i)}`).join('\n');
    const excerpt = excerptDiagnostic(output, 400);

    expect([...excerpt.matchAll(/chars omitted from the middle/g)]).toHaveLength(1);
  });

  it('does not anchor on routine progress chatter', () => {
    // "warning" and "not" are everywhere in build logs. A cause band that fired on them would
    // evict real content to show noise, so the signal set deliberately excludes them.
    const output = [
      ...Array.from({ length: 300 }, (_, i) => `head line ${String(i)}`),
      'warning: this is not the failure you are looking for',
      ...Array.from({ length: 300 }, (_, i) => `tail line ${String(i)}`),
    ].join('\n');

    expect([...excerptDiagnostic(output, 400).matchAll(/chars omitted/g)]).toHaveLength(1);
  });

  it('returns short output untouched rather than decorating it', () => {
    expect(excerptDiagnostic('  boom  ', 400)).toBe('boom');
  });

  /**
   * Real data from the r18b build. packer's `-machine-readable` stream tags every line by the
   * STREAM it came from, so anything a tool writes to stderr is tagged `ui,error` — including
   * needrestart cheerfully reporting that nothing needs restarting. Anchoring on that tag put
   * the cause band on benign chatter and elided the real failure a second time.
   *
   * The general trap: a stream tag is not a severity. stderr is where well-behaved tools write
   * progress.
   */
  it('does not treat packer\'s ui,error stream tag as a failure', () => {
    const output = [
      ...Array.from({ length: 200 }, (_, i) => `1787984050,,ui,say,==> host: setup line ${String(i)}`),
      '1787984134,,ui,error,==> host: Running kernel seems to be up-to-date.',
      '1787984134,,ui,error,==> host: No services need to be restarted.',
      ...Array.from({ length: 200 }, (_, i) => `1787984140,,ui,say,==> host: more chatter ${String(i)}`),
      '1787984200,,ui,say,==> host: guest tool jq is 1.7.1-3, not the pinned 1.7.1-4',
      '1787984200,,ui,say,==> host: Provisioning step had errors: Running the cleanup provisioner...',
      ...Array.from({ length: 200 }, (_, i) => `1787984201,,ui,say,==> host: teardown ${String(i)}`),
    ].join('\n');

    const excerpt = excerptDiagnostic(output, 1_200);

    // The line that actually explains the build failure.
    expect(excerpt).toContain('guest tool jq is 1.7.1-3, not the pinned 1.7.1-4');
    // And NOT the benign stderr-tagged chatter it used to anchor on.
    expect(excerpt).not.toContain('No services need to be restarted');
  });

  it('reads BACKWARDS from the consequence, because the cause is printed just above it', () => {
    // A runner reports "the step failed" only AFTER the failing script has printed why.
    const output = [
      ...Array.from({ length: 300 }, (_, i) => `head ${String(i)}`),
      'DIGEST MISMATCH on release-bundle: expected aaa, computed bbb, 12 bytes at /tmp/x',
      'Provisioning step had errors: Running the cleanup provisioner, if present...',
      ...Array.from({ length: 300 }, (_, i) => `teardown ${String(i)}`),
    ].join('\n');

    expect(excerptDiagnostic(output, 1_200)).toContain('DIGEST MISMATCH on release-bundle');
  });
});

describe('spillDiagnostic', () => {
  it('writes the COMPLETE text to disk, however long, and returns a readable path', () => {
    const full = Array.from({ length: 5_000 }, (_, i) => `line ${String(i)}`).join('\n');
    const path = spillDiagnostic('packer build', full);

    expect(path).not.toBeNull();
    expect(readFileSync(path!, 'utf8')).toBe(full);
    // The excerpt of the same text is lossy — that asymmetry is the whole point of the spill.
    expect(excerptDiagnostic(full, 4_000).length).toBeLessThan(full.length);
  });

  it('sanitises the label into the filename rather than trusting it as a path', () => {
    const path = spillDiagnostic('../../etc/passwd', 'x');

    expect(path).not.toBeNull();
    expect(basename(path!)).toBe('.._.._etc_passwd.log');
  });
});
