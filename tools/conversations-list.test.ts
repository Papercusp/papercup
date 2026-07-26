
// ── WI-5807 (P-007) ──────────────────────────────────────────────────────────
// The coord:orient open-questions fold reads THIS handler's output through the
// in-process dispatch seam (which JSON-parses the content text). Every previous
// test in this file mocks the store, and orient.test.ts mocks the CALL — so
// between them nothing pins the one thing that silently breaks the feature: that
// the field names this handler emits are the field names shapeOpenQuestions reads.
// A rename on either side would leave both suites green and the fold permanently
// empty in production. This test spans that seam with the REAL handler output fed
// into the REAL shaping function.
describe('conversations:list ⇄ orient open-questions fold (WI-5807 contract)', () => {
  it('passes the unanswered/unscoped filters through to the store', async () => {
    await call({ kind: 'question', state: 'open', unansweredOnly: true, harness: 'web', includeUnscoped: true });
    expect(listM.mock.calls[0]![0]).toMatchObject({
      kind: 'question',
      state: 'open',
      unansweredOnly: true,
      harness_slug: 'web',
      includeUnscoped: true,
      // …and the scope pin is DROPPED, or workspace-wide rows (scope:'operator')
      // would be filtered out by the very call meant to include them.
      scope: undefined,
    });
  });

  it('emits rows the fold can actually read (the field-name contract)', async () => {
    const { shapeOpenQuestions } = await import('./orient-open-questions');
    listM.mockResolvedValue([
      {
        id: 'conv-7',
        kind: 'question',
        state: 'open',
        scope: 'operator',
        harness_slug: null,
        title: 'Why is the gate red?',
        body: 'b',
        asker_id: 'peer-9',
        topics: [],
        promoted_issue_id: null,
        created_ts: new Date(Date.now() - 86_400_000).toISOString(),
      },
    ] as never);

    // Exactly what composeOrient receives: the handler's JSON body.
    const b = body(await call({ kind: 'question', state: 'open', unansweredOnly: true }));
    const fold = shapeOpenQuestions(b.conversations, { selfOwnerId: 'me' });

    expect(fold).not.toBeNull();
    expect(fold!.count).toBe(1);
    expect(fold!.questions[0]).toMatchObject({
      id: 'conv-7',
      title: 'Why is the gate red?',
      asker: 'peer-9',
      ageDays: 1,
    });
    // The title fallback (body slice) and asker survive the seam too — i.e. the
    // fold never renders '(untitled)'/'unknown' for a well-formed row.
    expect(fold!.questions[0].title).not.toBe('(untitled)');
    expect(fold!.questions[0].asker).not.toBe('unknown');
  });
});
