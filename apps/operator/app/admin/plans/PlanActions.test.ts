// PlanActions — the plan-level write dialogs (Set Now / Add Decision / Add Item
// / Promote / Reject, 1099 lines). The dialog UIs are an e2e surface, but four
// pure helpers carry real logic and are extracted + exported: writeError (write
// result → inline error, incl. the lock-conflict holder), parseRefList (P-/D-
// ref parsing), and previewNextDecisionId / previewNextItemId (next-free id).
// Those are tested here. The module's side-effectful top-level imports (Modal,
// launch-agent, sonner) are stubbed so importing the helpers stays hermetic.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/harness/Modal', () => ({ Modal: () => null }));
vi.mock('@papercusp/operator-core/lib/launch-agent', () => ({ launchAgent: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  writeError,
  parseRefList,
  previewNextDecisionId,
  previewNextItemId,
} from './PlanActions';
import type { WriteResult } from './plans-api';
import type { PlanDecision, PlanItem } from './plans-api';

describe('writeError', () => {
  it('returns null for a successful write', () => {
    expect(writeError({ ok: true } as WriteResult)).toBeNull();
  });

  it('returns the raw error code for a plain failure', () => {
    expect(writeError({ error: 'not_found' })).toBe('not_found');
  });

  it('surfaces the holder + intent for a busy lock-conflict', () => {
    expect(
      writeError({ error: 'busy', busy: [{ owner_label: 'Queen', intent: 'planning' }] }),
    ).toBe('busy: held by Queen (planning)');
  });

  it('omits the intent parenthetical when there is no intent', () => {
    expect(writeError({ error: 'busy', busy: [{ owner_label: 'Worker' }] })).toBe(
      'busy: held by Worker',
    );
  });

  it('defaults the holder label when busy carries no owner', () => {
    expect(writeError({ error: 'busy', busy: [{}] })).toBe('busy: held by another agent');
  });

  it('reports an unexpected-shape message for non-object / shapeless input', () => {
    expect(writeError(null as unknown as WriteResult)).toBe('unexpected response shape');
    expect(writeError({} as WriteResult)).toBe('unexpected response shape');
  });
});

describe('parseRefList', () => {
  it('splits on whitespace and commas, keeping only well-formed P-/D- refs', () => {
    expect(parseRefList('P-001, D-012  P-100')).toEqual(['P-001', 'D-012', 'P-100']);
  });

  it('drops malformed tokens (too few digits, lowercase, junk)', () => {
    expect(parseRefList('P-1, x-001, foo, D-099')).toEqual(['D-099']);
  });

  it('returns an empty array for blank input', () => {
    expect(parseRefList('   ')).toEqual([]);
  });
});

function decision(id: string): PlanDecision {
  return { id };
}
function item(id: string): PlanItem {
  return { id, text: '', storedStatus: 'todo', effectiveStatus: 'todo' } as PlanItem;
}

describe('previewNextDecisionId', () => {
  it('returns D-001 when there are no decisions', () => {
    expect(previewNextDecisionId(undefined)).toBe('D-001');
    expect(previewNextDecisionId([])).toBe('D-001');
  });
  it('returns max(existing) + 1, zero-padded', () => {
    expect(previewNextDecisionId([decision('D-001'), decision('D-007'), decision('D-003')])).toBe('D-008');
  });
  it('keeps 3-digit padding past 99', () => {
    expect(previewNextDecisionId([decision('D-099')])).toBe('D-100');
  });
});

describe('previewNextItemId', () => {
  it('returns P-001 when there are no items', () => {
    expect(previewNextItemId([])).toBe('P-001');
  });
  it('returns max(existing) + 1, zero-padded', () => {
    expect(previewNextItemId([item('P-004'), item('P-011'), item('P-002')])).toBe('P-012');
  });
});
