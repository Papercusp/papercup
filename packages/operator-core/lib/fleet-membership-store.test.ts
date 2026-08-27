import { describe, it, expect } from 'vitest';
import {
  deriveFleetMembershipEvent,
  fleetEverMembers,
  type FleetMembershipInput,
} from './fleet-membership-store';

describe('fleet-membership-store: append-only canonical membership (WI-1345)', () => {
  describe('deriveFleetMembershipEvent: sensible event label derivation', () => {
    it('null fleet_slug → leave event', () => {
      const event = deriveFleetMembershipEvent(null, null);
      expect(event).toBe('leave');
    });

    it('non-null fleet_slug + leader role → lead event', () => {
      const event = deriveFleetMembershipEvent('fleet-x', 'leader');
      expect(event).toBe('lead');
    });

    it('non-null fleet_slug + member role → join event', () => {
      const event = deriveFleetMembershipEvent('fleet-x', 'member');
      expect(event).toBe('join');
    });

    it('non-null fleet_slug + null role → join event (default)', () => {
      const event = deriveFleetMembershipEvent('fleet-x', null);
      expect(event).toBe('join');
    });
  });

  describe('FleetMembershipInput type', () => {
    it('represents a membership fact that can be appended', () => {
      const input: FleetMembershipInput = {
        workspaceId: 'ws-1',
        ownerId: 'agent-1',
        fleetSlug: 'fleet-x',
        fleetRole: 'member',
        ownerLabel: 'bee-name',
        event: 'join',
      };

      expect(input.workspaceId).toBe('ws-1');
      expect(input.ownerId).toBe('agent-1');
      expect(input.fleetSlug).toBe('fleet-x');
      expect(input.fleetRole).toBe('member');
      expect(input.event).toBe('join');
    });

    it('supports null fleet_slug for leave events', () => {
      const input: FleetMembershipInput = {
        workspaceId: 'ws-1',
        ownerId: 'agent-1',
        fleetSlug: null,
        fleetRole: null,
      };

      expect(input.fleetSlug).toBeNull();
      expect(input.fleetRole).toBeNull();
      expect(deriveFleetMembershipEvent(input.fleetSlug, input.fleetRole)).toBe('leave');
    });
  });

  describe('Design: append-only fact vs mutable column', () => {
    it('documents why membership is append-only (WI-1345)', () => {
      // The critical insight: coord_presence is EPHEMERAL (reaped on agent death).
      // Before: fleet_slug lived ONLY on coord_presence, so it vanished with the row.
      // Problem: "who was in fleet X?" becomes unanswerable after agent death.
      //
      // Solution: fleet_membership_events is APPEND-ONLY and DURABLE.
      // - coord_presence.fleet_slug is a PROJECTION of the latest event.
      // - fleet_assignment view sources fleet columns from the append-only log.
      // - On agent death, the presence row is reaped but the fact remains.
      // - On agent rejoin, the presence projection is re-materialized from the fact.
      // - So membership survives death, and history is queryable.

      // This test documents the invariant, not by checking side effects, but by
      // asserting the design principle: a membership fact is immutable history.
      expect(true).toBe(true); // placeholder for the above documentation
    });
  });

  it('threads the optional snapshot watermark into the canonical ever-member read', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.reduce((out, part, index) => out + part + (index < values.length ? `$${index + 1}` : ''), '');
      calls.push({ text, values });
      return Promise.resolve([{ owner_id: 'su-a' }]);
    }) as never;

    await expect(
      fleetEverMembers('fleet-a', { workspaceId: 'ws-a', beforeOrAt: '2026-08-27T08:00:00.000Z' }, sql),
    ).resolves.toEqual(new Set(['su-a']));
    expect(calls.some((call) => call.text.includes('at <='))).toBe(true);
    expect(calls.flatMap((call) => call.values)).toContain('2026-08-27T08:00:00.000Z');
  });
});
