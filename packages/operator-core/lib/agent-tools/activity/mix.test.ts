import { describe, expect, it } from 'vitest';
import { activityMode, summarizeActivityMix, unwrapActivityRow } from './mix';

const row = (ts: number, tool_name: string, args_json: unknown = {}) => ({ ts, tool_name, args_json });

describe('activity:mix pure attribution', () => {
  it('drops automatic telemetry before it can create a burst', () => {
    const result = summarizeActivityMix([
      row(0, 'activity:report'),
      row(1, 'dev:pg_query'),
      row(40, 'work_items:get'),
    ]);

    expect(result.telemetryDropped).toBe(1);
    expect(result.bursts).toBe(2);
    expect(result.byMode.map(([mode]) => mode)).toEqual(['investigate', 'record-durably']);
  });

  it('unwraps tools:invoke and code:run instead of attributing the wrapper', () => {
    const invoke = unwrapActivityRow(row(1, 'tools:invoke', { name: 'work_items:get', args: { id: 'WI-1' } }));
    const code = unwrapActivityRow(row(2, 'code:run', { script: "await tools.capability.edit({ file_path: 'src/a.ts' });" }));

    expect(invoke).toMatchObject({ unwrapped: true, calls: [{ tool: 'work_items:get' }] });
    expect(code).toMatchObject({ unwrapped: true, calls: [{ tool: 'capability:edit' }] });
    expect(activityMode(invoke.calls[0])).toBe('record-durably');
    expect(activityMode(code.calls[0])).toBe('implement');
  });

  it('uses the explicit recipient, not a body mention, for owner-comms', () => {
    expect(activityMode({ ts: 1, tool: 'coord:send', args: { to: ['su-peer'], body: 'human review noted' } })).toBe('supervise');
    expect(activityMode({ ts: 2, tool: 'coord:send', args: { to: ['human'], body: 'status report' } })).toBe('owner-comms');
  });

  it('splits a burst that mentions multiple portfolio responsibilities', () => {
    const result = summarizeActivityMix([
      row(0, 'dev:pg_query', { sql: 'inspect qemu Windows incident and Linux dpkg packaging' }),
      row(5, 'work_items:get', { id: 'WI-1' }),
      row(40, 'coord:send', { to: ['human'] }),
    ]);

    const responsibilities = new Map(result.byResponsibility.map(([name, percentage]) => [name, percentage]));
    expect(responsibilities.get('windows leg / VM incident')).toBe(
      responsibilities.get('linux leg'),
    );
    expect(Number(responsibilities.get('windows leg / VM incident')?.replace('%', ''))).toBeGreaterThan(0);
    expect(result.responsibilitySwitches).toBe(1);
  });

  it('caps long idle gaps and marks a bounded fetch as truncated', () => {
    const result = summarizeActivityMix([row(0, 'dev:pg_query'), row(1000, 'dev:pg_query')], 3);

    expect(result.truncated).toBe(true);
    expect(result.idleTrimmedMin).toBeGreaterThan(0);
    expect(result.attributedMin).toBeGreaterThan(0);
  });
});
