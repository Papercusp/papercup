import { describe, expect, it, vi } from 'vitest';
import { gcpWorkspaceHostNamePrefixes, resolveGcpWorkspaceHostInstanceIdentity } from './gcp-provider';
import {
  HOSTED_GCP_WORKSPACE_PROJECT_ENV,
  PAPERCUSP_HOSTED_HOST_PERMISSIONS,
  PAPERCUSP_HOSTED_HOST_ROLE_ID,
  PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS,
  PAPERCUSP_HOSTED_OBSERVER_ROLE_ID,
  ensurePapercuspHostingGrant,
  hostedGcpWorkspaceProject,
  papercuspHostingBindings,
  papercuspHostingCondition,
  papercuspHostingGrantEffective,
} from './hosted-gcp-hosting';

const PROJECT = 'papercusp-hosted-workspaces';
const MEMBER = 'serviceAccount:pco-aaaa@papercusp-org-identity.iam.gserviceaccount.com';
const OTHER_MEMBER = 'serviceAccount:pco-bbbb@papercusp-org-identity.iam.gserviceaccount.com';
const HOST_ROLE = `projects/${PROJECT}/roles/${PAPERCUSP_HOSTED_HOST_ROLE_ID}`;
const OBSERVER_ROLE = `projects/${PROJECT}/roles/${PAPERCUSP_HOSTED_OBSERVER_ROLE_ID}`;
const HOST = 'host-0123456789abcdef0123456789abcdef';

/** Evaluate a condition the way GCP does for the one function it uses. */
function allows(expression: string, resourceName: string): boolean {
  const prefixes = [...expression.matchAll(/resource\.name\.startsWith\('([^']+)'\)/g)].map((match) => match[1]!);
  expect(prefixes.length).toBeGreaterThan(0);
  return prefixes.some((prefix) => resourceName.startsWith(prefix));
}

describe("Papercusp-hosted GCP reservation (D-399)", () => {
  it("reaches every resource the provider names for the host, and nothing of another host's", () => {
    const { expression } = papercuspHostingCondition(PROJECT, HOST);
    const { instanceName } = resolveGcpWorkspaceHostInstanceIdentity({
      hostId: HOST,
      target: 'gcp',
      scope: { kind: 'project', id: PROJECT },
      region: 'us-central1',
      zone: 'us-central1-c',
      provider: { projectId: PROJECT },
    } as never);
    const base = instanceName.slice(0, -'-vm'.length);
    const names = gcpWorkspaceHostNamePrefixes(HOST);
    const mine = [
      `projects/${PROJECT}/global/networks/${base}-net`,
      `projects/${PROJECT}/regions/us-central1/subnetworks/${base}-subnet`,
      `projects/${PROJECT}/global/firewalls/${base}-iap`,
      `projects/${PROJECT}/regions/us-central1/routers/${base}-router`,
      `projects/${PROJECT}/zones/us-central1-c/instances/${instanceName}`,
      `projects/${PROJECT}/zones/us-central1-c/disks/${instanceName}`,
      `projects/${PROJECT}/zones/us-central1-c/disks/${base}-data`,
      `projects/${PROJECT}/global/snapshots/${names.snapshot}`,
      `projects/${PROJECT}/global/snapshots/${names.destroySnapshot}-disk-1-0a1b2c3d`,
    ];
    for (const name of mine) expect(allows(expression, name), name).toBe(true);

    const other = gcpWorkspaceHostNamePrefixes('host-fedcba9876543210fedcba9876543210');
    const theirs = [
      `projects/${PROJECT}/zones/us-central1-c/instances/${other.resource}vm`,
      `projects/${PROJECT}/zones/us-central1-c/disks/${other.resource}data`,
      `projects/${PROJECT}/global/networks/${other.resource}net`,
      `projects/${PROJECT}/global/snapshots/${other.snapshot}`,
      // The same host's names in another project, or another zone, are not in the grant either.
      `projects/another-project/zones/us-central1-c/instances/${instanceName}`,
      `projects/${PROJECT}/zones/us-east1-b/instances/${instanceName}`,
    ];
    for (const name of theirs) expect(allows(expression, name), name).toBe(false);
  });

  it('keeps the condition inside GCP limits: at most 12 logical operators', () => {
    const { expression, title } = papercuspHostingCondition(PROJECT, HOST);
    expect(expression.split(' || ').length - 1).toBeLessThanOrEqual(12);
    expect(title.length).toBeLessThanOrEqual(100);
  });

  it('never lets the host role attach a machine identity or touch IAM', () => {
    for (const permission of PAPERCUSP_HOSTED_HOST_PERMISSIONS) {
      expect(permission).not.toMatch(/actAs|setIamPolicy|serviceAccounts|getAccessToken/);
    }
    for (const permission of PAPERCUSP_HOSTED_OBSERVER_PERMISSIONS) {
      expect(permission).toMatch(/\.(get|list|useReadOnly)$/);
    }
  });

  it('adds the observer role and exactly one host reservation, keeping every other binding', () => {
    const existing = [
      { role: 'roles/owner', members: ['user:owner@papercusp.com'] },
      { role: OBSERVER_ROLE, members: [OTHER_MEMBER] },
      { role: HOST_ROLE, members: [OTHER_MEMBER], condition: papercuspHostingCondition(PROJECT, 'host-other') },
    ];
    const next = papercuspHostingBindings(existing, { projectId: PROJECT, member: MEMBER, hostId: HOST })!;
    expect(next).toContainEqual({ role: 'roles/owner', members: ['user:owner@papercusp.com'] });
    expect(next).toContainEqual({ role: OBSERVER_ROLE, members: [OTHER_MEMBER, MEMBER] });
    expect(next).toContainEqual(existing[2]);
    const mine = next.filter((binding) => binding.role === HOST_ROLE && binding.members.includes(MEMBER));
    expect(mine).toEqual([{ role: HOST_ROLE, members: [MEMBER], condition: papercuspHostingCondition(PROJECT, HOST) }]);
    // Already exactly right: nothing to write.
    expect(papercuspHostingBindings(next, { projectId: PROJECT, member: MEMBER, hostId: HOST })).toBeNull();
  });

  it("moves an organization's reservation instead of adding a second one", () => {
    const first = papercuspHostingBindings([], { projectId: PROJECT, member: MEMBER, hostId: 'host-old' })!;
    const moved = papercuspHostingBindings(first, { projectId: PROJECT, member: MEMBER, hostId: HOST })!;
    const mine = moved.filter((binding) => binding.role === HOST_ROLE && binding.members.includes(MEMBER));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.condition!.expression).toBe(papercuspHostingCondition(PROJECT, HOST).expression);
    expect(moved.filter((binding) => binding.role === OBSERVER_ROLE)).toHaveLength(1);
  });

  it('retries a policy write that lost a concurrent etag race, and gives up after five', async () => {
    let writes = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith(':getIamPolicy')) return Response.json({ etag: `e${writes}`, bindings: [] });
      writes += 1;
      const body = JSON.parse(String(init?.body)) as { policy: { version: number; etag: string } };
      expect(body.policy.version).toBe(3);
      expect(body.policy.etag).toBe(`e${writes - 1}`);
      return new Response('conflict', { status: writes < 3 ? 409 : 200 });
    });
    await ensurePapercuspHostingGrant({ projectId: PROJECT, member: MEMBER, hostId: HOST, accessToken: async () => 't', fetch: fetchImpl });
    expect(writes).toBe(3);

    const alwaysConflict = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith(':getIamPolicy') ? Response.json({ bindings: [] }) : new Response('conflict', { status: 409 }),
    );
    await expect(ensurePapercuspHostingGrant({
      projectId: PROJECT, member: MEMBER, hostId: HOST, accessToken: async () => 't', fetch: alwaysConflict,
    })).rejects.toThrow('policy_contended');
  });

  it('does not write a policy that already holds the reservation', async () => {
    const bindings = papercuspHostingBindings([], { projectId: PROJECT, member: MEMBER, hostId: HOST })!;
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ etag: 'e', bindings }));
    await ensurePapercuspHostingGrant({ projectId: PROJECT, member: MEMBER, hostId: HOST, accessToken: async () => 't', fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, true],
    [200, true],
    [403, false],
  ])('reads the reserved instance to tell whether the grant is in force (%i -> %s)', async (status, effective) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status }));
    await expect(papercuspHostingGrantEffective({ projectId: PROJECT, hostId: HOST, accessToken: 't', fetch: fetchImpl }))
      .resolves.toBe(effective);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(`/instances/${gcpWorkspaceHostNamePrefixes(HOST).resource}vm`);
  });

  it('fails instead of guessing on any other answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 500 }));
    await expect(papercuspHostingGrantEffective({ projectId: PROJECT, hostId: HOST, accessToken: 't', fetch: fetchImpl }))
      .rejects.toThrow('probe_failed:500');
  });

  it('needs an explicit, well-formed hosting project', () => {
    expect(() => hostedGcpWorkspaceProject({})).toThrow('unconfigured');
    expect(() => hostedGcpWorkspaceProject({ [HOSTED_GCP_WORKSPACE_PROJECT_ENV]: 'Bad_Project' })).toThrow('invalid');
    expect(hostedGcpWorkspaceProject({ [HOSTED_GCP_WORKSPACE_PROJECT_ENV]: PROJECT })).toBe(PROJECT);
  });
});
