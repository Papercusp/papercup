'use client';

/**
 * PublishHiveCard — the picker share-offer's embedded Share-Hive form
 * (comb-hive-native-sharing-2026-06-11 P-004).
 *
 * Was the retired ShareWizard's one-click default-public publish; now the
 * MINIMAL embedded form of the Share-Hive dialog: the same visibility choice
 * (public / invite / private) with consequence copy, title + description,
 * member-repo listing, and the invite artifact — via the shared
 * `ShareHiveForm` core (ShareHiveDialog.tsx). Sharing happens at the HIVE
 * level; surfaces that used to launch the ShareWizard embed this card.
 */

import React from 'react';
import { ShareHiveForm, type ShareHiveFormProps } from './ShareHiveDialog';

export function PublishHiveCard({
  potSlug,
  hiveLabel = 'hive',
  ...seams
}: {
  potSlug: string;
  hiveLabel?: string;
} & Pick<ShareHiveFormProps, 'fetchShareMeta' | 'setHiveListing' | 'onSaved'>) {
  return (
    <div
      data-testid="publish-hive-card"
      style={{
        border: '1px solid var(--accent, #4a90d9)',
        borderRadius: 8,
        padding: 12,
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        Share {hiveLabel} <code>{potSlug}</code>
      </div>
      <div style={{ color: 'var(--fg-dim)', marginBottom: 10 }}>
        Sharing happens at the {hiveLabel} level — choose who can find and join it.
      </div>
      <ShareHiveForm potSlug={potSlug} hiveLabel={hiveLabel} compact {...seams} />
    </div>
  );
}
