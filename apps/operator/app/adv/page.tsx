import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// /adv lands on the Plans tab. The shell + tab strip live in
// app/adv/layout.tsx → AdvShell.
export default function AdvIndexPage() {
  redirect('/adv/plans');
}
