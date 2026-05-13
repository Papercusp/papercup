'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

/**
 * Mounts in the chrome and fires a toast when the user is silently
 * auto-logged-in (default user, no cookie) or returns after a daily
 * 4am-local reset.
 *
 * Suppression model — per-user:
 *   - `papercusp_user_welcomed_<userId>` stores the last welcome ms.
 *   - We compute the most recent 4am-local boundary. If the stored ts
 *     is BEFORE that boundary, fire the toast and update the stamp.
 *   - First-time-ever-for-this-user has no stamp → fires.
 *
 * This is intentionally NOT the same path as the explicit-login
 * welcome (set in /login → consumed by OperatorConversationProvider →
 * fires user_welcomed converse trigger). That stays brain-side; this
 * is chrome-side and only fires the toast.
 *
 * Suppressed entirely:
 *   - When `sessionStorage.papercusp_just_logged_in` is set (the user
 *     literally just submitted /login — they already saw the toast
 *     and don't need a duplicate).
 *   - When the chrome's auth probe says `autoLogin: false` AND we've
 *     already welcomed within the current 4am window.
 */

interface MeResponse {
  user?: { id: string; display_name: string } | null;
  autoLogin?: boolean;
}

/** Compute the most recent 4am-local epoch ms boundary at or before `now`. */
function lastReset4amLocalMs(now: number): number {
  const d = new Date(now);
  const today4am = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 4, 0, 0, 0).getTime();
  return now >= today4am ? today4am : today4am - 24 * 60 * 60 * 1000;
}

export default function AutoLoginWelcomeToast() {
  const router = useRouter();

  useEffect(() => {
    // Don't fire if the explicit-login flow just ran — /login set this
    // flag and the OperatorConversationProvider will consume it for the
    // brain greeting. Chrome toast would be a duplicate.
    let justLoggedIn = false;
    try {
      justLoggedIn = !!sessionStorage.getItem('papercusp_just_logged_in');
    } catch {
      /* sessionStorage unavailable */
    }
    if (justLoggedIn) return;

    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch('/api/auth/me');
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as MeResponse;
        const user = j.user;
        if (!user) return;

        const now = Date.now();
        const boundary = lastReset4amLocalMs(now);
        const stampKey = `papercusp_user_welcomed_${user.id}`;
        let lastMs = 0;
        try {
          const raw = localStorage.getItem(stampKey);
          lastMs = raw ? Number.parseInt(raw, 10) : 0;
          if (!Number.isFinite(lastMs)) lastMs = 0;
        } catch {
          /* localStorage unavailable — fall through; toast will fire each load */
        }

        if (lastMs >= boundary) return; // already welcomed this 4am window

        const isFirstEver = lastMs === 0;
        const message = isFirstEver
          ? `Signed in as ${user.display_name}`
          : `Welcome back, ${user.display_name}`;

        try {
          localStorage.setItem(stampKey, String(now));
        } catch {
          /* fine — toast will just re-fire next time, which is acceptable */
        }

        toast(message, {
          duration: 8_000,
          action: {
            label: 'Not you? Switch',
            onClick: () => router.push('/login?switch=1'),
          },
        });
      } catch {
        /* network failure — no-op */
      }
    })();

    return () => {
      cancelled = true;
    };
    // Empty dep array — fire once per chrome mount (= once per app load).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
