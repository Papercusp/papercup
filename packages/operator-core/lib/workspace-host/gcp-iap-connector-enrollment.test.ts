import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV,
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_CONDUIT,
  WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION,
} from '@papercusp/deployment-driver';
import {
  buildGcpIapWorkspaceHostConnectorEnrollmentCommand,
  enrollGcpIapWorkspaceHostConnector,
  GcpIapWorkspaceHostConnectorEnrollmentError,
  parseGcpIapWorkspaceHostConnectorEnrollmentReceipt,
} from './gcp-iap-connector-enrollment';
import type {
  GcpIapWorkspaceHostInitializationCommand,
  GcpIapWorkspaceHostTransportProfile,
} from './gcp-iap-initialization-operations';

const TICKET = `ht_${'Z'.repeat(43)}`;

const PROFILE: GcpIapWorkspaceHostTransportProfile = {
  projectId: 'papercusp-hosted-workspaces',
  zone: 'us-central1-c',
  instanceName: 'pc-host-2f6a4b0c6dc222d8d20766ae-b3f5eaee-vm',
  instanceId: '8154755795487952084',
  sshUser: 'papercusp',
  knownHostsFile: '/var/lib/papercusp/known_hosts',
  identityFile: '/var/lib/papercusp/controller/id_ed25519',
};

const RECEIPT = `{"protocolVersion":"${WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION}","generation":2,"registered":true}\n`;

describe('connector enrollment over GCP IAP (D-403)', () => {
  it('runs the fixed conduit argv and carries the ticket only on stdin', () => {
    const command = buildGcpIapWorkspaceHostConnectorEnrollmentCommand(PROFILE, TICKET);
    expect(command.stdin).toBe(`${TICKET}\n`);
    expect(command.args.join(' ')).not.toContain(TICKET);
    expect(command.args.at(-1)).toBe(
      [WORKSPACE_HOST_CONNECTOR_ENROLLMENT_CONDUIT, ...WORKSPACE_HOST_CONNECTOR_ENROLLMENT_ARGV]
        .map((token) => `'${token}'`)
        .join(' '),
    );
  });

  it('refuses a malformed ticket before opening a connection', () => {
    for (const bad of [`hc_${'Z'.repeat(43)}`, `${TICKET}\nsecond`, 'ht_short']) {
      expect(() => buildGcpIapWorkspaceHostConnectorEnrollmentCommand(PROFILE, bad)).toThrow(
        GcpIapWorkspaceHostConnectorEnrollmentError,
      );
    }
  });

  it('keeps only the named receipt fields, whatever else the host prints', () => {
    const noisy = `warming up\n{"protocolVersion":"${WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION}","generation":2,"registered":true,"bearer":"hc_x"}\n`;
    expect(parseGcpIapWorkspaceHostConnectorEnrollmentReceipt(noisy)).toEqual({
      protocolVersion: WORKSPACE_HOST_CONNECTOR_ENROLLMENT_PROTOCOL_VERSION,
      generation: 2,
      registered: true,
    });
    for (const bad of ['', 'not json', '{"protocolVersion":"other","generation":2,"registered":true}', RECEIPT.replace('2', '0')]) {
      expect(() => parseGcpIapWorkspaceHostConnectorEnrollmentReceipt(bad)).toThrow(
        GcpIapWorkspaceHostConnectorEnrollmentError,
      );
    }
  });

  it('surfaces the host program exit code and diagnostic on failure', async () => {
    const runner = {
      run: async (_command: GcpIapWorkspaceHostInitializationCommand) => ({
        exitCode: 77,
        stdout: '',
        stderr: 'connector enrollment: https://app.papercusp.com refused the ticket (HTTP 401)\n',
      }),
    };
    const failure = await enrollGcpIapWorkspaceHostConnector(PROFILE, TICKET, runner).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GcpIapWorkspaceHostConnectorEnrollmentError);
    expect((failure as GcpIapWorkspaceHostConnectorEnrollmentError).exitCode).toBe(77);
    expect((failure as Error).message).toContain('HTTP 401');
  });

  it('returns the parsed receipt on success', async () => {
    const runner = { run: async () => ({ exitCode: 0, stdout: RECEIPT, stderr: '' }) };
    await expect(enrollGcpIapWorkspaceHostConnector(PROFILE, TICKET, runner)).resolves.toMatchObject({ generation: 2 });
  });
});
