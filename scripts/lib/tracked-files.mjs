/** Host defaults over the shared portable enumerator; keep one implementation. */
import * as tree from '../../libs/test-config/src/tracked-files.mjs';
const ROOT = new URL('../..', import.meta.url).pathname;
export function declaredSubmodules(cwd = ROOT) { return tree.declaredSubmodules(cwd); }
export function listTrackedFiles(cwd = ROOT) { return tree.listTrackedFiles(cwd); }
export function listFilesIncludingUntracked(cwd = ROOT) { return tree.listFilesIncludingUntracked(cwd); }
export function presentOnDisk(files, cwd = ROOT) { return tree.presentOnDisk(files, cwd); }
export function coverageOf(files, cwd = ROOT) { return tree.coverageOf(files, cwd); }
export function describeUnscanned(scan, cwd = ROOT) { return tree.describeUnscanned(scan, cwd); }
