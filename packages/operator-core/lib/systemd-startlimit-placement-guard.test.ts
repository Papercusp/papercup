/**
 * systemd-startlimit-placement-guard.test.ts — the systemd StartLimit-placement
 * CI guard's detection predicate (EI-19381535849234617).
 *
 * The guard (`scripts/check-systemd-startlimit-placement.mjs`) runs green on
 * the clean tree (no-false-positive direction). This locks the direction the
 * item actually asks for — that it FLAGS StartLimitIntervalSec/StartLimitBurst
 * sitting under `[Service]` (where systemd silently ignores them) while NOT
 * flagging the same keys correctly placed under `[Unit]`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its predicate only.
import { findMisplacedStartLimitKeys } from '../../../scripts/check-systemd-startlimit-placement.mjs';

describe('systemd StartLimit-placement guard predicate (EI-19381535849234617)', () => {
  it('FLAGS StartLimitIntervalSec under [Service]', () => {
    const unit = ['[Unit]', 'Description=x', '', '[Service]', 'Type=simple', 'StartLimitIntervalSec=0'].join('\n');
    const hits = findMisplacedStartLimitKeys(unit);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.key).toBe('StartLimitIntervalSec');
  });

  it('FLAGS StartLimitBurst under [Service]', () => {
    const unit = ['[Service]', 'StartLimitBurst=6'].join('\n');
    expect(findMisplacedStartLimitKeys(unit)).toHaveLength(1);
  });

  it('FLAGS both keys, each on its own line, when both are misplaced', () => {
    const unit = ['[Service]', 'StartLimitIntervalSec=600', 'StartLimitBurst=6'].join('\n');
    const hits = findMisplacedStartLimitKeys(unit);
    expect(hits.map((h: { key: string }) => h.key)).toEqual(['StartLimitIntervalSec', 'StartLimitBurst']);
  });

  it('does NOT flag the keys correctly placed under [Unit]', () => {
    const unit = ['[Unit]', 'StartLimitIntervalSec=0', 'StartLimitBurst=5', '', '[Service]', 'Type=simple'].join(
      '\n',
    );
    expect(findMisplacedStartLimitKeys(unit)).toHaveLength(0);
  });

  it('does NOT flag an unrelated [Service] key', () => {
    const unit = ['[Service]', 'Restart=always', 'RestartSec=2'].join('\n');
    expect(findMisplacedStartLimitKeys(unit)).toHaveLength(0);
  });

  it('does NOT flag a key mentioned only in a comment', () => {
    const unit = ['[Service]', '# StartLimitIntervalSec=0 was here once, moved to [Unit] above', 'Type=simple'].join(
      '\n',
    );
    expect(findMisplacedStartLimitKeys(unit)).toHaveLength(0);
  });

  it('correctly re-scopes across multiple sections (a key becomes safe again after leaving [Service])', () => {
    // [Service] ... [Install] with no further [Unit] — the key must not leak
    // its "flagged" status past the section that actually made it dangerous.
    const unit = ['[Service]', 'Type=simple', '', '[Install]', 'WantedBy=default.target'].join('\n');
    expect(findMisplacedStartLimitKeys(unit)).toHaveLength(0);
  });

  it('a bare drop-in with no [Unit] header at all (the real-world bug shape) is flagged', () => {
    // The actual 50-supervision.conf shape before the fix: the WHOLE file is one
    // [Service] block, no [Unit] section present anywhere.
    const dropIn = ['[Service]', '# comment', 'StartLimitIntervalSec=600', 'StartLimitBurst=6'].join('\n');
    const hits = findMisplacedStartLimitKeys(dropIn);
    expect(hits.map((h: { key: string }) => h.key)).toEqual(['StartLimitIntervalSec', 'StartLimitBurst']);
  });

  it('keeps the phone media-plane unit sources free of misplaced directives', () => {
    const unitPaths = [
      '../../../infra/phone-app/systemd/papercusp-phone-sip.service',
      '../../../infra/phone-app/systemd/papercusp-phone-livekit.service',
    ];
    for (const relativePath of unitPaths) {
      const unit = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
      expect(findMisplacedStartLimitKeys(unit), relativePath).toEqual([]);
    }
  });
});
