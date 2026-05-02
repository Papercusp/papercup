'use client';
import Editor from '@monaco-editor/react';

export default function MonacoPane({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Editor
      height="100%"
      language="markdown"
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      options={{
        wordWrap: 'on',
        minimap: { enabled: true },
        fontSize: 13,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
