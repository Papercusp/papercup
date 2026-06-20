import { z } from 'zod';
const s = z.object({
  status: z.enum(['open','closed']).optional().describe('lifecycle state'),
  limit: z.number().int().min(1).max(100).optional(),
  name: z.string().min(1).describe('the name'),
  flag: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  nested: z.object({ id: z.string(), n: z.number() }).optional(),
  anyOfField: z.union([z.string(), z.number()]).optional(),
  rec: z.record(z.string(), z.number()).optional(),
});
const j = (z as any).toJSONSchema(s);
console.log("=== RAW toJSONSchema ===");
console.log(JSON.stringify(j, null, 2));
