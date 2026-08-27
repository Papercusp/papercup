export interface ResourceGovernorInventoryRow {
  id: string;
  disposition: "govern" | "bypass" | "semantic" | "upstream" | "false-positive";
  enforcement: string;
  paths: readonly string[];
  resourceDimensions: readonly string[];
  fanOut: string;
  durableSource: string;
  telemetry: string;
  contextAndRelease: string;
  currentCaps: string;
  writerEvidence: string;
}
export const RESOURCE_GOVERNOR_INVENTORY: readonly ResourceGovernorInventoryRow[];
export const BYPASS_REGISTRY: ReadonlyMap<
  string,
  { disposition: ResourceGovernorInventoryRow["disposition"]; reason: string }
>;
export function inspectGovernorSource(source: string): string[];
export function validateInventory(
  rows?: readonly Partial<ResourceGovernorInventoryRow>[],
): string[];
export function scanActiveInventory(
  files: readonly (readonly [string, string])[],
): string[];
export function scanInventory(
  files: readonly (readonly [string, string])[],
  options?: { migrations?: readonly string[] },
): string[];
