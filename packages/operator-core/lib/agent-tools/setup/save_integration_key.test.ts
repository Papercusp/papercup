import { describe, expect, it } from 'vitest';

import {
  INTEGRATION_KEY_NAME_MAX_LENGTH,
  INTEGRATION_KEY_VALUE_MAX_LENGTH,
  saveIntegrationKeyArgsSchema,
} from './save_integration_key';

const CANONICAL_WORKSPACE_HOST_KEY =
  'WORKSPACE_HOST_MATERIAL__GIT_SHORT_LIVED_DELEGATION__GITHUB__PAPERCUPAI__PAPERCUSP_BYOC_CANARY__G1__01DB9EAF2E672726';

describe('setup:save_integration_key arguments', () => {
  it('accepts a canonical injective workspace-host material key', () => {
    expect(CANONICAL_WORKSPACE_HOST_KEY).toHaveLength(116);
    expect(
      saveIntegrationKeyArgsSchema.parse({
        name: CANONICAL_WORKSPACE_HOST_KEY,
        value: 'secret-material',
      }),
    ).toEqual({
      name: CANONICAL_WORKSPACE_HOST_KEY,
      value: 'secret-material',
    });
  });

  it('remains bounded and rejects malformed integration-key names', () => {
    const maximum = `A${'_'.repeat(INTEGRATION_KEY_NAME_MAX_LENGTH - 1)}`;
    expect(saveIntegrationKeyArgsSchema.safeParse({ name: maximum, value: 'secret-material' }).success).toBe(true);
    expect(saveIntegrationKeyArgsSchema.safeParse({ name: `${maximum}_`, value: 'secret-material' }).success).toBe(
      false,
    );
    expect(saveIntegrationKeyArgsSchema.safeParse({ name: 'lower_case', value: 'secret-material' }).success).toBe(
      false,
    );
  });

  it('accepts the measured sealed agent-home bundle size while keeping values bounded', () => {
    const measuredBundle = 'x'.repeat(6_271);
    expect(
      saveIntegrationKeyArgsSchema.safeParse({
        name: CANONICAL_WORKSPACE_HOST_KEY,
        value: measuredBundle,
      }).success,
    ).toBe(true);
    expect(
      saveIntegrationKeyArgsSchema.safeParse({
        name: CANONICAL_WORKSPACE_HOST_KEY,
        value: 'x'.repeat(INTEGRATION_KEY_VALUE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});
