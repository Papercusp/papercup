/**
 * WI-10004636 — three installers carry the same scoped AppArmor grant for /usr/bin/bwrap, because
 * they share no build graph: the hosted workspace-host bootstrap (rendered from
 * `@papercusp/deployment-driver`, the canonical copy), the Server .deb postinst (the separate
 * `papercusp-desktop` submodule) and the capacity-test VM bootstrap. This pins the two shell copies
 * to the canonical lines, so editing one without the others fails here instead of drifting.
 *
 * The FIXTURE CONTROLS are load-bearing: once the live assertions are green they stop proving the
 * extractors work. Each control reproduces a shape that MUST be caught — a drifted body, and a file
 * whose profile the extractor can no longer find (which must fail, never compare as empty).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BWRAP_BIN, bwrapUsernsAppArmorProfileLines } from '@papercusp/deployment-driver';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const POSTINST = join(REPO_ROOT, 'papercusp-desktop/src-tauri/deb/postinstall.sh');
const CAPACITY = join(REPO_ROOT, 'scripts/agent-capacity/vm/bootstrap-agent-vm.sh');

/** The postinst writes `$marker …` then the profile through a `<<PROFILE` heredoc. */
function postinstProfile(src: string): string[] | null {
  const m = /cat > "\$profile" <<PROFILE[^\n]*\n([\s\S]*?)\nPROFILE\n/.exec(src);
  if (!m) return null;
  return m[1]
    .split('\n')
    .slice(1) // the marker line
    .map((line) => line.replaceAll('$bwrap_bin', BWRAP_BIN));
}

/** The capacity bootstrap holds the profile in a single-quoted shell variable. */
function capacityProfile(src: string): string[] | null {
  const m = /^BWRAP_APPARMOR_PROFILE='([\s\S]*?)\n'$/m.exec(src);
  return m ? m[1].split('\n') : null;
}

const canonical = [...bwrapUsernsAppArmorProfileLines(BWRAP_BIN)];

describe('bwrap userns AppArmor grant parity (WI-10004636)', () => {
  it('the Server .deb postinst installs the canonical profile', () => {
    expect(postinstProfile(readFileSync(POSTINST, 'utf8'))).toEqual(canonical);
  });

  it('the capacity-test VM bootstrap installs the canonical profile', () => {
    expect(capacityProfile(readFileSync(CAPACITY, 'utf8'))).toEqual(canonical);
  });

  describe('fixture controls', () => {
    const postinst = readFileSync(POSTINST, 'utf8');
    const capacity = readFileSync(CAPACITY, 'utf8');

    it('catches a drifted body in either copy', () => {
      expect(postinst).toContain('  userns,\n');
      expect(capacity).toContain('  userns,\n');
      expect(postinstProfile(postinst.replace('  userns,\n', '  userns, mount,\n'))).not.toEqual(canonical);
      expect(capacityProfile(capacity.replace('  userns,\n', '  userns, mount,\n'))).not.toEqual(canonical);
    });

    it('fails, rather than comparing empty, when a copy can no longer be found', () => {
      expect(postinstProfile(postinst.replace('<<PROFILE', '<<EOF'))).toBeNull();
      expect(capacityProfile(capacity.replace('BWRAP_APPARMOR_PROFILE=', 'PROFILE='))).toBeNull();
    });
  });
});
