import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
  ensureBootstrap, getTxPool, registerResource, readResourceCoordinationDomainKinds,
  stampResourceCoordinationDomainKind, _resetForTests,
} from '../su-lock-store';
import { inWorkspaceTxn } from '../in-workspace-txn';
import { hostGlobalLockDomain } from '../coordination-domain';
import {
  __resetResourceDomainKindsForTest, declaredResourceDomainKind, ensureResourceDomainKindsFresh,
} from '../resource-domain-kinds';
import registerTool from '../register_resource';

// These names identify real host resources. Only the maintained disposable
// runtime may exercise their registry publication; a private lock domain alone
// does not isolate them from cross-domain discovery in the production DB.
// The hermetic test setup deliberately removes the runtime workspace pin.
// Keep its maintained private HOME boundary and verify the actual server below.
const isolated = Boolean(process.env.HOME?.includes('papercusp-test-runtime-') &&
  process.env.HARNESS_ADMIN_DATABASE_URL);
const owner = 'registration-domain-test';

describe.skipIf(!isolated)('maintained host-resource domain publication in isolated PG', () => {
  beforeAll(async () => {
    const pin = new URL(process.env.HARNESS_ADMIN_DATABASE_URL!);
    expect(['localhost', '127.0.0.1']).toContain(pin.hostname);
    expect(Number(pin.port)).toBeGreaterThan(0);
    expect(Number(pin.port)).not.toBe(5432);
    const privateServer = postgres(process.env.HARNESS_ADMIN_DATABASE_URL!, { max: 1 });
    try {
      const [actual] = await privateServer`SHOW data_directory`;
      expect(actual.data_directory).toMatch(/\/papercusp-test-pg-[^/]+$/);
    } finally {
      await privateServer.end();
    }
    await ensureBootstrap();
    const [actual] = await getTxPool()`SELECT inet_server_port() AS port`;
    expect(Number(actual.port)).toBe(Number(pin.port));
  });

  afterAll(async () => {
    __resetResourceDomainKindsForTest();
    await _resetForTests();
  });

  it.each(['staging-server', 'staging-server-cooldown'])(
    'publishes %s for an existing row and refreshes a reader without overwriting policy', async resource => {
      const original = await inWorkspaceTxn(hostGlobalLockDomain(), owner, async tx => {
        const registered = await registerResource(tx, { resource, description: 'Private retained policy',
          rule_text: 'Private existing policy', enforcement: 'enforced', max_holders: 3 });
        // Emulate an older install whose registry row is still undeclared.
        await stampResourceCoordinationDomainKind(tx, resource, 'tree');
        return registered.resource;
      });
      __resetResourceDomainKindsForTest();
      await ensureResourceDomainKindsFresh();
      expect(declaredResourceDomainKind(resource)).toBeNull();

      const result = await registerTool.handler({ resource }, {
        isSuperuser: true, uiClientId: owner,
      } as never);
      if (!('content' in result)) throw new Error('Registration did not return its measured result');
      const content = result.content[0];
      if (content.type !== 'text') throw new Error('Registration did not return text evidence');
      const body = JSON.parse(content.text);
      expect(body).toMatchObject({ ok: true, created: false, resource: original });
      expect((await readResourceCoordinationDomainKinds(getTxPool())).get(resource)).toBe('host-global');

      // The legacy reader consumes the registry declaration, independently of
      // the newer hardcoded host-resource set.
      __resetResourceDomainKindsForTest();
      await ensureResourceDomainKindsFresh();
      expect(declaredResourceDomainKind(resource)).toBe('host-global');
    });
});
