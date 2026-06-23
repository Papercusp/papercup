/**
 * fleet-assignment-bus.test.ts — pins parseFleetAssignmentPayload, the best-effort
 * decoder for the `NOTIFY fleet_assignment` payload `"<workspace_id>::<source>::<agent_id>"`
 * (state-not-chat-fleet-state-2026-06-05 D-003/P-006). Untested before this.
 *
 * Only the PURE parser is exercised — importing the module opens no PG connection
 * (the single LISTEN is lazily started inside ensureStarted, never at import or in
 * the parser), so this is a safe unit target.
 *
 * The load-bearing property: the agent id is `rest.join("::")`, NOT `split("::")[2]`.
 * Owner ids / agent names can themselves contain `::`; a naive index-2 read would
 * TRUNCATE them and misroute change-awareness. Plus the parser is best-effort — a
 * malformed/empty payload must yield empty fields, never throw (the notify callback
 * fans this straight out to handlers).
 */
import { describe, expect, it } from 'vitest';
import { parseFleetAssignmentPayload } from './fleet-assignment-bus';

describe('parseFleetAssignmentPayload', () => {
  it('parses the canonical three-part payload', () => {
    expect(parseFleetAssignmentPayload('ws-1::presence::bee-7')).toEqual({
      workspaceId: 'ws-1',
      source: 'presence',
      agentId: 'bee-7',
    });
  });

  it('REASSEMBLES an agent id that itself contains "::" (rest.join, not split[2])', () => {
    expect(parseFleetAssignmentPayload('ws-1::plan_item_claim::team::queen::n3')).toEqual({
      workspaceId: 'ws-1',
      source: 'plan_item_claim',
      agentId: 'team::queen::n3',
    });
  });

  it('treats undefined payload as all-empty (best-effort, no throw)', () => {
    expect(parseFleetAssignmentPayload(undefined)).toEqual({ workspaceId: '', source: '', agentId: '' });
  });

  it('treats an empty string as all-empty', () => {
    expect(parseFleetAssignmentPayload('')).toEqual({ workspaceId: '', source: '', agentId: '' });
  });

  it('fills missing trailing parts with empty strings', () => {
    expect(parseFleetAssignmentPayload('ws-only')).toEqual({
      workspaceId: 'ws-only',
      source: '',
      agentId: '',
    });
    expect(parseFleetAssignmentPayload('ws::source')).toEqual({
      workspaceId: 'ws',
      source: 'source',
      agentId: '',
    });
  });

  it('a trailing "::" yields an empty agent id (present-but-empty, not missing)', () => {
    expect(parseFleetAssignmentPayload('ws::source::')).toEqual({
      workspaceId: 'ws',
      source: 'source',
      agentId: '',
    });
  });

  it('a leading "::" keeps workspaceId empty without shifting the other fields', () => {
    // split yields ['', 'source', 'agent']; the `= ""` default only applies to a
    // MISSING element, so an explicit empty first segment stays '' and source/agent
    // are not shifted left.
    expect(parseFleetAssignmentPayload('::source::agent')).toEqual({
      workspaceId: '',
      source: 'source',
      agentId: 'agent',
    });
  });

  it('does not trim surrounding whitespace (ids are taken verbatim)', () => {
    expect(parseFleetAssignmentPayload('ws ::a:: b ')).toEqual({
      workspaceId: 'ws ',
      source: 'a',
      agentId: ' b ',
    });
  });
});
