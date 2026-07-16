/**
 * getSessionUserOrLocalDefault — the session resolution for the operator-chat
 * CARD family (state-snapshot SSE, card-response, silence-nudge).
 *
 * WI-5044: these routes 401'd on a bare `getSessionUser` cookie check — a
 * webapp-era assumption. The DESKTOP product never mints a session cookie
 * (auth/me's auto-establish is passwordless-only; the IPC transport
 * synthesizes an operator principal, not a Cookie header), so on the real
 * desktop the state channel was dead: chat:ask_choice cards never rendered
 * live, the blocking askUser timed out to {cancelled}, and the model fell
 * back to a prose option list — the owner-reported "Pick one." dead-end.
 *
 * Trust decision: EXACTLY the one /api/auth/me already makes — a caller the
 * loopback perimeter admits gets the seeded default user when no session
 * cookie is present. Non-loopback callers stay strict-session, so this
 * changes nothing for any off-box exposure (defense-in-depth per
 * loopback-guard.ts; the primary perimeter remains the loopback bind).
 */
import { getSessionUser, getSessionUserOrDefault, type User } from '../auth';
import { isLoopbackHost } from './loopback-guard';

export async function getSessionUserOrLocalDefault(req: Request): Promise<User | null> {
  let user: User | null = null;
  try {
    user = await getSessionUser(req.headers);
  } catch {
    user = null;
  }
  if (user) return user;
  if (!isLoopbackHost(req.headers.get('host'))) return null;
  try {
    return await getSessionUserOrDefault(req.headers);
  } catch {
    return null;
  }
}
