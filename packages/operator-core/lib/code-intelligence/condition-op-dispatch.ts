/** Shared syntax detector for the shrink-only lint and edit-time reuse advisory. */
import { parse } from '@babel/parser';
import type { File, IfStatement, Node } from '@babel/types';

export const CONDITION_OPERATORS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'contains',
  'containsItem', 'containsText', 'exists', 'after', 'before', 'matches', 'startsWith', 'endsWith']);

export function parseShapeSource(source: string, file: string): File {
  const ast = parse(source, { sourceType: 'unambiguous', sourceFilename: file, allowReturnOutsideFunction: true,
    allowUndeclaredExports: true, errorRecovery: true,
    plugins: [['typescript', { dts: /\.d\.[cm]?ts$/.test(file) }], 'decorators-legacy',
      ...(file.endsWith('.tsx') || file.endsWith('.jsx') ? ['jsx' as const] : [])] });
  // The parser can carry a separate @babel/types installation. Its public File
  // shape is the boundary we consume; avoid comparing two recursive AST unions.
  if (ast.type !== 'File' || ast.program.type !== 'Program') throw new Error('unexpected syntax parser root');
  return ast as unknown as File;
}
export function shapeChildren(node: Node): Node[] {
  const nodes = (value: unknown): Node[] => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    return value && typeof value === 'object' && 'type' in value && typeof value.type === 'string' ? [value as Node] : [];
  };
  return Object.entries(node).filter(([key]) => !['loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'innerComments', 'errors'].includes(key))
    .flatMap(([, value]) => nodes(value));
}
export const shapeText = (node: Node, source: string) => source.slice(node.start!, node.end!);

export function operatorDispatches(ast: File, source: string, file: string,
  operators: ReadonlySet<string> = CONDITION_OPERATORS, threshold = 3) {
  const hits: { file: string; key: string; line: number; subject: string; literals: string[]; shape: string; text: string }[] = [];
  const record = (node: Node, subject: string, ops: string[], shape: string) => {
    const literals = [...new Set(ops)].filter(op => operators.has(op)).sort();
    if (literals.length >= threshold) hits.push({ file, key: file, line: node.loc!.start.line,
      subject, literals, shape, text: shapeText(node, source) });
  };
  const comparisons = (node: Node, out = new Map<string, string[]>()) => {
    if (node.type === 'BinaryExpression' && ['===', '=='].includes(node.operator)) {
      for (const [literal, subject] of [[node.left, node.right], [node.right, node.left]]) {
        if (literal.type === 'StringLiteral' && operators.has(literal.value)) {
          const key = shapeText(subject, source);
          out.set(key, [...(out.get(key) ?? []), literal.value]);
        }
      }
    }
    for (const child of shapeChildren(node)) comparisons(child, out);
    return out;
  };
  const collectChain = (node: IfStatement, groups: Map<string, string[]>) => {
    for (const [subject, ops] of comparisons(node.test)) groups.set(subject, [...(groups.get(subject) ?? []), ...ops]);
    if (node.alternate?.type === 'IfStatement') collectChain(node.alternate, groups);
  };
  const walk = (node: Node) => {
    if (node.type === 'SwitchStatement') record(node, shapeText(node.discriminant, source), node.cases.flatMap(clause =>
      clause.test?.type === 'StringLiteral' ? [clause.test.value] : []), 'switch');
    if (node.type === 'BlockStatement' || node.type === 'Program') {
      let groups = new Map<string, string[]>(), start: IfStatement | undefined;
      const flush = () => {
        for (const [subject, ops] of groups) record(start!, subject, ops, 'if-chain');
        groups = new Map(); start = undefined;
      };
      for (const statement of node.body) {
        if (statement.type === 'IfStatement') { start ??= statement; collectChain(statement, groups); }
        else flush();
      }
      flush();
    }
    for (const child of shapeChildren(node)) walk(child);
  };
  walk(ast);
  return hits;
}
