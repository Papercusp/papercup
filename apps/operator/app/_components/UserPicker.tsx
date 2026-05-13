'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { User as UserIcon, ChevronDown, UserPlus, Settings, LogOut, ArrowLeftRight } from 'lucide-react';

interface User {
  id: string;
  username: string;
  display_name: string;
  has_password: boolean;
}

/**
 * User picker — appears in the chrome navbar next to the workspace
 * switcher. Shows the current user's display name + a dropdown to
 * switch user, edit preferences, add new user, or log out.
 *
 * Backed by /api/auth/me which falls through to the seeded `default`
 * user when no session cookie is present (Round-13 follow-up — was
 * silently rendering nothing on default-user installs because the
 * route required an explicit cookie).
 */
export default function UserPicker() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [autoLogin, setAutoLogin] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/auth/me');
        if (!r.ok) return;
        const j = await r.json();
        setUser(j.user ?? null);
        setAutoLogin(j.autoLogin === true);
      } catch {
        /* network failure — render nothing */
      }
    })();
  }, []);

  // Click-outside close.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const onLogout = useCallback(async () => {
    setOpen(false);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      toast.success('Logged out');
      router.replace('/login');
    } catch {
      toast.error('Logout failed');
    }
  }, [router]);

  if (!user) return null;

  return (
    <span ref={ref} className="pc-user-picker" style={{ position: 'relative', fontSize: 13 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={autoLogin ? `Auto-signed in as ${user.display_name}` : `Signed in as ${user.display_name}`}
        className="pc-user-trigger"
        style={{
          background: 'transparent',
          border: '1px solid var(--border, #2a2a2a)',
          color: 'var(--fg-dim, #aaa)',
          padding: '3px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 13,
          lineHeight: 1,
        }}
      >
        <UserIcon size={13} aria-hidden="true" strokeWidth={1.75} />
        <span>{user.display_name}</span>
        <ChevronDown size={11} aria-hidden="true" strokeWidth={1.75} style={{ opacity: 0.6 }} />
      </button>

      {open && (
        <div
          role="menu"
          className="pc-user-menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 1000,
            minWidth: 200,
            borderRadius: 8,
            border: '1px solid var(--border, #2a2a2a)',
            background: 'var(--surface, #1b1b1b)',
            padding: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
          }}
        >
          <div
            style={{
              padding: '6px 10px',
              fontSize: 11,
              opacity: 0.55,
              borderBottom: '1px solid var(--border, #2a2a2a)',
              marginBottom: 4,
            }}
          >
            {autoLogin ? 'Auto-signed in as' : 'Signed in as'}{' '}
            <span style={{ opacity: 0.95 }}>{user.display_name}</span>
          </div>
          <button
            type="button"
            onClick={() => { setOpen(false); router.push('/settings/user'); }}
            style={menuItemStyle}
            role="menuitem"
          >
            <Settings size={13} aria-hidden="true" strokeWidth={1.75} />
            <span>User preferences</span>
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); router.push('/login?switch=1'); }}
            style={menuItemStyle}
            role="menuitem"
          >
            <ArrowLeftRight size={13} aria-hidden="true" strokeWidth={1.75} />
            <span>Switch user</span>
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); router.push('/signup'); }}
            style={menuItemStyle}
            role="menuitem"
          >
            <UserPlus size={13} aria-hidden="true" strokeWidth={1.75} />
            <span>Add user</span>
          </button>
          <div style={{ height: 1, background: 'var(--border, #2a2a2a)', margin: '4px 0' }} />
          <button
            type="button"
            onClick={onLogout}
            style={menuItemStyle}
            role="menuitem"
          >
            <LogOut size={13} aria-hidden="true" strokeWidth={1.75} />
            <span>Log out</span>
          </button>
        </div>
      )}
    </span>
  );
}

const menuItemStyle: React.CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '6px 10px',
  borderRadius: 4,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 13,
  color: 'var(--fg, #ddd)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
};
