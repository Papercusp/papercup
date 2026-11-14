/** Plain-Node detached entry. The shared producing build supplies this witness. */
declare const __PAPERCUSP_TESTING_CORE_SOURCE_SHA256__: string;
export const testingCoreSourceSha256 = typeof __PAPERCUSP_TESTING_CORE_SOURCE_SHA256__ === 'undefined'
  ? undefined : __PAPERCUSP_TESTING_CORE_SOURCE_SHA256__;
export { runTestFilesCore } from './run';
