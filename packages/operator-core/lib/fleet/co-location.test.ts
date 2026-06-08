/**
 * co-location.test.ts — the Queen's placement policy (hive-coordination-model P-002).
 *
 * Pure decision: co-locate tight collaborators on one Swarm; spread loose ones; default
 * to local when there is no signal or only one Swarm. No PG, no clock.
 */
import { describe, it, expect } from 'vitest';
import { decideCoLocation, type SwarmSlot } from './co-location';

const slot = (swarm: string, load = 0): SwarmSlot => ({ swarm, load });

describe('decideCoLocation', () => {
  it('single-Swarm roster ⇒ everything co-located locally (affinity moot)', () => {
    const d = decideCoLocation({
      collaboratorSwarms: ['local'],
      roster: [slot('local')],
      localSwarm: 'local',
    });
    expect(d.action).toBe('local');
    expect(d.swarm).toBe('local');
  });

  it('empty roster degrades to local', () => {
    const d = decideCoLocation({ collaboratorSwarms: [], roster: [], localSwarm: 'local' });
    expect(d.action).toBe('local');
    expect(d.swarm).toBe('local');
  });

  it('tight + a collaborator on Swarm B ⇒ co-locate on B', () => {
    const d = decideCoLocation({
      collaboratorSwarms: ['B'],
      roster: [slot('local'), slot('B')],
      localSwarm: 'local',
    });
    expect(d.action).toBe('co-locate');
    expect(d.swarm).toBe('B');
  });

  it('tight is the default (omitted ⇒ co-locate)', () => {
    const d = decideCoLocation({
      collaboratorSwarms: ['B'],
      roster: [slot('local'), slot('B')],
      localSwarm: 'local',
    });
    expect(d.action).toBe('co-locate');
  });

  it('tight ⇒ co-locates on the DOMINANT (most-collaborators) Swarm', () => {
    const d = decideCoLocation({
      collaboratorSwarms: ['B', 'C', 'B'], // B has 2, C has 1
      roster: [slot('local'), slot('B'), slot('C')],
      localSwarm: 'local',
    });
    expect(d.swarm).toBe('B');
    expect(d.action).toBe('co-locate');
  });

  it('tight tie on count ⇒ breaks by lower load', () => {
    const d = decideCoLocation({
      collaboratorSwarms: ['B', 'C'], // 1 each
      roster: [slot('local', 5), slot('B', 9), slot('C', 2)],
      localSwarm: 'local',
    });
    expect(d.swarm).toBe('C'); // lower load wins the tie
  });

  it('tight + no collaborator ⇒ local', () => {
    const d = decideCoLocation({
      collaboratorSwarms: [],
      roster: [slot('local'), slot('B')],
      localSwarm: 'local',
    });
    expect(d.action).toBe('local');
    expect(d.swarm).toBe('local');
  });

  it('collaborator on a Swarm not in the roster is ignored ⇒ local', () => {
    const d = decideCoLocation({
      collaboratorSwarms: ['Z'], // not reachable
      roster: [slot('local'), slot('B')],
      localSwarm: 'local',
    });
    expect(d.action).toBe('local');
    expect(d.swarm).toBe('local');
  });

  it('loose + collaborator on B + another Swarm exists ⇒ spread to the least-loaded other', () => {
    const d = decideCoLocation({
      collaboratorSwarms: ['B'],
      roster: [slot('local', 4), slot('B', 1), slot('C', 0)],
      localSwarm: 'local',
      tight: false,
    });
    expect(d.action).toBe('spread');
    expect(d.swarm).toBe('C'); // least-loaded Swarm that isn't B
  });

  it('loose + every Swarm hosts a collaborator ⇒ spread with swarm:null (deploy a new one)', () => {
    const d = decideCoLocation({
      collaboratorSwarms: ['A', 'B'], // both reachable Swarms host collaborators
      roster: [slot('A'), slot('B')],
      localSwarm: 'A',
      tight: false,
    });
    expect(d.action).toBe('spread');
    expect(d.swarm).toBeNull();
    expect(d.reason).toMatch(/deploy/i);
  });

  it('loose + no collaborator ⇒ local', () => {
    const d = decideCoLocation({
      collaboratorSwarms: [],
      roster: [slot('local'), slot('B')],
      localSwarm: 'local',
      tight: false,
    });
    expect(d.action).toBe('local');
    expect(d.swarm).toBe('local');
  });

  it('is deterministic — same input, same decision', () => {
    const input = {
      collaboratorSwarms: ['B', 'C', 'B'],
      roster: [slot('local'), slot('B'), slot('C')],
      localSwarm: 'local',
    };
    expect(decideCoLocation(input)).toEqual(decideCoLocation(input));
  });
});
