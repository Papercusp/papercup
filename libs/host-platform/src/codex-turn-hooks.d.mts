export type ManagedCodexTurnHook = {
  event: 'UserPromptSubmit' | 'Stop'; script: string; owner: string; marker: string;
  group: { matcher: string; hooks: { type: 'command'; command: string }[] };
};
export function codexManagedTurnHooks(options: {
  provenanceOwner?: string | null; journalOwner?: string | null;
  hookDir: string; provenanceDir: string;
}): ManagedCodexTurnHook[];
