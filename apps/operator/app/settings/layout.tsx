import Link from 'next/link';

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="pc-settings-shell">
      <aside className="pc-settings-nav" aria-label="Settings sections">
        <Link href="/settings/api-keys">API keys</Link>
        <Link href="/settings/oracle">Oracle</Link>
        <Link href="/settings/profile">Profile</Link>
        <Link href="/settings/publishing">Publishing</Link>
        <Link href="/settings/plugins">Plugins</Link>
        <Link href="/settings/plugin-runtime">Plugin runtime</Link>
      </aside>
      <section>{children}</section>
    </div>
  );
}
