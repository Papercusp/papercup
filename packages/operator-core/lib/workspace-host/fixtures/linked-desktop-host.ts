/** Child-process peer for the maintained linked desktop integration suite. */
import SecretStream from '@hyperswarm/secret-stream';
import { HostedWorkspaceConnectorClient } from '../hosted-connector-client';
import { HostedWorkspaceHostSessionAdapter } from '../hosted-session-host';

const machine = SecretStream.keyPair(Buffer.alloc(32, 81));
const browser = SecretStream.keyPair(Buffer.alloc(32, 82));
let adapter: HostedWorkspaceHostSessionAdapter | undefined;
let client: HostedWorkspaceConnectorClient | undefined;
let approved = true;
let count = 0;
let permute = false;
const counters = { pty: 0, start: 0, lookup: 0, roster: 0 };

process.on('message', (message: { type: string; url?: string; count?: number; permute?: boolean; requestId?: string }) => {
  if (message.type === 'revoke') {
    approved = false; process.send?.({ type: 'revoked', counters }); return;
  }
  if (message.type === 'stop') {
    adapter?.close(); client?.stop(); process.disconnect(); return;
  }
  if (message.type === 'inventory' && Number.isSafeInteger(message.count) && message.count! >= 0) {
    count = message.count!;
    process.send?.({ type: 'inventory-updated', count, requestId: message.requestId }); return;
  }
  if (message.type === 'disconnect') {
    adapter?.close(); client?.stop();
    process.send?.({ type: 'disconnected', requestId: message.requestId }); return;
  }
  if (message.type !== 'start' || !message.url || !Number.isInteger(message.count)) return;
  adapter?.close(); client?.stop();
  count = message.count!;
  permute = message.permute === true;
  client = new HostedWorkspaceConnectorClient({ url: message.url, bearer: 'isolated-test-connector',
    onBound: binding => {
      adapter?.close();
      adapter = new HostedWorkspaceHostSessionAdapter({ binding, workspaceRoot: process.cwd(),
        send: frame => { client?.send(frame); },
        byocSealedChannel: { localKeyPair: machine },
        localDesktopAccess: { browserPublicKey: browser.publicKey,
          authorize: async identity => approved && identity.userId === 'test-user' && !identity.control },
        allowedChannelKinds: new Set(['desktop-discovery', 'desktop', 'app-http']),
        createPty: () => { counters.pty++; throw new Error('unexpected_test_pty'); },
        desktop: {
          lookup: async () => { counters.lookup++; return null; },
          dial: async () => { throw new Error('unexpected_test_media_dial'); }, heartbeat: () => {},
          roster: async () => {
            counters.roster++;
            const rows = Array.from({ length: count }, (_, index) => ({
              desktopSessionId: `desktop-${String(index).padStart(4, '0')}`, state: 'ready', scope: 'agent' as const,
              owner: `test-agent-${index}`, name: `PRIVATE_ROSTER_MARKER_${index}`,
            }));
            // Change the provider's order on EVERY read, including retries and
            // continuation pages. Sorting remains the production adapter's job.
            if (permute && rows.length) {
              if (counters.roster % 2) rows.reverse();
              const offset = (counters.roster * 37) % rows.length;
              rows.push(...rows.splice(0, offset));
            }
            process.send?.({ type: 'roster-read', read: counters.roster, count,
              first: rows[0]?.desktopSessionId, last: rows.at(-1)?.desktopSessionId });
            return rows;
          },
          thumbnail: async () => Buffer.from('PRIVATE_THUMBNAIL_MARKER'),
          start: async () => { counters.start++; return null; },
        },
      });
      process.send?.({ type: 'bound', pid: process.pid, machinePublicKey: machine.publicKey.toString('base64') });
    },
    onEnvelope: frame => { void adapter?.accept(frame).catch(error => process.send?.({ type: 'error', message: String(error.message) })); },
  });
  client.start();
});
process.on('SIGTERM', () => { adapter?.close(); client?.stop(); process.exitCode = 0; if (process.connected) process.disconnect(); });
