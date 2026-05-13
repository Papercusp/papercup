import 'server-only';
import { listCommands } from '../../../../lib/admin-commands';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  return Response.json({ commands: listCommands() });
}
