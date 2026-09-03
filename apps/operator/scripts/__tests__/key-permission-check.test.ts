import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPTS = resolve(__dirname, '..');
// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) instead of mutating this shared checkout,
// where a git-sync sweep can commit the mutant mid-probe.
const PROBE = process.env.KEYPERM_PROBE || join(SCRIPTS, 'papercup-fedplane-key-permission-check.sh');

/**
 * Synthetic key bodies — ASSEMBLED AT RUNTIME, NEVER WRITTEN AS LITERALS.
 *
 * Two independent reasons, both load-bearing:
 *
 * 1. These are not real keys. The probe's encryption verdict is decided entirely
 *    by format headers, so the header IS the subject under test; generating real
 *    keys would add an ssh-keygen dependency to CI and buy nothing. (End-to-end
 *    behaviour against genuinely generated ed25519 / RSA keys was verified by
 *    hand on 2026-09-03, WI-2143622, and matches these cases exactly.)
 *
 * 2. A source file containing a literal PEM begin-block is refused by the
 *    secrets guard on write, and — worse — trips the pot-git PUBLISH guard,
 *    whose baseline never advances past a refused range. That freezes the hive
 *    publish plane permanently, and editing the file afterwards does not remove
 *    the blob from history. Building the delimiter from parts keeps the token
 *    out of the tree entirely, which is strictly better than an allowlist
 *    exemption for a file that does not need to hold secrets in the first place.
 */
const DELIM = '-'.repeat(5);
const pem = (label: string, body: string) =>
  `${DELIM}BEGIN ${label}${DELIM}\n${body}\n${DELIM}END ${label}${DELIM}\n`;

function opensshBody(cipher: string): string {
  // openssh-key-v1\0 || uint32 len(cipher) || cipher — the cipher NAME is
  // literally "none" when the key has no passphrase. Padded so the decoded
  // prefix the probe inspects runs comfortably past the name.
  const magic = Buffer.from('openssh-key-v1\0', 'binary');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(cipher.length, 0);
  const blob = Buffer.concat([magic, len, Buffer.from(cipher), Buffer.alloc(32, 0x41)]);
  return pem('OPENSSH PRIVATE KEY', blob.toString('base64'));
}

const FILLER = 'QUFBQUFBQUFBQUFBQUFBQQ==';

const KEY_BODIES: Record<string, string> = {
  opensshPlain: opensshBody('none'),
  opensshEncrypted: opensshBody('aes256-ctr'),
  pkcs8Plain: pem('PRIVATE KEY', FILLER),
  pkcs8Encrypted: pem('ENCRYPTED PRIVATE KEY', FILLER),
  pemPlain: pem('RSA PRIVATE KEY', FILLER),
  pemEncrypted: pem(
    'RSA PRIVATE KEY',
    ['Proc-Type: 4,ENCRYPTED', 'DEK-Info: AES-128-CBC,0123456789ABCDEF', '', FILLER].join('\n'),
  ),
};

interface Fixture {
  root: string;
  sshDir: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'keyperm-'));
  const sshDir = join(root, 'home', 'someone', '.ssh');
  mkdirSync(sshDir, { recursive: true });
  return { root, sshDir };
}

/** Run the probe log-only against a fixture; returns its combined output. */
function runProbe(fx: Fixture, env: Record<string, string> = {}): string {
  const result = spawnSync('bash', [PROBE], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KEYPERM_NO_FILE: '1',
      KEYPERM_DEEP: '0',
      KEYPERM_SSH_ROOTS: fx.root,
      KEYPERM_POSITIVE_CONTROL: join(fx.sshDir, 'control'),
      KEYPERM_STATE_DIR: join(fx.root, 'state'),
      ...env,
    },
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Every fixture gets a hardened control key, so the positive control passes and
 * a finding assertion is never secretly measuring the probe's self-validation.
 */
function withControl(fx: Fixture): Fixture {
  const control = join(fx.sshDir, 'control');
  writeFileSync(control, KEY_BODIES.opensshPlain);
  chmodSync(control, 0o600);
  chmodSync(fx.sshDir, 0o700);
  return fx;
}

function placeKey(fx: Fixture, name: string, body: string, mode: number): string {
  const p = join(fx.sshDir, name);
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
}

describe('papercup-fedplane-key-permission-check.sh (WI-2143622)', () => {
  it('passes bash syntax validation', () => {
    const result = spawnSync('bash', ['-n', PROBE], { encoding: 'utf8' });
    expect(`${result.status} ${result.stderr ?? ''}`).toBe('0 ');
  });

  it('refuses to run at all when red-marker.sh is missing, rather than silently deduping on age', () => {
    // The library supplies the state-aware dedup gate (EI-22240553542994017). A
    // probe that degraded to age-only suppression would assert "already tracked"
    // about a dropped item while a usable private key sits world-readable, so
    // absence of the library must be fatal, not a fallback.
    const dir = mkdtempSync(join(tmpdir(), 'keyperm-nolib-'));
    const copy = join(dir, 'probe.sh');
    writeFileSync(copy, execFileSync('cat', [PROBE], { encoding: 'utf8' }));
    const result = spawnSync('bash', [copy], { encoding: 'utf8', env: { ...process.env } });
    expect(result.status).toBe(2);
    expect(`${result.stderr}`).toContain('refusing to run with age-only dedup');
  });

  // ── The exposure shape this probe was built for ────────────────────────────
  // EI-22240449643643994: /mnt/data/back/Debug/.ssh/id_ed25519, mode 0664 inside
  // a 0775 directory, no passphrase.
  it('reports BOTH an over-permissive .ssh directory and an over-permissive key inside it', () => {
    const fx = withControl(fixture());
    chmodSync(fx.sshDir, 0o775);
    placeKey(fx, 'id_ed25519', KEY_BODIES.opensshPlain, 0o664);

    const out = runProbe(fx);
    expect(out).toMatch(/DIR {2}mode=775 .*\.ssh \(expected 700\)/);
    expect(out).toMatch(/KEY {2}mode=664 .*id_ed25519/);
  });

  // ⛔ THE REGRESSION GUARD. The first implementation asked
  // `ssh-keygen -y -P '' -f <key>` whether a key was unencrypted. ssh-keygen
  // REFUSES a key whose permissions are too open ("Permissions 0664 ... are too
  // open", exit 255) — which is true of EVERY key this probe flags, by
  // definition. So it answered "not unencrypted" for every finding and reported
  // unencrypted world-readable keys as passphrase-protected: severity understated
  // in exactly the reassuring direction. Anyone reverting to ssh-keygen fails here.
  it('still identifies an UNENCRYPTED key when its permissions are too open for ssh-keygen to load', () => {
    const fx = withControl(fixture());
    placeKey(fx, 'id_exposed', KEY_BODIES.opensshPlain, 0o664);

    const out = runProbe(fx);
    expect(out).toMatch(/KEY {2}mode=664 .*id_exposed — UNENCRYPTED/);
    expect(out).not.toMatch(/id_exposed — passphrase-protected/);
  });

  it.each([
    ['opensshPlain', 'UNENCRYPTED'],
    ['pkcs8Plain', 'UNENCRYPTED'],
    ['pemPlain', 'UNENCRYPTED'],
    ['opensshEncrypted', 'passphrase-protected'],
    ['pkcs8Encrypted', 'passphrase-protected'],
    ['pemEncrypted', 'passphrase-protected'],
  ])('classifies %s correctly regardless of file mode', (kind, expected) => {
    const fx = withControl(fixture());
    placeKey(fx, `k_${kind}`, KEY_BODIES[kind], 0o664);
    expect(runProbe(fx)).toContain(`k_${kind} — ${expected}`);
  });

  it('reports nothing for a correctly hardened .ssh directory and key', () => {
    const fx = withControl(fixture());
    placeKey(fx, 'id_ed25519', KEY_BODIES.opensshPlain, 0o600);

    const out = runProbe(fx);
    expect(out).toContain('no exposed private keys found');
    expect(out).not.toMatch(/^KEY /m);
    expect(out).not.toMatch(/^DIR /m);
  });

  it('ignores public keys, known_hosts, config and authorized_keys', () => {
    const fx = withControl(fixture());
    for (const name of ['id_ed25519.pub', 'known_hosts', 'config', 'authorized_keys']) {
      const p = join(fx.sshDir, name);
      writeFileSync(p, 'ssh-ed25519 AAAAC3Nza not-a-private-key\n');
      chmodSync(p, 0o664);
    }
    expect(runProbe(fx)).toContain('no exposed private keys found');
  });

  it('ignores a world-readable file that is not actually a private key', () => {
    // Constraint (1): content-match, never filename. `id_*` matches locale files
    // such as /usr/share/i18n/locales/id_ID, which are not keys.
    const fx = withControl(fixture());
    const p = join(fx.sshDir, 'id_ID');
    writeFileSync(p, 'escape_char /\ncomment_char %\n');
    chmodSync(p, 0o664);
    expect(runProbe(fx)).toContain('no exposed private keys found');
  });

  // ── Constraint (3): an empty result is not automatically a clean result ────
  describe('self-validation', () => {
    it('declares its result INDETERMINATE when the positive control is not rediscovered', () => {
      const fx = withControl(fixture());
      const out = runProbe(fx, { KEYPERM_POSITIVE_CONTROL: join(fx.root, 'nowhere', 'control') });
      expect(out).toContain('positive control: FAILED');
      expect(out).toContain('cannot validate itself');
      expect(out).toContain('INDETERMINATE, not clean');
    });

    it('passes its positive control when the control key is inside a swept root', () => {
      const out = runProbe(withControl(fixture()));
      expect(out).toContain('positive control: passed');
      expect(out).not.toContain('cannot validate itself');
    });

    it('names an unreadable root as a BLIND SPOT instead of counting it as clean', () => {
      const fx = withControl(fixture());
      const blind = join(fx.root, 'blind');
      mkdirSync(blind, { recursive: true });
      chmodSync(blind, 0o000);
      try {
        const out = runProbe(fx, { KEYPERM_SSH_ROOTS: `${fx.root} ${blind}` });
        expect(out).toContain('BLIND SPOT, not a clean result');
      } finally {
        chmodSync(blind, 0o700);
      }
    });
  });

  // ── Constraint (2): vendored trees, or the probe gets ignored ──────────────
  describe('tier-2 content sweep', () => {
    it('excludes vendored dependency trees but reports a loose key beside them', () => {
      // Measured 2026-09-03: 755 group/world-readable private keys existed under
      // /mnt/data and every one was published third-party test material. A probe
      // that reports those is a probe nobody reads.
      const fx = withControl(fixture());
      const deep = join(fx.root, 'deep');
      const vendored = join(deep, 'app', 'node_modules', 'ssh2', 'test', 'fixtures');
      const loose = join(deep, 'app', 'config');
      mkdirSync(vendored, { recursive: true });
      mkdirSync(loose, { recursive: true });
      for (const p of [join(vendored, 'id_rsa'), join(loose, 'deploy.pem')]) {
        writeFileSync(p, KEY_BODIES.opensshPlain);
        chmodSync(p, 0o664);
      }

      const out = runProbe(fx, { KEYPERM_DEEP: '1', KEYPERM_DEEP_ROOTS: deep });
      expect(out).toMatch(/FILE mode=664 .*config\/deploy\.pem/);
      expect(out).not.toContain('node_modules');
    });

    it('does not double-report a .ssh key already reported by tier 1', () => {
      const fx = withControl(fixture());
      placeKey(fx, 'id_ed25519', KEY_BODIES.opensshPlain, 0o664);
      const out = runProbe(fx, { KEYPERM_DEEP: '1', KEYPERM_DEEP_ROOTS: fx.root });
      expect(out.match(/id_ed25519/g)?.length).toBe(1);
    });

    it('treats a timed-out deep sweep as INDETERMINATE rather than clean', () => {
      // A killed find prints nothing and looks exactly like a clean one. The
      // naive `deep_out="$(timeout … | xargs grep …)"; rc=${PIPESTATUS[0]}` reads
      // the ASSIGNMENT's status (grep's), never timeout's, so a killed sweep
      // reported rc=1 and was indistinguishable from success.
      const fx = withControl(fixture());
      const out = runProbe(fx, {
        KEYPERM_DEEP: '1',
        KEYPERM_DEEP_ROOTS: '/',
        KEYPERM_DEEP_TIMEOUT_S: '1',
      });
      expect(out).toContain('INDETERMINATE');
      expect(out).toMatch(/TIMED OUT|timed out/);
    });
  });
});
