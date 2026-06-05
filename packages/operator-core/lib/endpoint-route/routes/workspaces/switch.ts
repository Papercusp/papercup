/**
 * POST /api/workspaces/switch — change the active workspace (webapp path).
 *
 * Updates registry.json's `current` field and fans the workspace-switch
 * hook so the leaving workspace's in-memory state is dropped. The desktop
 * shell uses the `workspaces_switch` Tauri command instead (it also kills
 * the sidecar + embedded-postgres-server first).
 *
 * Ported from app/api/workspaces/switch/route.ts. `auth: 'public'`.
 */
import { existsSync, promises as fs } from 'node:fs';
import { workspacesRoot } from '../../../workspace-registry';
import { join } from 'node:path';
import { dispatchWorkspaceSwitch } from '@papercusp/agent-mcp';
import { defineTool } from '@papercusp/agent-mcp';

const REGISTRY_PATH = join(workspacesRoot(), 'registry.json');

interface Registry {
  current: string;
  workspaces: { id: string; name: string; createdAt: number }[];
}

export default defineTool({
  method: 'POST',
  path: '/workspaces/switch',
  auth: 'public',
  async handler(req) {
    let body: { id?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    const id = String(body.id ?? '').trim();
    if (!id) return Response.json({ ok: false, error: 'id required' }, { status: 400 });
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
      return Response.json({ ok: false, error: `invalid workspace id "${id}"` }, { status: 400 });
    }
    if (!existsSync(REGISTRY_PATH)) {
      return Response.json({ ok: false, error: 'no workspace registry on disk' }, { status: 404 });
    }
    const reg = JSON.parse(await fs.readFile(REGISTRY_PATH, 'utf8')) as Registry;
    if (!reg.workspaces.some((w) => w.id === id)) {
      return Response.json({ ok: false, error: `unknown workspace "${id}"` }, { status: 404 });
    }
    if (reg.current === id) {
      return Response.json({ ok: true, id, alreadyCurrent: true });
    }
    // Capture the leaving workspace before flipping `current` so the
    // workspace-switch hook can drop its in-memory state (replay buffers,
    // card-correlator PENDING entries, state-channel run snapshots).
    const leaving = reg.current;
    reg.current = id;
    await fs.writeFile(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf8');
    // Fire-and-forget — cleanup is best-effort; a subscriber failure must
    // not break the switch. dispatchWorkspaceSwitch isolates throws.
    void dispatchWorkspaceSwitch(leaving).catch((e) => {
      console.warn('[workspaces/switch] dispatchWorkspaceSwitch failed:', e);
    });
    return Response.json({ ok: true, id });
  },
});
