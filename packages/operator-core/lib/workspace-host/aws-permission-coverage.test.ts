/**
 * Every AWS API the workspace-host client and the hosted stack discovery call AS THE CUSTOMER
 * ROLE must be granted by the role the customer creates (aws-byoc-gcp-parity D-009). Measured
 * 2026-10-02: five calls (DescribeSecurityGroups, GetConsoleOutput, GetAWSDefaultServiceQuota,
 * GetProducts, SimulatePrincipalPolicy) were made but not granted, so they would have failed
 * with AccessDenied only on a real account. This reads the SDK commands each module imports and
 * sends, and fails when one is missing from AWS_WORKSPACE_HOST_PERMISSION_ACTIONS.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AWS_WORKSPACE_HOST_PERMISSION_ACTIONS } from './aws-connection';

/** IAM action prefix for each SDK client package. */
const SERVICE_PREFIX: Record<string, string> = {
  ec2: 'ec2',
  iam: 'iam',
  kms: 'kms',
  pricing: 'pricing',
  'service-quotas': 'servicequotas',
  ssm: 'ssm',
  sts: 'sts',
};
/** Calls that need no IAM permission at all. */
const NO_PERMISSION_NEEDED = new Set(['sts:GetCallerIdentity']);

const MODULES = ['./aws-sdk-client.ts', './hosted-aws-host-discovery.ts'];

function requiredAwsActions(source: string): string[] {
  const serviceOf = new Map<string, string>();
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@aws-sdk\/client-([a-z0-9-]+)'/g)) {
    const prefix = SERVICE_PREFIX[match[2]!];
    if (!prefix) throw new Error(`unmapped SDK client @aws-sdk/client-${match[2]}`);
    for (const name of match[1]!.split(',').map((part) => part.trim().replace(/^type\s+/, ''))) {
      if (name.endsWith('Command')) serviceOf.set(name, prefix);
    }
  }
  const actions = new Set<string>();
  for (const match of source.matchAll(/new\s+([A-Za-z]+Command)\s*\(/g)) {
    const prefix = serviceOf.get(match[1]!);
    if (!prefix) throw new Error(`command ${match[1]} is not imported from a mapped SDK client`);
    const action = `${prefix}:${match[1]!.slice(0, -'Command'.length)}`;
    if (!NO_PERMISSION_NEEDED.has(action)) actions.add(action);
  }
  return [...actions].sort();
}

describe('AWS workspace-host permission coverage (D-009)', () => {
  it.each(MODULES)('grants every AWS call %s makes as the customer role', (module) => {
    const source = readFileSync(fileURLToPath(new URL(module, import.meta.url)), 'utf8');
    const required = requiredAwsActions(source);
    // A positive control: the scan must actually find calls, or a broken regex passes vacuously.
    expect(required.length).toBeGreaterThan(3);
    const granted = new Set<string>(AWS_WORKSPACE_HOST_PERMISSION_ACTIONS);
    expect(required.filter((action) => !granted.has(action))).toEqual([]);
  });

  it('catches a call that the role does not grant', () => {
    const source = [
      "import { DescribeVpcsCommand, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';",
      "import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';",
      'await ec2.send(new DescribeVpcsCommand({}));',
      'await ec2.send(new DescribeSubnetsCommand({}));',
      'await sts.send(new GetCallerIdentityCommand({}));',
    ].join('\n');
    const required = requiredAwsActions(source);
    expect(required).toEqual(['ec2:DescribeSubnets', 'ec2:DescribeVpcs']);
    const granted = new Set<string>(AWS_WORKSPACE_HOST_PERMISSION_ACTIONS);
    expect(required.filter((action) => !granted.has(action))).toEqual(['ec2:DescribeVpcs']);
  });
});
