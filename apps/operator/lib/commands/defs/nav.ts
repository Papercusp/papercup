/**
 * nav.* — browser navigation.
 */
import { z } from 'zod';
import { register } from '../registry';
import type { CommandDef } from '../types';

const NavigateArgs = z.object({
  path: z.string().min(1).describe('Path within the operator app (e.g. /harness, /settings/voice).'),
});

const navigate: CommandDef<z.infer<typeof NavigateArgs>> = {
  id: 'navigate',
  kind: 'command',
  description: 'Navigate the browser to a path within the operator app.',
  promptDescription:
    'Routes the user to the given path. Use for "take me to settings" / "go to the ' +
    'sheets harness". Common paths: /harness, /settings/voice, /settings/api-keys, ' +
    '/marketplace, /installed/harnesses.',
  schema: NavigateArgs,
  agents: ['oracle', 'operator', 'palette', 'shortcut'],
  browser: 'required',
  concurrent: 'allow',
  tier: 'reflexive',
  paletteEntry: { section: 'Navigate', title: 'Navigate to…', icon: '→', keywords: 'go open route' },
  handler: async ({ path }) => {
    if (typeof window === 'undefined') throw new Error('navigate must run in browser');
    // Preserve ?ws= so workspace context survives the nav.
    const ws = new URL(window.location.href).searchParams.get('ws');
    let target = path;
    if (ws && !path.includes('?')) target = `${path}?ws=${encodeURIComponent(ws)}`;
    else if (ws && path.includes('?') && !path.includes('ws=')) target = `${path}&ws=${encodeURIComponent(ws)}`;
    window.location.href = target;
    return { path: target };
  },
};

register(navigate);
