import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

// Sign-up is the create-user mode of the login screen.
export default function SignupRedirect() {
  redirect('/login?mode=signup');
}
