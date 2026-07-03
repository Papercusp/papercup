/**
 * dev:build_status — local-host build + service reachability check.
 *
 * Reads .next mtime, tails the prod log, and probes :3055 / :3070.
 * Used by the /dev right rail and the future Build block.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { buildStatus } from '../../dev-data';
import { buildKey } from '../../events/await/catalog';

export default defineTool({
  name: 'dev:build_status',
  profile: 'engineer',
  description: 'Local-host build mtime + bin/prod log tail + dev/prod server reachability.',
  capability: 'intel:read',
  guidance: {
    when: `Read recent build status from the dev panel — pass/fail per harness.`,
    notWhen: `For ONE harness's smoke tests, use harness-specific tools. dev:build_status is the cross-harness dev panel feed.`,
    seeAlso: [
      'dev:service_health (live service health)',
      'dev:pipeline_position (where an edit is in the deploy pipeline)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'bee'],
  args: z.object({}),
  async handler() {
    const result = await buildStatus();
    // event-await-discoverability P-001: if you're re-reading this to see a build/
    // deploy finish, sleep on the event instead of polling the panel.
    const awaitable = {
      hint: 'Waiting on a build/deploy? Don\'t re-poll — events:await the deploy or the gate (or use deploy:await / checkpoint:await), then END YOUR TURN. Full list: events:catalog.',
      events: [buildKey('deploy'), buildKey('checkpoint')],
      sugar: ['deploy:await', 'checkpoint:await'],
    };
    return { data: { ...result, awaitable } };
  },
});
