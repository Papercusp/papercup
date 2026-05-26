/**
 * @papercusp/testing-shell — public surface.
 *
 * - registry: defineTestDomain + TestDomain/TestSection/TestRunner types (P-001)
 * - DomainTestPanel: the shared subtab shell, parameterized by dataSource (P-002)
 * - data-source: the TestingDataSource interface + wire types + the
 *   default adminTestingDataSource (P-002)
 *
 * <TestingShell> (the left-rail + panel host) lands in P-003.
 */
export * from './registry';
export * from './data-source';
export { default as DomainTestPanel } from './DomainTestPanel';
