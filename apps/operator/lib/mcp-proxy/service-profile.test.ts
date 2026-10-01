import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_IN_FLIGHT } from './proxy';

const service = readFileSync(
  new URL('../../scripts/systemd/papercup-mcp-proxy.service', import.meta.url),
  'utf8',
);
const stagingService = readFileSync(
  new URL('../../scripts/systemd/papercup-mcp-proxy-staging.service', import.meta.url),
  'utf8',
);
const stagingHost = readFileSync(
  new URL('../../scripts/systemd/papercup-staging-api.service.d/95-bundled-entry.conf', import.meta.url),
  'utf8',
);

function serviceEnvNumber(name: string, source = service): number {
  const match = source.match(new RegExp(`^Environment=${name}=(\\d+)$`, 'm'));
  return Number(match?.[1] ?? Number.NaN);
}

describe('papercup-mcp-proxy production admission profile', () => {
  it('EI-21524993137902308: preserves a full 30-member reconnect lane inside the hard cap', () => {
    const reserve = serviceEnvNumber('PAPERCUSP_MCP_PROXY_CONTROL_PLANE_RESERVE');
    const handshakes = serviceEnvNumber('PAPERCUSP_MCP_PROXY_MAX_HANDSHAKES_IN_FLIGHT');

    expect(reserve).toBeGreaterThanOrEqual(64);
    expect(handshakes).toBeGreaterThanOrEqual(30);
    expect(handshakes).toBeLessThanOrEqual(reserve);
    expect(reserve).toBeLessThan(DEFAULT_MAX_IN_FLIGHT);
  });
});

describe('papercup-mcp-proxy staging restart profile', () => {
  it('EI-24735123650974198: keeps same-build proxy and caller budgets above the observed 90s outage', () => {
    const proxyRetryMs = serviceEnvNumber('PAPERCUSP_MCP_PROXY_RETRY_MS', stagingService);
    const callerRetryMs = serviceEnvNumber('PAPERCUSP_MCP_PROXY_RETRY_MS', stagingHost);

    expect(proxyRetryMs).toBe(300_000);
    expect(callerRetryMs).toBe(proxyRetryMs);
    expect(stagingService).toMatch(/^Environment=PAPERCUSP_MCP_PROXY_PORT=9171$/m);
    expect(stagingService).toMatch(/^Environment=PAPERCUSP_MCP_PROXY_TARGET_PORT=3170$/m);
  });
});
