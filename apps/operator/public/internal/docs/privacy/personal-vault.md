# Personal Vault privacy and data-control contract
URL: /internal/docs/privacy/personal-vault

How Personal Vault keeps imported mail, calendar, contacts, and social archives local; who may access it; and how the owner disables or purges it.

# Personal Vault privacy contract

Personal Vault is an owner-controlled, local data pool for Gmail, Google Calendar, Google Contacts, and offline social-network archives. It is deliberately separate from Papercusp's general memory system. Personal records never join the normal recall scope fan-out.

## What stays local

Archive files are parsed on this machine. Gmail mbox, Calendar ICS, Contacts vCard, Facebook/Instagram message JSON, and X archive data are normalized directly into `harness_shared.personal_documents`. The original archive is not uploaded by the importer.

Personal document and query embeddings use the local EmbeddingGemma-300m path. The database requires the personal embedding mode discriminator; cloud embedding modes cannot be written into the personal vector space. Personal content must not be sent to a cloud embedding API.

## Access is default-deny

A plan template must declare `personalScopes` in its frontmatter. Before arming the plan, the owner reviews and approves exactly those scopes in **Settings → Personal Vault**. Approval replaces an older broader grant instead of leaving stale access behind.

At runtime the server resolves the caller from live plan-run, binding, and role state. Prompt text cannot nominate a principal or expand a scope. A live, unrevoked grant must match that server-resolved principal. Coding and review roles are denied absolutely—even if a grant row exists for the role.

Granted ambient recall is a separate turn-start block labeled **Granted Personal Vault context** with scope and source provenance. An ungranted, coding, disabled, failed, or empty lookup injects nothing: no heading, placeholder, or existence signal.

## User controls

The Personal Vault settings page shows source counts and the local-only posture. The owner can:

* disable the vault, which immediately rejects new writes;
* re-enable it explicitly;
* revoke a plan grant;
* purge one source or the entire vault after destructive confirmation;
* import supported archives with local drag and drop.

A source purge removes its personal documents and synchronization cursor state. Document vectors live on the document rows and disappear with them. The all-source purge applies the same operation across every imported source.

## Live Google ingestion

External-trigger adapters normalize each Gmail or Calendar event once. The canonical event is then delivered to the event bus and, for the authenticated local user, to `createPersonalVaultExternalSink`. The sink's delivery identity includes the local user id so two users cannot dedupe each other's private writes. Contacts use the same authenticated user association and a paged local sync.

Social v1 is archive-import-only. Live social APIs and their credentials are outside the v1 privacy contract.

## Verification contract

The acceptance suite must keep both sides green:

1. import an archive, persist and search it, and show the result in a granted context;
2. prove byte-empty output for an ungranted context and for a coding role, including when that coding role has an explicit grant.

The migration and runtime tests also cover workspace/user isolation, local-only embedding modes, revocation/replacement, kill-switch writes, purge, identity resolution, and second-sink persistence.
