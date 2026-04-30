import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(homedir(), '.papercusp');
const PATH = join(ROOT, 'publish-credentials.json');

export interface PublishCredentials {
  tenantId: string;
  tenantSecret: string;
  registeredAt: number;
  publishHost: string;
}

export const PUBLISH_CREDENTIALS_PATH = PATH;

export async function readPublishCredentials(): Promise<PublishCredentials | null> {
  try {
    return JSON.parse(await fs.readFile(PATH, 'utf8')) as PublishCredentials;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writePublishCredentials(c: PublishCredentials): Promise<void> {
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
  await fs.writeFile(PATH, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(PATH, 0o600);
}

export async function deletePublishCredentials(): Promise<void> {
  try {
    await fs.unlink(PATH);
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
      path: PATH,
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
    path: PATH,
  };
}
