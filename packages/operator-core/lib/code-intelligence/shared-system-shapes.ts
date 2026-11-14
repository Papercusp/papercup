/** Syntax candidates prepared off the push path. No type/runtime or cross-file claim. */
import type { ArrowFunctionExpression, CallExpression, FunctionDeclaration, FunctionExpression, Node } from '@babel/types';
import { operatorDispatches, parseShapeSource, shapeChildren, shapeText } from './condition-op-dispatch.ts';

export const SHARED_SYSTEM_SHAPE_RULES = [
  { id: 'bespoke-condition-operators', hint: 'use evaluateOperatorTest from libs/generic/rules' },
  { id: 'status-poll-comparison', hint: 'use emitSystemEvent plus a reaction rule for work; useSyncQuery for UI data' },
  { id: 'cross-module-event-bus', hint: 'use emitSystemEvent plus a reaction rule' },
] as const;
export type SharedSystemShapeId = typeof SHARED_SYSTEM_SHAPE_RULES[number]['id'];
const advisoryOperators = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']);
type Callback = ArrowFunctionExpression | FunctionExpression | FunctionDeclaration;
const inlineCallback = (node: Node): node is Callback =>
  ['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type);

function callbackFor(expression: Node, ancestors: Node[]): Callback | undefined {
  if (inlineCallback(expression)) return expression;
  if (expression.type !== 'Identifier') return;
  const name = expression.name;
  for (const scope of [...ancestors].reverse()) {
    if (inlineCallback(scope) && scope.params.some(param => param.type === 'Identifier' && param.name === name)) return;
    if (scope.type !== 'BlockStatement' && scope.type !== 'Program') continue;
    for (const raw of scope.body) {
      const statement = raw.type === 'ExportNamedDeclaration' ? raw.declaration : raw;
      if (statement?.type === 'FunctionDeclaration' && statement.id?.name === name) return statement;
      if (statement?.type !== 'VariableDeclaration') continue;
      for (const declaration of statement.declarations) if (declaration.id.type === 'Identifier' && declaration.id.name === name) {
        return declaration.init && inlineCallback(declaration.init) ? declaration.init : undefined;
      }
    }
  }
}

const nameOfCall = (node: CallExpression) => node.callee.type === 'Identifier' ? node.callee.name
  : node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' ? node.callee.property.name : '';
function hasRead(node: Node): boolean {
  if (node.type === 'CallExpression' && /^(?:read|get|fetch|query|load|select|find)/i.test(nameOfCall(node))) return true;
  return shapeChildren(node).some(hasRead);
}
function pollsStatus(callback: Callback): boolean {
  if (!callback.body) return false;
  const declarations = new Map<string, Node>(), operands: Node[] = [];
  const visit = (node: Node) => {
    if (node !== callback.body && inlineCallback(node)) return;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) declarations.set(node.id.name, node.init);
    if (node.type === 'BinaryExpression' && ['==', '===', '!=', '!==', '>', '>=', '<', '<='].includes(node.operator)) operands.push(node.left, node.right);
    for (const child of shapeChildren(node)) visit(child);
  };
  visit(callback.body);
  const readDerived = (node: Node, seen = new Set<string>()): boolean => {
    if (node.type === 'Identifier' && declarations.has(node.name) && !seen.has(node.name)) {
      return readDerived(declarations.get(node.name)!, new Set([...seen, node.name]));
    }
    if (node.type === 'MemberExpression') return readDerived(node.object, seen);
    return hasRead(node);
  };
  const statusOperand = (node: Node): boolean => {
    if (node.type === 'Identifier') return /status|state/i.test(node.name);
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') return /^(status|state)$/i.test(node.property.name);
    if (node.type === 'CallExpression') return /status|state/i.test(nameOfCall(node));
    if (node.type === 'AwaitExpression') return statusOperand(node.argument);
    return false;
  };
  return operands.some(operand => statusOperand(operand) && readDerived(operand));
}

export function sharedSystemShapes(source: string, file = 'edit.ts') {
  const hits: { ruleId: SharedSystemShapeId; line1: number; text: string }[] = [];
  const ast = parseShapeSource(source, file);
  const add = (ruleId: SharedSystemShapeId, node: Node) => hits.push({ ruleId,
    line1: node.loc!.start.line, text: shapeText(node, source) });
  if (!file.replaceAll('\\', '/').startsWith('libs/generic/rules/')) {
    for (const hit of operatorDispatches(ast, source, file, advisoryOperators)) hits.push({ ruleId: 'bespoke-condition-operators', line1: hit.line, text: hit.text });
  }

  // An imported EventEmitter exposed by an ES module is concrete cross-module syntax.
  // A similarly named constructor or a private local emitter establishes no such fact.
  const constructors = new Set<string>(), namespaces = new Set<string>(), exported = new Set<string>();
  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration' && ['events', 'node:events'].includes(statement.source.value) && statement.importKind !== 'type') {
      for (const element of statement.specifiers) {
        if (element.type === 'ImportDefaultSpecifier') { constructors.add(element.local.name); namespaces.add(element.local.name); }
        if (element.type === 'ImportNamespaceSpecifier') namespaces.add(element.local.name);
        if (element.type === 'ImportSpecifier' && element.importKind !== 'type'
          && (element.imported.type === 'Identifier' ? element.imported.name : element.imported.value) === 'EventEmitter') constructors.add(element.local.name);
      }
    }
    if (statement.type === 'ExportNamedDeclaration' && !statement.source && statement.exportKind !== 'type') {
      for (const element of statement.specifiers) if (element.type === 'ExportSpecifier' && element.exportKind !== 'type') exported.add(element.local.name);
    }
    if (statement.type === 'ExportDefaultDeclaration' && statement.declaration.type === 'Identifier') exported.add(statement.declaration.name);
  }
  const isEmitter = (expression: Node) => expression.type === 'Identifier' ? constructors.has(expression.name)
    : expression.type === 'MemberExpression' && !expression.computed && expression.object.type === 'Identifier'
      && namespaces.has(expression.object.name) && expression.property.type === 'Identifier' && expression.property.name === 'EventEmitter';
  for (const raw of ast.program.body) {
    const statement = raw.type === 'ExportNamedDeclaration' ? raw.declaration : raw;
    if (statement?.type === 'VariableDeclaration') for (const declaration of statement.declarations) {
      if (declaration.id.type === 'Identifier' && (exported.has(declaration.id.name) || raw.type === 'ExportNamedDeclaration')
        && declaration.init?.type === 'NewExpression' && isEmitter(declaration.init.callee)) add('cross-module-event-bus', declaration);
    }
    if (raw.type === 'ExportDefaultDeclaration' && raw.declaration.type === 'NewExpression' && isEmitter(raw.declaration.callee)) add('cross-module-event-bus', raw);
  }
  const visit = (node: Node, ancestors: Node[]) => {
    if (node.type === 'CallExpression' && /^(setInterval|setTimeout)$/.test(nameOfCall(node)) && node.arguments[0]) {
      const callback = callbackFor(node.arguments[0], ancestors);
      if (callback && pollsStatus(callback)) add('status-poll-comparison', node);
    }
    for (const child of shapeChildren(node)) visit(child, [...ancestors, node]);
  };
  visit(ast, []);
  return hits;
}
