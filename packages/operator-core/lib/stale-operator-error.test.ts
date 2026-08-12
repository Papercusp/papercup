import { describe, expect, it } from 'vitest';
import {
  diagnoseStaleOperatorModuleLink,
  isStaleOperatorModuleLinkError,
  STALE_OPERATOR_MODULE_LINK_CODE,
} from './stale-operator-error';

describe('stale operator module-link diagnosis', () => {
  it('recognizes a changed named export and gives a restart action', () => {
    const diagnosis = diagnoseStaleOperatorModuleLink(
      'agentDetail.byOwner',
      new Error("The requested module '@papercusp/orchestrator/codex-gateway-config' does not provide an export named 'codexManagedFeaturesToml'"),
    );
    expect(diagnosis).toMatchObject({
      code: STALE_OPERATOR_MODULE_LINK_CODE,
      staleOperator: true,
    });
    expect(diagnosis?.message).toContain('agentDetail.byOwner');
    expect(diagnosis?.message).toContain('Restart the operator process');
    expect(diagnosis?.originalMessage).toContain('codexManagedFeaturesToml');
  });

  it('recognizes loader error codes from missing or stale module graphs', () => {
    expect(isStaleOperatorModuleLinkError(new Error('Error [ERR_MODULE_NOT_FOUND]: Cannot find package x'))).toBe(true);
    expect(isStaleOperatorModuleLinkError('Cannot find module ./changed-export.js')).toBe(true);
  });

  it('does not relabel an ordinary resolver failure as stale code', () => {
    expect(diagnoseStaleOperatorModuleLink('plans.list', new Error('database connection refused'))).toBeNull();
  });
});
