# Branding
URL: /internal/docs/branding

Visual identity assets — wordmark, mascot, favicon — and where they're used.

import { Aside } from '@astrojs/starlight/components';

The Papercusp visual identity was refreshed on **2026-04-27**. The live wordmark now uses the **Glow · official sans** treatment: the Papercup mascot sits behind the centered `papercusp` text instead of appearing as a separate icon beside it.

## Live asset

> Chosen variant: **Glow · official sans** from the marketplace logo lab (`/logo-lab/`).

| Asset                 | Source file                                                                                                     | Visual                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Live wordmark**     | `libs/papercusp-marketplace/apps/marketplace-site/public/wordmark.svg` and `apps/papercusp/public/wordmark.svg` | Integrated mascot-behind-text mark with soft central glow and a cleaner product-facing sans wordmark |
| **Standalone mascot** | `libs/papercusp-marketplace/apps/marketplace-site/public/mascot.svg`                                            | Cup mascot on its own; still useful for avatars / icon contexts                                      |

## Where the assets live (deployed)

| Path                                                                   | Purpose                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `libs/papercusp-marketplace/apps/marketplace-site/public/wordmark.svg` | papercuspai.com header, landing, footer, logo lab, marketplace pages |
| `libs/papercusp-marketplace/apps/marketplace-site/public/mascot.svg`   | Standalone mascot asset for non-wordmark contexts                    |
| `libs/papercusp-marketplace/apps/marketplace-site/public/favicon.svg`  | papercuspai.com browser tab icon                                     |
| `apps/papercusp/public/wordmark.svg`                                   | substrate operator UI (`localhost:3055`) header + homepage hero      |
| `apps/papercusp-spec/src/assets/wordmark.svg`                          | (Legacy) Starlight site nav — predecessor to this Fumadocs site      |
| `apps/papercusp-spec/src/assets/mascot.svg`                            | (Legacy) Starlight site, available for embedding                     |
| `apps/papercusp-spec/public/favicon.svg`                               | (Legacy) Starlight site's browser tab icon                           |

## Usage rules

For Papercusp app surfaces, prefer a **single integrated wordmark asset**. The mascot should sit behind the centered wordmark text — not as a separate icon with a gap beside the wordmark.

* **Integrated wordmark**: headers, landing heroes, footers, marketplace pages, docs nav if/when upgraded. This is now the default brand treatment.
* **Mascot alone**: avatars, profile images, app-icon experiments, or illustration contexts where no text is needed.
* **Logo lab**: nearby alternatives live at `http://localhost:3060/logo-lab/` for future review, but the live app should continue to point at the chosen official-sans version until another branding decision is made.

### Color palette (from the live asset)

* Wordmark / cusp / mascot linework: `#f3eef9`
* Glow center highlight: `#d4a373`
* Mascot cup body tint: `#fff5e1` at low opacity
* Background glow falloff: transparent radial fade from the same cream/tan core

## Source of truth

The full set of logo concepts is browseable at `/home/marsh-office/Documents/papercusp-logos/` and the current live wordmark studies are browsable at `http://localhost:3060/logo-lab/` when the marketplace static server is running.

The current live choice is **Glow · official sans**. Treat the logo-lab page as the review space and `wordmark.svg` as the production asset.

## How to update branding everywhere

If a future round changes the chosen wordmark, copy the new SVG to the active runtime paths above, then rebuild:

* **papercuspai.com**: `cd libs/papercusp-marketplace/apps/marketplace-site && npm run build` (then restart/redeploy the static host as needed)
* **substrate UI**: update `apps/papercusp/public/wordmark.svg` and let the **Vite** dev server on `:3055` hot-reload (or restart it if required)
* **spec docs**: update Starlight assets only if the legacy docs site still needs to mirror the newer branding

Don't forget to also update:

* Logo-lab `Current live wordmark` copy (so the comparison page stays truthful)
* README banners in repos (if any)
* Open Graph cards (currently default; not yet wired)
* Social profile avatars / external brand surfaces if the decision also changes those
