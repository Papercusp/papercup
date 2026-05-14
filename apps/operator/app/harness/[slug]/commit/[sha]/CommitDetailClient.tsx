'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { CommitDetail } from '@restart/git-graph';

export default function CommitDetailClient({ sha, slug }: { sha: string; slug: string }) {
  const router = useRouter();
  const back = `/harness?slug=${encodeURIComponent(slug)}`;
  return (
    <div className="h-commit-page-shell">
      <div className="h-commit-page-back">
        <Link href={back} className="h-commit-page-back-link">
          <ChevronLeft size={14} />
          <span>back to {slug}</span>
        </Link>
      </div>
      <CommitDetail
        sha={sha}
        showCommitUrl={(s: string) => `/api/harness/${slug}/git/show/${s}`}
        onClose={() => router.push(back)}
        layout="page"
      />
    </div>
  );
}
