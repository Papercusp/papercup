import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { papercuspRoot } from '@/lib/papercusp-root';

function CREDS_PATH() { return join(papercuspRoot(), 'publish-credentials.json'); }

export interface PublishCredentials {
  tenantId: string;
  tenantSecret: string;
  registeredAt: number;
  publishHost: string;
}

export function PUBLISH_CREDENTIALS_PATH() { return CREDS_PATH(); }

export async function readPublishCredentials(): Promise<PublishCredentials | null> {
  try {
    return JSON.parse(await fs.readFile(CREDS_PATH(), 'utf8')) as PublishCredentials;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writePublishCredentials(c: PublishCredentials): Promise<void> {
  await fs.mkdir(papercuspRoot(), { recursive: true, mode: 0o700 });
  await fs.writeFile(CREDS_PATH(), JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(CREDS_PATH(), 0o600);
}

export async function deletePublishCredentials(): Promise<void> {
  try {
    await fs.unlink(CREDS_PATH());
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export interface MaskedPublishCredentials {
  tenantId: string | null;
  tenantSecretMasked: string | null;
  registeredAt: string | null;
  publishHost: string | null;
  path: string;
}

export function maskPublishCredentials(c: PublishCredentials | null): MaskedPublishCredentials {
  if (!c) {
    return {
      tenantId: null,
      tenantSecretMasked: null,
      registeredAt: null,
      publishHost: null,
      path: CREDS_PATH(),
    };
  }
  return {
    tenantId: c.tenantId,
    tenantSecretMasked:
      c.tenantSecret.length < 12
        ? '***'
        : c.tenantSecret.slice(0, 6) + '...' + c.tenantSecret.slice(-4),
    registeredAt: new Date(c.registeredAt).toISOString(),
    publishHost: c.publishHost,
    path: CREDS_PATH(),
  };
}
