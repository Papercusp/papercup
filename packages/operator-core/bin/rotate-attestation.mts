/** Run under flock, with the host's identity writers stopped (shared-pot-guide). */
import { rotatePublicAttestation } from '../lib/identity/attest';
import { resolveLocalGithubIdentity } from '../lib/identity/resolve-local-github-identity';
import { loadCachedLocalAnnounceIdentity, persistLocalAnnounceIdentity } from '../lib/sync/hyperbee/local-announce-identity';

const [oldId, ...extra] = process.argv.slice(2);
if (!oldId || extra.length) throw new Error('Usage: rotate-attestation.mts OLD_PUBLIC_GIST_ID');
const device = await loadCachedLocalAnnounceIdentity();
const account = await resolveLocalGithubIdentity();
if (!device || account.kind !== 'ok' || !account.token || account.githubUserId !== device.githubUserId) {
  throw new Error('The signed-in GitHub account and this machine’s cached key must match');
}
await rotatePublicAttestation({
  keychainId: device.keychainId, pubkeyBase64: device.devicePubkeyBase64,
  deviceLabel: 'papercusp-' + device.githubLogin, githubLogin: device.githubLogin,
  githubUserId: device.githubUserId, token: account.token, knownGistId: device.attestationGistId,
}, oldId, attestationGistId => persistLocalAnnounceIdentity({
  ...device, attestationGistId, attestationVisibility: 'secret', supersededGistId: oldId,
}));
console.log('Unlisted device binding verified and installed. Restart the Server to announce it.');
