import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_IN_FLIGHT } from './proxy';

const service = readFileSync(
  new URL('../../scripts/systemd/papercup-mcp-proxy.service', import.meta.url),
  'utf8',
);

function serviceEnvNumber(name: string): number {
  const match = service.match(new RegExp(`^Environment=${name}=(\\d+)$`, 'm'));
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
