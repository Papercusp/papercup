'use client';
import {
  MDXEditor,
  headingsPlugin, listsPlugin, quotePlugin, thematicBreakPlugin,
  markdownShortcutPlugin, linkPlugin, linkDialogPlugin, codeBlockPlugin,
  toolbarPlugin, UndoRedo, BoldItalicUnderlineToggles, BlockTypeSelect,
  CreateLink, ListsToggle, InsertThematicBreak,
} from '@mdxeditor/editor';
import '@mdxeditor/editor/style.css';

export default function MDXEditorPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ height: '100%', overflow: 'auto', background: '#15181c' }}>
      <style>{`
        .demo-mdx-dark .mdxeditor { background: #15181c !important; color: #e6e6e6 !important; --baseBg: #15181c; --baseBgActive: #1f2429; --baseBgHover: #1f2429; --baseBase: #15181c; --baseBgSubtle: #1a1d22; --baseBorder: #2a2a2a; --baseBorderHover: #3a3a3a; --baseText: #e6e6e6; --baseTextContrast: #fff; --accentBase: #4a90e2; --accentText: #4a90e2; --accentBg: #1f2a38; }
        .demo-mdx-dark .mdxeditor-toolbar { background: #1a1d22 !important; border-bottom: 1px solid #2a2a2a; }
        .demo-mdx-dark .mdxeditor-toolbar button, .demo-mdx-dark .mdxeditor-toolbar select { color: #ddd !important; }
        .demo-mdx-dark .mdxeditor-toolbar button:hover { background: #2a3540 !important; }
        .demo-mdx-dark .mdxeditor-root-contenteditable { color: #e6e6e6 !important; }
        .demo-mdx-dark code { background: #2a2a2a !important; color: #e6e6e6 !important; padding: 1px 4px; border-radius: 3px; }
        .demo-mdx-dark pre { background: #1a1d22 !important; }
        .demo-mdx-dark blockquote { border-left: 3px solid #4a90e2 !important; color: #aaa !important; }
        .demo-mdx-dark a { color: #6ab0ff !important; }
        .demo-mdx-dark hr { border-color: #2a2a2a !important; }
      `}</style>
      <div className="demo-mdx-dark">
        <MDXEditor
          markdown={value}
          onChange={onChange}
          contentEditableClassName="mdxeditor-prose"
          plugins={[
            headingsPlugin(),
            listsPlugin(),
            quotePlugin(),
            thematicBreakPlugin(),
            markdownShortcutPlugin(),
            linkPlugin(),
            linkDialogPlugin(),
            codeBlockPlugin({ defaultCodeBlockLanguage: 'ts' }),
            toolbarPlugin({
              toolbarContents: () => (
                <>
                  <UndoRedo />
                  <BoldItalicUnderlineToggles />
                  <BlockTypeSelect />
                  <CreateLink />
                  <ListsToggle />
                  <InsertThematicBreak />
                </>
              ),
            }),
          ]}
        />
      </div>
    </div>
  );
}
