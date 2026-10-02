/**
 * Pins the public Cloud workspaces page (apps/papercusp-docs) to the code it describes
 * (plan aws-byoc-gcp-parity-2026-10-01, P-013 / D-011). The page explains permissions by service and
 * names template outputs; both are code-describing claims that drift silently when the code moves,
 * so each is checked in BOTH directions here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AWS_WORKSPACE_HOST_PERMISSION_ACTIONS } from '../workspace-host/aws-connection';
import {
  AWS_CUSTOMER_SETUP_CONNECTION_FIELDS,
  awsCustomerSetupTemplate,
} from '../workspace-host/aws-customer-setup-template';

const REPO = new URL('../../../../', import.meta.url);
const PAGE = readFileSync(new URL('apps/papercusp-docs/src/content/docs/cloud-workspaces.mdx', REPO), 'utf8');

/** Rows of the markdown table whose header row contains `header`. */
function tableRows(header: string): string[][] {
  const lines = PAGE.split('\n').map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith('|') && line.includes(header));
  expect(start, `table with header "${header}"`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    rows.push(line.split('|').slice(1, -1).map((cell) => cell.trim()));
  }
  return rows;
}

describe('Cloud workspaces docs page ↔ code', () => {
  it('names every AWS service the least-privilege policy uses, and no service it does not', () => {
    const codePrefixes = new Set(AWS_WORKSPACE_HOST_PERMISSION_ACTIONS.map((action) => action.split(':')[0]));
    const pagePrefixes = new Set(
      tableRows('Action prefix').map((row) => /^`([a-z0-9]+):`$/.exec(row[1] ?? '')?.[1] ?? `unparsed:${row[1]}`),
    );
    expect([...pagePrefixes].sort()).toEqual([...codePrefixes].sort());
  });

  it('names exactly the setup template outputs the desktop connection form takes', () => {
    const pageOutputs = tableRows('Stack output').map((row) => /^`([A-Za-z]+)`$/.exec(row[0] ?? '')?.[1] ?? row[0]);
    expect([...pageOutputs].sort()).toEqual(Object.keys(AWS_CUSTOMER_SETUP_CONNECTION_FIELDS).sort());
    const outputs = awsCustomerSetupTemplate({ accountId: '123456789012', region: 'us-east-1' }).document
      .Outputs as Record<string, unknown>;
    for (const name of pageOutputs) expect(outputs, `template Output ${name}`).toHaveProperty(name);
  });

  it('names the GCP custom role the hosted template actually creates', () => {
    const delegation = readFileSync(
      new URL('packages/operator-core/lib/workspace-host/hosted-provider-delegation.ts', REPO),
      'utf8',
    );
    const title = /title: '([^']+)'/.exec(delegation.slice(delegation.indexOf('const customRole')))?.[1];
    expect(title).toBeTruthy();
    expect(PAGE).toContain(`**${title}**`);
  });

  it('is reachable from the docs sidebar', () => {
    const config = readFileSync(new URL('apps/papercusp-docs/astro.config.mjs', REPO), 'utf8');
    expect(config).toContain("'cloud-workspaces'");
  });
});
