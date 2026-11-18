/** A separate installed process using the real persisted relay and desktop runtime.
 * Only the loopback broker and inventory are fixtures; authority is never mocked. */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { defaultPortalRelayDeps, approvePortalRelayDesktop, revokePortalRelayDesktop } from '../relay-opt-in';
import { currentPortalRelayDesktopGrant, readPortalRelay } from '../portal-relay-store';
import { portalRelayConnectorStatus, startPortalRelayConnector, stopPortalRelayConnector } from '../portal-relay-runtime';
import { loadOrCreateHostedMachineNoiseKeyPair } from '../../workspace-host/hosted-machine-noise-key';

const workspaceRoot = process.env.PAPERCUSP_INSTALLED_INTEGRATION_ROOT!;
const deps = defaultPortalRelayDeps({ env: { PAPERCUSP_HOME: workspaceRoot }, isConnectorOwner: () => true, notifyChanged: () => {},
  localWorkspaceExists: async id => {
    if (id !== 'installed-integration-workspace') return false;
    await access(join(workspaceRoot, id)); return true;
  } });
let queue = Promise.resolve();
process.on('message', (message: { type: string; requestId: string; url?: string; approval?: Parameters<typeof approvePortalRelayDesktop>[0] }) => {
  queue = queue.then(async () => {
    if (message.type === 'stop') {
      stopPortalRelayConnector('fixture_stop');
      await getOrgPg().sql.end();
      process.send?.({ requestId: message.requestId, type: 'stopped' });
      process.disconnect(); return;
    }
    if (message.type === 'approve') await approvePortalRelayDesktop(message.approval!, deps);
    else if (message.type === 'revoke') await revokePortalRelayDesktop(deps);
    else if (message.type === 'start') {
      const row = await readPortalRelay();
      await startPortalRelayConnector({ url: message.url!, bearer: 'private-integration-connector',
        workspaceRoot, desktopGrant: currentPortalRelayDesktopGrant(row) });
      const until = Date.now() + 10_000;
      while (!portalRelayConnectorStatus().bound) {
        if (Date.now() >= until) throw new Error('installed_connector_binding_deadline');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const row = await readPortalRelay();
    const machine = await loadOrCreateHostedMachineNoiseKeyPair();
    process.send?.({ requestId: message.requestId, type: 'result', pid: process.pid,
      installId: row?.installId, grant: currentPortalRelayDesktopGrant(row),
      machinePublicKey: machine.publicKey.toString('base64'), connector: portalRelayConnectorStatus() });
  }).catch(error => { process.send?.({ requestId: message.requestId, type: 'error', code: error.code, message: error.message }); });
});
process.on('disconnect', () => { stopPortalRelayConnector('fixture_disconnected'); process.exit(0); });
process.send?.({ type: 'ready', pid: process.pid });
