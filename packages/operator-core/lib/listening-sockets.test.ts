/**
 * listening-sockets — parser + the honest-null contract (D-017 / WI-6149).
 *
 * The fixture rows below are REAL `ss -tlnpH` output captured from this host on
 * 2026-07-26, including the alignment padding, because the parser's whole job is
 * to survive that formatting. Hand-tidied sample rows would test a format the
 * tool never actually sees.
 */
import { describe, it, expect } from 'vitest';
import { parseSsOutput, splitHostPort } from './listening-sockets';
import tool from './agent-tools/dev/listening_ports';

/** Verbatim `ss -tlnpH` rows: owner-visible, owner-hidden, loopback, ipv6. */
const SS_FIXTURE = [
  'LISTEN 0      5                          0.0.0.0:2022       0.0.0.0:*    users:(("whisper-server",pid=2027115,fd=3))  ',
  'LISTEN 0      4096                       0.0.0.0:587        0.0.0.0:*                                                 ',
  'LISTEN 0      511                      127.0.0.1:17521      0.0.0.0:*    users:(("code",pid=2820286,fd=48))           ',
  'LISTEN 0      511                        0.0.0.0:3170       0.0.0.0:*    users:(("node-MainThread",pid=47585,fd=26))  ',
  'LISTEN 0      4096                          [::]:80            [::]:*                                                 ',
  'LISTEN 0      128                         [::1]:6010          [::]:*    users:(("sshd",pid=1234,fd=9))                ',
].join('\n');

describe('splitHostPort', () => {
  it('splits ipv4, loopback, and bracketed ipv6', () => {
    expect(splitHostPort('0.0.0.0:3070')).toEqual({ address: '0.0.0.0', port: 3070 });
    expect(splitHostPort('127.0.0.1:17521')).toEqual({ address: '127.0.0.1', port: 17521 });
    expect(splitHostPort('[::]:80')).toEqual({ address: '::', port: 80 });
    expect(splitHostPort('[::1]:6010')).toEqual({ address: '::1', port: 6010 });
  });

  it('returns null rather than guessing on a malformed local address', () => {
    expect(splitHostPort('garbage')).toBeNull();
    expect(splitHostPort('0.0.0.0:notaport')).toBeNull();
  });
});

describe('parseSsOutput', () => {
  const rows = parseSsOutput(SS_FIXTURE);

  it('parses every fixture row', () => {
    expect(rows).toHaveLength(6);
  });

  it('resolves the owning process when the kernel reveals it', () => {
    const staging = rows.find((r) => r.port === 3170);
    expect(staging).toMatchObject({
      port: 3170,
      address: '0.0.0.0',
      family: 'ipv4',
      pid: 47585,
      command: 'node-MainThread',
      ownerVisible: true,
    });
  });

  it('reports an unreadable owner as LISTENING-but-hidden, never as absent', () => {
    // THE LOAD-BEARING CONTRACT (D-017). :587 is a root-owned service; as uid
    // 1000 the kernel shows the socket but not its process. The row must still
    // EXIST — an agent that sees no row concludes the port is free and binds it.
    const smtp = rows.find((r) => r.port === 587);
    expect(smtp, ':587 must still be reported — it IS bound, just by another user').toBeDefined();
    expect(smtp).toMatchObject({ pid: null, command: null, ownerVisible: false });
  });

  it('distinguishes ipv6 rows and keeps their address unbracketed', () => {
    const v6 = rows.find((r) => r.port === 80);
    expect(v6).toMatchObject({ address: '::', family: 'ipv6', ownerVisible: false });
    const loopback6 = rows.find((r) => r.port === 6010);
    expect(loopback6).toMatchObject({ address: '::1', family: 'ipv6', pid: 1234, ownerVisible: true });
  });

  it('flags reserved core-service ports', () => {
    expect(rows.find((r) => r.port === 3170)?.reserved).toBe(true);
    expect(rows.find((r) => r.port === 2022)?.reserved).toBe(false);
  });

  it('drops non-LISTEN rows even if -l is somehow bypassed', () => {
    const withEstablished = `${SS_FIXTURE}\nESTAB  0      0                    127.0.0.1:3070     127.0.0.1:54321 users:(("node",pid=1,fd=2))`;
    expect(parseSsOutput(withEstablished)).toHaveLength(6);
  });

  it('skips blank and unparseable lines instead of emitting junk rows', () => {
    expect(parseSsOutput('\n\n   \nnot an ss row at all\n')).toEqual([]);
  });

  it('collapses a SO_REUSEPORT cluster into ONE row carrying every pid', () => {
    // Caught by driving the real handler, not by a fixture: the live operator on
    // :3070 binds one socket per worker, so `ss` prints 16 near-identical rows.
    // Reporting them raw makes "who owns this port" harder to answer and lets one
    // clustered server swamp a whole-table listing.
    const cluster = [
      'LISTEN 0      511                      127.0.0.1:3070       0.0.0.0:*    users:(("node-MainThread",pid=530811,fd=23))',
      'LISTEN 0      511                      127.0.0.1:3070       0.0.0.0:*    users:(("node-MainThread",pid=530751,fd=23))',
      'LISTEN 0      511                      127.0.0.1:3070       0.0.0.0:*    users:(("node-MainThread",pid=530819,fd=23))',
    ].join('\n');
    const grouped = parseSsOutput(cluster);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      port: 3070,
      pid: 530811,
      listeners: 3,
      command: 'node-MainThread',
      ownerVisible: true,
    });
    expect(grouped[0].pids).toEqual([530811, 530751, 530819]);
  });

  it('carries the accept queue — Recv-Q/Send-Q, which on a LISTEN socket are not bytes', () => {
    // EI-19465075959589134. These two columns were parsed and DISCARDED, and they
    // are the only signal that separates a wedged listener from a healthy one.
    // On LISTEN: Recv-Q = connections established and waiting for accept(),
    // Send-Q = the listen(2) backlog. Every fixture row here is healthy (0), so
    // this pins the healthy reading too — a parser that always reported 0 would
    // look identical on a wedge, which is the failure being prevented.
    expect(rows.find((r) => r.port === 3170)?.acceptQueue).toEqual({ pending: 0, backlog: 511 });
    expect(rows.find((r) => r.port === 2022)?.acceptQueue).toEqual({ pending: 0, backlog: 5 });
    expect(rows.find((r) => r.port === 587)?.acceptQueue).toEqual({ pending: 0, backlog: 4096 });
  });

  it('reads a WEDGED listener as a non-zero pending count, not as a missing row', () => {
    // VERBATIM `ss -tlnpH` output from a REAL wedge produced on this host
    // (2026-08-04), not a hand-shaped row. Reproduce it: have a node process
    // listen and then block its event loop (`while (Date.now() < end);`), open a
    // few connections, and read the listen table. Measured, in order:
    //   blocked, no clients  → LISTEN 0  511 …   (indistinguishable from healthy)
    //   blocked, 5 clients   → LISTEN 5  511 …   (the row below)
    // Every OTHER signal was reassuring throughout: the port stayed bound, the
    // pid stayed alive, and all five TCP connects SUCCEEDED — the kernel
    // completes handshakes on a blocked process's behalf. Recv-Q was the only
    // thing that moved. That is the whole case for parsing it.
    const wedged = parseSsOutput(
      'LISTEN 5      511    127.0.0.1:39111 0.0.0.0:* users:(("node-MainThread",pid=58355,fd=21))',
    );
    expect(wedged).toHaveLength(1);
    expect(wedged[0]).toMatchObject({ port: 39111, pid: 58355, ownerVisible: true });
    expect(wedged[0].acceptQueue).toEqual({ pending: 5, backlog: 511 });
  });

  it('SUMS pending across a SO_REUSEPORT group and keeps the backlog as the per-socket limit', () => {
    // The question is "how many connections are waiting on this port", so a
    // single wedged worker in a healthy cluster must not be averaged away. The
    // backlog is per-socket and identical across the group, so summing THAT
    // would invent a limit the kernel never enforces.
    const cluster = [
      'LISTEN 0      511                      127.0.0.1:3070       0.0.0.0:*    users:(("node-MainThread",pid=1,fd=23))',
      'LISTEN 12     511                      127.0.0.1:3070       0.0.0.0:*    users:(("node-MainThread",pid=2,fd=23))',
      'LISTEN 3      511                      127.0.0.1:3070       0.0.0.0:*    users:(("node-MainThread",pid=3,fd=23))',
    ].join('\n');
    const grouped = parseSsOutput(cluster);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].acceptQueue).toEqual({ pending: 15, backlog: 511 });
  });

  it('does NOT merge two different programs sharing a port', () => {
    // A real port-conflict finding must survive grouping.
    const conflict = [
      'LISTEN 0      511                        0.0.0.0:9999       0.0.0.0:*    users:(("alpha",pid=11,fd=3))',
      'LISTEN 0      511                        0.0.0.0:9999       0.0.0.0:*    users:(("beta",pid=22,fd=3))',
    ].join('\n');
    const rows2 = parseSsOutput(conflict);
    expect(rows2).toHaveLength(2);
    expect(rows2.map((r) => r.command)).toEqual(['alpha', 'beta']);
  });
});

describe('dev:listening_ports contract', () => {
  it('documents the ownerVisible distinction where an agent will read it', () => {
    // The honest-null semantics is the reason this tool exists rather than a
    // one-line ss wrapper. It lives in guidance.returns because the prompt-weight
    // budget counts description + when + notWhen + chaining and NOT returns —
    // so it must stay there, and it must stay non-empty.
    const returns = tool.guidance?.returns ?? '';
    expect(returns).toContain('ownerVisible');
    expect(returns).toMatch(/NOT because the port is free|not the same as nothing/i);
    expect(returns).toContain('no row at all');
  });

  it('offers the three filters the corpus actually asks for', () => {
    // 79% of the sampled atoms want the owner; both directions appear —
    // port->owner (dominant) and pid->ports (`lsof -nP -p "$APPID" …`).
    // `app` is the third direction (EI-21967021435856392): app->URL, where the
    // absence of any lookup cost ~25 tool calls to answer "where is the portal".
    const keys = Object.keys((tool as { args: { shape: Record<string, unknown> } }).args.shape).sort();
    expect(keys).toEqual(['app', 'limit', 'pid', 'port']);
  });

  it('tells the reader how to disambiguate an empty app-filter result', () => {
    // Zero rows for an `app` filter has two causes with different next actions,
    // and the contract is useless if it does not separate them where the agent
    // reads it. Same discipline as ownerVisible, one level up.
    const returns = tool.guidance?.returns ?? '';
    expect(returns).toContain('appFilter');
    expect(returns).toMatch(/known:false/);
    expect(returns).toMatch(/NOTHING IS SERVING IT|registered but/i);
    expect(returns).toContain('registry-unavailable');
  });

  it('routes health questions away to dev:service_health', () => {
    expect(tool.guidance?.notWhen ?? '').toContain('dev:service_health');
  });
});
