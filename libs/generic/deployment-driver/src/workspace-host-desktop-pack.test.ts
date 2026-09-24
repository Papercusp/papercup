/**
 * workspace-host-desktop-pack.test.ts — P-012's install-time guarantees.
 *
 * The script this covers runs as root on a customer's VM exactly once per opt-in, and
 * its failures are quiet ones: a listener on the wrong interface still serves pixels,
 * and a desktop user in the wrong group still runs desktops. Neither shows up as a
 * broken feature, so both are asserted here against the rendered script rather than
 * left to be noticed in production.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_WORKSPACE_HOST_DESKTOP_USER,
  PINNED_KASMVNC_ARTIFACT,
  WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX,
  WORKSPACE_HOST_DESKTOP_PACK_CHECKS,
  WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION,
  WORKSPACE_HOST_DESKTOP_PACK_PHASES,
  WORKSPACE_HOST_DESKTOP_ROOT,
  buildWorkspaceHostDesktopPackScript,
  buildWorkspaceDesktopEgressRules,
  parseWorkspaceHostDesktopPackAttestation,
  type WorkspaceHostDesktopPackInput,
} from './workspace-host-desktop-pack';
import {
  DEFAULT_WORKSPACE_HOST_AGENT_USER,
  DEFAULT_WORKSPACE_HOST_SERVICE_USER,
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_STATE_ROOT,
} from './workspace-host-bootstrap';

const input = (over: Partial<WorkspaceHostDesktopPackInput> = {}): WorkspaceHostDesktopPackInput => ({
  contractVersion: WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION,
  action: 'install',
  hostId: 'host-abc',
  ...over,
});

const render = (over: Partial<WorkspaceHostDesktopPackInput> = {}): string =>
  buildWorkspaceHostDesktopPackScript(input(over)).script;

describe('P-012 / D-018 — the pack is a layer, not a base image', () => {
  it('installs a fixed isolated runtime with a service-only socket and cgroup teardown', () => {
    const script = render();
    expect(script).toContain('bin/papercusp-desktop-session.cjs');
    expect(script).toContain('SocketMode=0660');
    expect(script).toContain('SocketGroup=$SERVICE_USER');
    expect(script).toContain('User=$DESKTOP_USER');
    expect(script).toContain('NoNewPrivileges=true');
    expect(script).toContain('ProtectHome=true');
    expect(script).toContain('InaccessiblePaths=/var/lib/papercusp /srv/papercusp/workspaces');
    expect(script).toContain('JoinsNamespaceOf=papercusp-workspace.service');
    expect(script).toContain('KillMode=control-group');
    expect(script).toContain('systemd-analyze verify');
    expect(script).toContain('fail desktop-runtime');
    expect(script).toContain('fail desktop-socket');
    expect(script).toContain('ExecStartPre=+/usr/sbin/nft -f /etc/papercusp/desktop-egress.nft');
    expect(script).toContain('fail desktop-egress-isolation');
    expect(script).not.toContain('EnvironmentFile=');
    expect(script).not.toContain('setfacl');
  });
  it('rejects identity override and unit-file injection before any installation', () => {
    expect(() => render({ isolation: { desktopUser: 'other-desktop' } })).toThrow(/fixed/);
    expect(() => render({ isolation: { serviceUser: 'papercusp\nExecStart=evil' } })).toThrow(/Unix account/);
  });
  it('refuses to run on a host the bootstrap has not already prepared', () => {
    // The pack layers onto a bootstrapped host. Without this the failure mode is
    // "desktops mysteriously do not work" much later, instead of one legible refusal.
    expect(render()).toMatch(/\[ -d '\/opt\/papercusp' \] \|\| fail host-bootstrapped/);
  });

  it('installs with --no-install-recommends', () => {
    // Several of these packages RECOMMEND a display manager. A workspace host must
    // never acquire a login screen as a side effect of opting into agent desktops.
    const script = render();
    const installs = script.match(/apt-get install[^\n]*/g) ?? [];
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) expect(line).toContain('--no-install-recommends');
  });

  it('treats an unreachable archive as an error and retries every archive step (WI-10002837)', () => {
    // Without --error-on=any a failed index fetch is a warning and exit 0; the pack then
    // died one command later on a "missing" package that was merely unreachable.
    const script = render();
    expect(script).toContain('retry 10 apt-get update -qq --error-on=any');
    const installs = script.match(/^.*apt-get install[^\n]*/gm) ?? [];
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) expect(line).toMatch(/^retry \d+ apt-get install/);
    expect(script.indexOf('retry() {')).toBeLessThan(script.indexOf('retry 10 apt-get update'));
  });

  it('ships a usable desktop floor: a terminal for the openbox menu and a root painter (WI-10002863)', () => {
    // Measured on avi-test r43: openbox's stock menu executes x-terminal-emulator, which
    // nothing provided, and the root stayed black, so Watch could not tell "empty" from "dead".
    const script = render();
    const install = script.match(/^retry \d+ apt-get install -y --no-install-recommends (?!"\$KASM_DEB").*$/m)?.[0] ?? '';
    expect(install.split(' ')).toEqual(expect.arrayContaining(['xterm', 'x11-xserver-utils']));
    expect(script).toContain('command -v x-terminal-emulator >/dev/null 2>&1 || fail x-stack');
    expect(script).toContain('command -v xsetroot  >/dev/null 2>&1 || fail x-stack');
  });

  it('pins Ubuntu 24.04, matching the bootstrap contract', () => {
    expect(render()).toMatch(/VERSION_ID:-\}" = '24\.04' \] \|\| fail ubuntu-24\.04/);
  });
});

describe('desktop network identity boundary', () => {
  it('scopes rules to the desktop uid without flushing the host firewall', () => {
    const rules = buildWorkspaceDesktopEgressRules(65534);
    expect(rules).not.toContain('flush ruleset');
    expect(rules).toContain('meta skuid 65534 ct direction reply accept');
    expect(rules).toContain('meta skuid 65534 fib daddr type local reject');
    expect(rules).toContain('169.254.0.0/16 reject');
    expect(rules).toContain('fe80::/10, fc00::/7');
    expect(() => buildWorkspaceDesktopEgressRules(0)).toThrow();
  });

  const canIsolate = process.platform === 'linux' && spawnSync('sudo', ['-n', 'unshare', '-n', '/bin/true'], { timeout: 5000, stdio: 'ignore' }).status === 0;
  it.skipIf(!canIsolate)('kernel blocks desktop-to-operator traffic but preserves viewer replies and DNS', () => {
    // Every interface, listener and firewall rule lives in a disposable NETWORK namespace.
    const probe = spawnSync('sudo', ['-n', 'unshare', '-n', 'python3', '-c', `
import sys, subprocess, socket, multiprocessing, os, time, json
rules = sys.stdin.read()
subprocess.run(['ip', 'link', 'set', 'lo', 'up'], check=True)
def server(host, port, uid, ready):
    if uid:
        os.setgroups([]); os.setgid(uid); os.setuid(uid)
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((host, port)); s.listen(); ready.set()
    while True:
        c, _ = s.accept()
        with c: c.sendall(b'ok')
def read(host, port, uid=0):
    code = 'import socket; s=socket.create_connection((' + repr(host) + ',' + str(port) + '),2); assert s.recv(2)==b"ok"'
    return subprocess.run([sys.executable, '-c', code], user=uid, group=uid, extra_groups=[], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4).returncode == 0
children=[]
try:
    for host,port,uid in [('127.0.0.1',3070,0),('127.0.0.1',7110,65534),('127.0.0.53',53,0)]:
        ready=multiprocessing.Event(); p=multiprocessing.Process(target=server,args=(host,port,uid,ready)); p.start(); children.append(p)
        assert ready.wait(3)
    assert read('127.0.0.1',3070,65534), 'positive control before firewall'
    for _ in range(2): subprocess.run(['nft','-f','-'],input=rules,text=True,check=True)
    result={'operatorBlocked':not read('127.0.0.1',3070,65534),'operatorUnaffected':read('127.0.0.1',3070),'viewerReply':read('127.0.0.1',7110),'dns':read('127.0.0.53',53,65534)}
    print(json.dumps(result)); assert all(result.values())
finally:
    for p in children: p.terminate(); p.join()
`], { input: buildWorkspaceDesktopEgressRules(65534), encoding: 'utf8', timeout: 25_000 });
    expect(probe.status, probe.stderr + probe.stdout).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({ operatorBlocked: true, operatorUnaffected: true, viewerReply: true, dns: true });
  }, 30_000);
});

describe('P-012 / D-020 — the listener is loopback-only', () => {
  it('writes interface: 127.0.0.1 into the managed config', () => {
    expect(render()).toMatch(/^ {2}interface: 127\.0\.0\.1$/m);
  });

  it('VERIFIES the written value instead of trusting the write', () => {
    const script = render();
    expect(script).toContain('fail loopback-only-listener');
    // Both directions: the right value present AND the wildcard absent. Asserting only
    // the first passes on a file that contains both, which is precisely what a
    // careless merge of the shipped defaults with ours would produce.
    expect(script).toMatch(/grep -qE '\^\[\[:space:\]\]\+interface:[^']*127\\\.0\\\.0\\\.1/);
    expect(script).toMatch(
      /grep -qE '\^\[\[:space:\]\]\+interface:[^']*0\\\.0\\\.0\\\.0'[\s\S]{0,60}fail loopback-only-listener/,
    );
  });

  it('never writes the package default 0.0.0.0 as a live config value', () => {
    // The string appears only inside the negative grep guard above, never as YAML.
    expect(render()).not.toMatch(/^ {2}interface: 0\.0\.0\.0$/m);
  });
});

describe('P-012 — no credential bleed into sandboxes', () => {
  it('REFUSES to run desktops as the workspace account', () => {
    // That account owns the customer checkout and its git/agent credentials, so a
    // sandbox escape would become a credential compromise. This is the single most
    // tempting simplification in the whole pack, which is why it throws rather than warns.
    expect(() =>
      buildWorkspaceHostDesktopPackScript(
        input({ isolation: { desktopUser: DEFAULT_WORKSPACE_HOST_WORKSPACE_USER } }),
      ),
    ).toThrow(/must not run as the workspace, service, or agent account/i);
  });

  it('REFUSES to run desktops as the service account', () => {
    expect(() =>
      buildWorkspaceHostDesktopPackScript(
        input({ isolation: { desktopUser: DEFAULT_WORKSPACE_HOST_SERVICE_USER } }),
      ),
    ).toThrow(/must not run as the workspace, service, or agent account/i);
  });

  it('REFUSES to run desktops as the AGENT account (D-248)', () => {
    // The newest of the three, and the one a reader is most likely to leave out: since D-248
    // the delivered Claude/Codex/OMP material lives in the agent account's home, not the
    // workspace account's, so this is now the account whose compromise leaks model credentials.
    expect(() =>
      buildWorkspaceHostDesktopPackScript(
        input({ isolation: { desktopUser: DEFAULT_WORKSPACE_HOST_AGENT_USER } }),
      ),
    ).toThrow(/must not run as the workspace, service, or agent account/i);
  });

  it('creates a nologin system account with a 0700 home', () => {
    const script = render();
    expect(script).toContain('--shell /usr/sbin/nologin');
    expect(script).toMatch(/install -d .*-m 0700 "\$DESKTOP_ROOT"/);
    expect(script).toContain('--no-create-home');
  });

  it('asserts the NEGATIVE: not in the workspace, service or agent group, and cannot read EITHER protected home (D-248)', () => {
    const script = render();
    // Group membership...
    expect(script).toMatch(
      /id -nG "\$DESKTOP_USER"[\s\S]{0,80}grep -qx "\$WORKSPACE_USER" && fail workspace-credential-isolation/,
    );
    expect(script).toMatch(
      /id -nG "\$DESKTOP_USER"[\s\S]{0,80}grep -qx "\$SERVICE_USER" && fail workspace-credential-isolation/,
    );
    expect(script).toMatch(
      /id -nG "\$DESKTOP_USER"[\s\S]{0,80}grep -qx "\$AGENT_USER" && fail workspace-credential-isolation/,
    );
    // ...and, decisively, actual reachability, which is the claim that matters however
    // the groups happen to be arranged.
    //
    // BOTH homes. Until D-248 the agent credentials lived in the workspace account's home, so
    // one reachability check covered them. The split moved them without touching this pack —
    // the check kept passing over a home the credentials had left, which is the failure mode
    // this assertion now exists to prevent: coverage that reads as coverage and is not.
    expect(script).toMatch(
      /for protected_user in "\$WORKSPACE_USER" "\$AGENT_USER"; do/,
    );
    expect(script).toMatch(
      /runuser -u "\$DESKTOP_USER" -- test -r "\$protected_home"[\s\S]{0,60}fail workspace-credential-isolation/,
    );
    expect(script).toContain('AGENT_USER=');
  });

  it('asserts the POSITIVE mirror: the desktop user can actually WRITE its own root', () => {
    // REGRESSION GUARD. Measured on a live workspace VM: the pack installed cleanly,
    // every phase passed, and it attested `status: healthy` with all checks ok — while
    // the desktop root was completely unusable by the desktop user. The root was
    // `${STATE_ROOT}/desktop`, and `/var/lib/papercusp` is 0750 papercusp:papercusp, so
    // the desktop user (deliberately not in that group) had no traversal: `namei`
    // reported `desktop - Permission denied`. `kasmvncpasswd` could not write the
    // per-session credential file, so the ticketed viewer could not be provisioned.
    //
    // Every existing assertion still passed, because `install -d -o <user>` succeeds as
    // root regardless of whether the owner can reach the result. OWNERSHIP IS NOT
    // USABILITY, so the only honest check asks the desktop user itself.
    const script = render();
    expect(script).toMatch(/runuser -u "\$DESKTOP_USER" -- test -w "\$DESKTOP_ROOT" \|\| fail desktop-root-writable/);
    expect(WORKSPACE_HOST_DESKTOP_PACK_CHECKS).toContain('desktop-root-writable');
  });

  it('keeps the desktop root OUT of the service user private state root', () => {
    // The structural half of the bug above, asserted independently of the runtime probe
    // because it is the thing that made the probe fail. These two requirements cannot
    // both hold while the root is nested: the desktop user needs traversal, and granting
    // it means joining the service group — which is precisely the credential bleed
    // `workspace-credential-isolation` exists to prevent. So the path must stay outside.
    expect(WORKSPACE_HOST_DESKTOP_ROOT.startsWith(`${WORKSPACE_HOST_STATE_ROOT}/`)).toBe(false);
    expect(render()).toContain(`DESKTOP_ROOT='${WORKSPACE_HOST_DESKTOP_ROOT}'`);
  });

  it('defaults to an identity distinct from both bootstrap accounts', () => {
    expect(DEFAULT_WORKSPACE_HOST_DESKTOP_USER).not.toBe(DEFAULT_WORKSPACE_HOST_WORKSPACE_USER);
    expect(DEFAULT_WORKSPACE_HOST_DESKTOP_USER).not.toBe(DEFAULT_WORKSPACE_HOST_SERVICE_USER);
  });
});

describe('P-012 — the KasmVNC artifact is pinned and verified before use', () => {
  it('carries the measured 1.5.0 noble digest', () => {
    expect(PINNED_KASMVNC_ARTIFACT.debSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(PINNED_KASMVNC_ARTIFACT.debUrl).toMatch(/^https:\/\/github\.com\/kasmtech\/KasmVNC\//);
    expect(PINNED_KASMVNC_ARTIFACT.debUrl).toContain('noble');
  });

  it('checks the digest BEFORE dpkg touches the file', () => {
    const script = render();
    const verify = script.indexOf('sha256sum -c');
    const install = script.indexOf('apt-get install -y --no-install-recommends "$KASM_DEB"');
    expect(verify).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    // Ordering is the whole property: verifying afterwards means a substituted package
    // has already run its maintainer scripts as root.
    expect(verify).toBeLessThan(install);
  });

  it('rejects an artifact URL carrying credentials or a query string', () => {
    for (const debUrl of [
      'https://u:p@example.com/k.deb',
      'https://example.com/k.deb?t=abc',
      'http://example.com/k.deb',
    ]) {
      expect(() =>
        buildWorkspaceHostDesktopPackScript(
          input({ artifact: { ...PINNED_KASMVNC_ARTIFACT, debUrl } }),
        ),
      ).toThrow();
    }
  });

  it('rejects a malformed digest rather than fetching against it', () => {
    expect(() =>
      buildWorkspaceHostDesktopPackScript(
        input({ artifact: { ...PINNED_KASMVNC_ARTIFACT, debSha256: 'deadbeef' } }),
      ),
    ).toThrow(/sha256/i);
  });
});

describe('P-012 — the attestation is complete or it is a failure', () => {
  const healthy = (over: Record<string, unknown> = {}): string =>
    WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX +
    JSON.stringify({
      contractVersion: WORKSPACE_HOST_DESKTOP_PACK_CONTRACT_VERSION,
      hostId: 'host-abc',
      action: 'install',
      ubuntuVersion: '24.04',
      observedAt: '2026-08-30T00:00:00Z',
      status: 'healthy',
      kasmvnc: { version: '1.5.0', sha256: PINNED_KASMVNC_ARTIFACT.debSha256 },
      checks: WORKSPACE_HOST_DESKTOP_PACK_CHECKS.map((name) => ({ name, ok: true })),
      ...over,
    });

  it('accepts a complete healthy attestation', () => {
    const parsed = parseWorkspaceHostDesktopPackAttestation(`noise\n${healthy()}\nmore noise`);
    expect(parsed.status).toBe('healthy');
    expect(parsed.kasmvnc.sha256).toBe(PINNED_KASMVNC_ARTIFACT.debSha256);
  });

  it('REJECTS an attestation that omits any declared check', () => {
    // A partial run must read as a failure, not as a pack that installed slightly less.
    const partial = healthy({
      checks: WORKSPACE_HOST_DESKTOP_PACK_CHECKS.filter(
        (c) => c !== 'workspace-credential-isolation',
      ).map((name) => ({ name, ok: true })),
    });
    expect(() => parseWorkspaceHostDesktopPackAttestation(partial)).toThrow(
      /missing checks: workspace-credential-isolation/,
    );
  });

  it('REJECTS a check reported not-ok', () => {
    const notOk = healthy({
      checks: WORKSPACE_HOST_DESKTOP_PACK_CHECKS.map((name) => ({
        name,
        ok: name !== 'loopback-only-listener',
      })),
    });
    expect(() => parseWorkspaceHostDesktopPackAttestation(notOk)).toThrow(/missing checks/);
  });

  it('rejects a missing line, bad JSON, and a foreign contract version', () => {
    expect(() => parseWorkspaceHostDesktopPackAttestation('nothing here')).toThrow(/no attestation/i);
    expect(() =>
      parseWorkspaceHostDesktopPackAttestation(`${WORKSPACE_HOST_DESKTOP_PACK_ATTESTATION_PREFIX}{`),
    ).toThrow(/valid JSON/i);
    expect(() =>
      parseWorkspaceHostDesktopPackAttestation(healthy({ contractVersion: 'other-v9' })),
    ).toThrow(/contract version/i);
  });

  it('emits every declared check from the script itself', () => {
    // Guards the other direction: a check added to the contract but never emitted by
    // the script would make every real install fail to parse. Catching it here means
    // that lands as a unit-test red rather than as a fleet of un-attestable hosts.
    const script = render();
    for (const check of WORKSPACE_HOST_DESKTOP_PACK_CHECKS) {
      expect(script, `script never emits check ${check}`).toContain(`"name":"${check}"`);
    }
  });
});

describe('P-012 — script hygiene', () => {
  it('runs under set -euo pipefail', () => {
    expect(render()).toContain('set -euo pipefail');
  });

  it('announces every declared phase', () => {
    const script = render();
    for (const phase of WORKSPACE_HOST_DESKTOP_PACK_PHASES) {
      expect(script, `script never announces phase ${phase}`).toContain(`phase ${phase}`);
    }
  });

  it('rejects credential-shaped public metadata', () => {
    // Exercises the same `assertWorkspaceHostSecretIsolation` guard the bootstrap uses,
    // via its KEY heuristic rather than its PEM-value one — deliberately, so this file
    // never has to contain a key-shaped literal for a scanner to find later.
    expect(() =>
      buildWorkspaceHostDesktopPackScript(
        input({ publicMetadata: { deployToken: 'placeholder' } }),
      ),
    ).toThrow(/forbidden/i);
  });

  it('shell-quotes the hostId so it cannot break out of the assignment', () => {
    const script = buildWorkspaceHostDesktopPackScript(input({ hostId: "h'; rm -rf /; #" })).script;
    expect(script).toContain(`HOST_ID='h'\\''; rm -rf /; #'`);
    expect(script).not.toMatch(/^HOST_ID=h'; rm -rf/m);
  });
});
