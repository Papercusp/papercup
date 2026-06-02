/**
 * papercusp:list_workspaces — discovery helper for shell-launched OMP
 * agents in superuser mode.
 *
 * Returns every workspace the user has, plus its harnesses. Agents call
 * this to pick a `workspace=` arg for subsequent calls (since superuser
 * URLs don't bake in a workspace).
 *
 * Available to all roles via the standard tool surface, but most useful
 * when called from `?superuser=1` shells.
 */
import { z } from 'zod';
declare const _default: import("@papercusp/tooldef/src/types").RoleToolDefinition<z.ZodObject<{}, z.core.$strict>, import("@papercusp/tooldef/src/tool-projection").EventsSchema>;
export default _default;
