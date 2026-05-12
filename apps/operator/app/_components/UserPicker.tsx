'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

interface User {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

/**
 * User picker — appears in the chrome navbar next to the workspace
 * switcher. Shows the current user's display name + a dropdown to
 * switch user, edit preferences, or log out.
 *
 * Backed by /api/auth/me (returns { user, available }). Switching user
 * routes through /login because we want to honor any password the
 * other user has set (we don't store cross-user credentials client-side).
 */
export default function UserPicker() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/auth/me');
        if (!r.ok) return;
        const j = await r.json();
        setUser(j.user ?? null);
      } catch {
        /* network failure — render nothing */
      }
    })();
  }, []);

  // Click-outside close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const onLogout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    toast.success('Logged out');
    router.push('/login');
  }, [router]);

  if (!user) return null;

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`Signed in as ${user.display_name}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          fontSize: 13, cursor: 'pointer',
        }}
      >
        <span aria-hidden>👤</span>
        <span>{user.display_name}</span>
        <span style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', right: 0,
            zIndex: 1000, minWidth: 180,
            borderRadius: 8, border: '1px solid var(--border)',
            background: 'var(--surface)', padding: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}
        >
          <button
            type="button"
            onClick={() => { setOpen(false); router.push('/settings/user'); }}
            style={menuItemStyle}
          >
            User preferences
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); router.push('/login?switch=1'); }}
            style={menuItemStyle}
          >
            Switch user
          </button>
          <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
          <button
            type="button"
            onClick={onLogout}
            style={menuItemStyle}
          >
            Logout
          </button>
        </div>
      )}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  width: '100%', textAlign: 'left',
  padding: '6px 10px', borderRadius: 4,
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: 13,
};
