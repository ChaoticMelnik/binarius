import path from 'node:path';
import type { Rule } from 'eslint';
import ts from 'typescript';

// A status column is text + CHECK built from one `as const` object (packages/db/src/schema/
// columns.ts), and codes and field names follow the same pattern. A bare 'pending' elsewhere
// keeps compiling after the constant is renamed and then silently matches nothing — #7 found
// such literals outside their one file. The constants are discovered from the TypeScript
// program rather than listed here: any exported `as const` object of strings with a type alias
// of the same name, in a non-test source file under apps/*/src or packages/*/src that the linted
// file's program includes.
//
// A literal (or a template literal without substitutions) is flagged when the full set of string
// members of its expected type equals the value set of one constant. Comparing whole sets rather than the type's alias is deliberate:
// contextual types such as `UserStatus | undefined` or `SQL | BrokerAccountStatus | Placeholder`
// carry no alias, while their string members still spell the constant exactly. A partial union
// (an outcome tag, a subset of statuses) matches no constant and is left alone.

const DEFINING_FILE = /[\\/](apps|packages)[\\/][^\\/]+[\\/]src[\\/].*\.ts$/;
const SQL_WORD = /'([a-z0-9_-]+)'/g;
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

interface Constant {
  name: string;
  file: string;
  members: Map<string, string>;
}

interface Definitions {
  bySet: Map<string, Constant[]>;
  byValue: Map<string, Constant[]>;
  definingFilesSeen: number;
}

// the typed parser's services; its types live in @typescript-eslint/parser, which the root does
// not resolve, so only the two members this rule reads are declared
interface ParserServices {
  program?: ts.Program;
  esTreeNodeToTSNodeMap?: { get(node: unknown): ts.Node | undefined };
}

const setKey = (values: Iterable<string>): string => [...new Set(values)].sort().join('\u0000');

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function hasExport(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function constantsIn(file: ts.SourceFile): Constant[] {
  const typeAliases = new Set<string>();
  const candidates: Constant[] = [];
  for (const statement of file.statements) {
    if (ts.isTypeAliasDeclaration(statement) && hasExport(statement)) {
      typeAliases.add(statement.name.text);
    }
    if (!ts.isVariableStatement(statement) || !hasExport(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const init = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || init === undefined) continue;
      if (!ts.isAsExpression(init) || !ts.isObjectLiteralExpression(init.expression)) continue;
      const asConst =
        ts.isTypeReferenceNode(init.type) &&
        ts.isIdentifier(init.type.typeName) &&
        init.type.typeName.text === 'const';
      if (!asConst) continue;
      const members = new Map<string, string>();
      const allStrings = init.expression.properties.every((property) => {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) {
          return false;
        }
        members.set(property.initializer.text, property.name.getText(file));
        return true;
      });
      if (allStrings && members.size > 0) {
        candidates.push({ name: declaration.name.text, file: file.fileName, members });
      }
    }
  }
  return candidates.filter((constant) => typeAliases.has(constant.name));
}

const cache = new WeakMap<ts.Program, Definitions>();

function definitionsOf(program: ts.Program): Definitions {
  const cached = cache.get(program);
  if (cached !== undefined) return cached;
  const definitions: Definitions = { bySet: new Map(), byValue: new Map(), definingFilesSeen: 0 };
  for (const file of program.getSourceFiles()) {
    if (file.isDeclarationFile || !DEFINING_FILE.test(file.fileName)) continue;
    if (file.fileName.endsWith('.test.ts') || /[\\/]node_modules[\\/]/.test(file.fileName))
      continue;
    definitions.definingFilesSeen++;
    for (const constant of constantsIn(file)) {
      push(definitions.bySet, setKey(constant.members.keys()), constant);
      for (const value of constant.members.keys()) push(definitions.byValue, value, constant);
    }
  }
  cache.set(program, definitions);
  return definitions;
}

function stringMembers(type: ts.Type): string[] | undefined {
  const members = type.isUnion() ? type.types : [type];
  const strings = members.filter((member) => member.isStringLiteral());
  // `string` itself (or a template type) means the position accepts anything: no constant owns it
  if (
    members.some(
      (member) => (member.flags & ts.TypeFlags.StringLike) !== 0 && !member.isStringLiteral(),
    )
  ) {
    return undefined;
  }
  return strings.map((member) => (member as ts.StringLiteralType).value);
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'values of an `as const` object of strings (statuses, codes, field names) are spelled through that object',
    },
    schema: [],
    messages: {
      literal:
        "use {{suggestion}}; a bare '{{value}}' keeps compiling after a rename and silently matches nothing",
      noConstants:
        'no-status-literal found source files in this program but no `as const` string objects in them; the rule would pass vacuously',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices as unknown as ParserServices;
    const program = services.program;
    const maybeNodeMap = services.esTreeNodeToTSNodeMap;
    if (program === undefined || maybeNodeMap === undefined) {
      throw new Error('no-status-literal needs typed linting (parserOptions.projectService)');
    }
    const nodeMap = maybeNodeMap;
    const definitions = definitionsOf(program);
    const checker = program.getTypeChecker();
    const here = path.resolve(context.filename);
    const cwd = context.cwd;

    const outside = (constants: Constant[]): Constant[] =>
      constants.some((constant) => path.resolve(constant.file) === here) ? [] : constants;

    const suggest = (constants: Constant[], value: string): string =>
      constants
        .map(
          (constant) =>
            `${constant.name}.${constant.members.get(value)} from ${path.relative(cwd, constant.file)}`,
        )
        .join(' or ');

    // The type a comparison partner was declared with, not the flow-narrowed one: after
    // `if (s === 'pending') return`, `s` is narrowed to the remaining members and the next
    // comparison would no longer see the whole set. A computed key (`row[key]`) has no property
    // symbol and falls back to the narrowed type.
    function declaredType(other: ts.Expression): ts.Type {
      let target: ts.Node = other;
      if (ts.isPropertyAccessExpression(other)) target = other.name;
      else if (
        ts.isElementAccessExpression(other) &&
        ts.isStringLiteralLike(other.argumentExpression)
      ) {
        target = other.argumentExpression;
      }
      let symbol = checker.getSymbolAtLocation(target);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      return symbol === undefined
        ? checker.getTypeAtLocation(other)
        : checker.getTypeOfSymbol(symbol);
    }

    // TypeScript gives no contextual type to an operand of `===` or to a `case` label, and a
    // comparison is where a stale status literal does its damage, so both take the declared type
    // of what they are compared with
    function expectedType(expression: ts.Expression): ts.Type | undefined {
      const parent = expression.parent;
      if (ts.isBinaryExpression(parent) && EQUALITY.has(parent.operatorToken.kind)) {
        return declaredType(parent.left === expression ? parent.right : parent.left);
      }
      if (ts.isCaseClause(parent) && parent.expression === expression) {
        return declaredType(parent.parent.parent.expression);
      }
      return checker.getContextualType(expression);
    }

    function checkValue(node: Rule.Node, value: string): void {
      const tsNode = nodeMap.get(node);
      if (tsNode === undefined || !ts.isExpression(tsNode)) return;
      const expected = expectedType(tsNode);
      if (expected === undefined) return;
      const members = stringMembers(expected);
      if (members === undefined || !members.includes(value)) return;
      const owners = outside(definitions.bySet.get(setKey(members)) ?? []);
      if (owners.length === 0) return;
      context.report({
        node,
        messageId: 'literal',
        data: { value, suggestion: suggest(owners, value) },
      });
    }

    function checkSqlText(node: Rule.Node, text: string): void {
      for (const match of text.matchAll(SQL_WORD)) {
        const value = match[1]!;
        const owners = outside(definitions.byValue.get(value) ?? []);
        if (owners.length === 0) continue;
        context.report({
          node,
          messageId: 'literal',
          data: { value, suggestion: suggest(owners, value) },
        });
      }
    }

    return {
      Program(node) {
        if (definitions.definingFilesSeen > 0 && definitions.bySet.size === 0) {
          context.report({ node, messageId: 'noConstants' });
        }
      },
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const parent = node.parent;
        if (parent.type === 'Property' && parent.key === node) return;
        if (
          parent.type === 'ImportDeclaration' ||
          parent.type === 'ExportNamedDeclaration' ||
          parent.type === 'ExportAllDeclaration' ||
          parent.type === 'ImportExpression' ||
          (parent.type as string) === 'TSLiteralType' ||
          (parent.type as string) === 'TSExternalModuleReference'
        ) {
          return;
        }
        checkValue(node, node.value);
      },
      TemplateLiteral(node) {
        // a tagged template's text is SQL or similar, checked by the visitor below, not a value
        if (node.expressions.length > 0 || node.parent.type === 'TaggedTemplateExpression') return;
        const cooked = node.quasis[0]?.value.cooked;
        if (typeof cooked === 'string') checkValue(node, cooked);
      },
      TaggedTemplateExpression(node) {
        if (node.tag.type !== 'Identifier' || node.tag.name !== 'sql') return;
        for (const quasi of node.quasi.quasis) checkSqlText(node, quasi.value.raw);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.object.type !== 'Identifier' ||
          callee.object.name !== 'sql' ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'raw'
        ) {
          return;
        }
        const argument = node.arguments[0];
        if (argument?.type === 'Literal' && typeof argument.value === 'string') {
          checkSqlText(node, argument.value);
        } else if (argument?.type === 'TemplateLiteral') {
          for (const quasi of argument.quasis) checkSqlText(node, quasi.value.raw);
        }
      },
    };
  },
};

export default rule;
