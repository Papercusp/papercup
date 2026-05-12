'use client';

import {
  MarkdownEditor,
  type MarkdownEditorProps,
  type MarkdownEditorToolbar,
} from '../_components/MarkdownEditor';

const SETTINGS_MARKDOWN_TOOLBAR = [
  'headings', 'bold', 'italic', 'strike', '|',
  'list', 'ordered-list', 'check', 'quote', '|',
  'code', 'inline-code', 'link', 'table', '|',
  'edit-mode', 'preview', 'export',
] satisfies MarkdownEditorToolbar;

type SettingsMarkdownEditorProps = Omit<MarkdownEditorProps, 'outline' | 'toolbar'>;

export function SettingsMarkdownEditor(props: SettingsMarkdownEditorProps) {
  return <MarkdownEditor {...props} outline={false} toolbar={SETTINGS_MARKDOWN_TOOLBAR} />;
}
