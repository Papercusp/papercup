import { listAllProjectedTools } from '@papercusp/tooldef';
import './lib/agent-tools/index';

const tools = listAllProjectedTools();
const name = process.argv[2] ?? 'fleet:leader-brief';
const t: any = tools.find((x: any) => x.expose?.mcp?.name === name);
if (!t) {
  console.log('NOT FOUND. count=', tools.length);
  process.exit(1);
}
const g: any = t.guidance ?? {};
const parts: Record<string, number> = {
  description: (t.description ?? '').length,
  when: (g.when ?? '').length,
  notWhen: (g.notWhen ?? '').length,
  chaining: (g.chaining ?? '').length,
};
const byRole = Object.entries(g.byRole ?? {}).map(([k, v]: any) => [
  k,
  (v.when?.length ?? 0) + (v.notWhen?.length ?? 0) + (v.chaining?.length ?? 0),
]);
const total =
  Object.values(parts).reduce((a, b) => a + b, 0) + byRole.reduce((a, [, n]: any) => a + n, 0);
console.log(JSON.stringify({ name, parts, byRole, total }, null, 2));
console.log('=== description ===\n' + (t.description ?? ''));
for (const k of ['when', 'notWhen', 'chaining']) if (g[k]) console.log(`=== ${k} ===\n` + g[k]);
for (const [role, v] of Object.entries(g.byRole ?? {}) as any)
  console.log(`=== byRole.${role} ===\n` + JSON.stringify(v, null, 2));
