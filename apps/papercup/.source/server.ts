// @ts-nocheck
import * as __fd_glob_36 from "../content/docs/overview/why.md?collection=docs"
import * as __fd_glob_35 from "../content/docs/overview/what-is-papercup.md?collection=docs"
import * as __fd_glob_34 from "../content/docs/overview/how-it-works.md?collection=docs"
import * as __fd_glob_33 from "../content/docs/overview/getting-started.md?collection=docs"
import * as __fd_glob_32 from "../content/docs/org/ui-map.md?collection=docs"
import * as __fd_glob_31 from "../content/docs/org/projects.md?collection=docs"
import * as __fd_glob_30 from "../content/docs/org/messages.md?collection=docs"
import * as __fd_glob_29 from "../content/docs/org/director-runtime.md?collection=docs"
import * as __fd_glob_28 from "../content/docs/org/directives.md?collection=docs"
import * as __fd_glob_27 from "../content/docs/org/charter.md?collection=docs"
import * as __fd_glob_26 from "../content/docs/org/api-reference.md?collection=docs"
import * as __fd_glob_25 from "../content/docs/operating/steer-and-chat.md?collection=docs"
import * as __fd_glob_24 from "../content/docs/operating/hooks.md?collection=docs"
import * as __fd_glob_23 from "../content/docs/operating/glossary.md?collection=docs"
import * as __fd_glob_22 from "../content/docs/operating/conventions.md?collection=docs"
import * as __fd_glob_21 from "../content/docs/operating/config.md?collection=docs"
import * as __fd_glob_20 from "../content/docs/decisions/prompt-cache.md?collection=docs"
import * as __fd_glob_19 from "../content/docs/decisions/log.md?collection=docs"
import * as __fd_glob_18 from "../content/docs/decisions/fresh-contexts.md?collection=docs"
import * as __fd_glob_17 from "../content/docs/decisions/curator.md?collection=docs"
import * as __fd_glob_16 from "../content/docs/compared/overview.md?collection=docs"
import * as __fd_glob_15 from "../content/docs/architecture/worktrees.md?collection=docs"
import * as __fd_glob_14 from "../content/docs/architecture/smoke-test.md?collection=docs"
import * as __fd_glob_13 from "../content/docs/architecture/shared-libs.md?collection=docs"
import * as __fd_glob_12 from "../content/docs/architecture/roles.md?collection=docs"
import * as __fd_glob_11 from "../content/docs/architecture/memory.md?collection=docs"
import * as __fd_glob_10 from "../content/docs/architecture/decisions-timeline.md?collection=docs"
import * as __fd_glob_9 from "../content/docs/architecture/competition.md?collection=docs"
import * as __fd_glob_8 from "../content/docs/architecture/checkpoints.md?collection=docs"
import * as __fd_glob_7 from "../content/docs/index.mdx?collection=docs"
import { default as __fd_glob_6 } from "../content/docs/org/meta.json?collection=docs"
import { default as __fd_glob_5 } from "../content/docs/overview/meta.json?collection=docs"
import { default as __fd_glob_4 } from "../content/docs/operating/meta.json?collection=docs"
import { default as __fd_glob_3 } from "../content/docs/compared/meta.json?collection=docs"
import { default as __fd_glob_2 } from "../content/docs/decisions/meta.json?collection=docs"
import { default as __fd_glob_1 } from "../content/docs/architecture/meta.json?collection=docs"
import { default as __fd_glob_0 } from "../content/docs/meta.json?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.docs("docs", "content/docs", {"meta.json": __fd_glob_0, "architecture/meta.json": __fd_glob_1, "decisions/meta.json": __fd_glob_2, "compared/meta.json": __fd_glob_3, "operating/meta.json": __fd_glob_4, "overview/meta.json": __fd_glob_5, "org/meta.json": __fd_glob_6, }, {"index.mdx": __fd_glob_7, "architecture/checkpoints.md": __fd_glob_8, "architecture/competition.md": __fd_glob_9, "architecture/decisions-timeline.md": __fd_glob_10, "architecture/memory.md": __fd_glob_11, "architecture/roles.md": __fd_glob_12, "architecture/shared-libs.md": __fd_glob_13, "architecture/smoke-test.md": __fd_glob_14, "architecture/worktrees.md": __fd_glob_15, "compared/overview.md": __fd_glob_16, "decisions/curator.md": __fd_glob_17, "decisions/fresh-contexts.md": __fd_glob_18, "decisions/log.md": __fd_glob_19, "decisions/prompt-cache.md": __fd_glob_20, "operating/config.md": __fd_glob_21, "operating/conventions.md": __fd_glob_22, "operating/glossary.md": __fd_glob_23, "operating/hooks.md": __fd_glob_24, "operating/steer-and-chat.md": __fd_glob_25, "org/api-reference.md": __fd_glob_26, "org/charter.md": __fd_glob_27, "org/directives.md": __fd_glob_28, "org/director-runtime.md": __fd_glob_29, "org/messages.md": __fd_glob_30, "org/projects.md": __fd_glob_31, "org/ui-map.md": __fd_glob_32, "overview/getting-started.md": __fd_glob_33, "overview/how-it-works.md": __fd_glob_34, "overview/what-is-papercup.md": __fd_glob_35, "overview/why.md": __fd_glob_36, });