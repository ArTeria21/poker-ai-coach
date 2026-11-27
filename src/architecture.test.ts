import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';

/**
 * Import boundaries between layers (production code only; tests may arrange
 * scenarios across layers). Type-only imports and re-exports count: a type
 * dependency is still a dependency on the module that owns the concept.
 *
 *   ui -> app -> agent / bots / analysis / game -> decision -> engine / equity / math -> cards -> random
 *   server -> agent / equity (no browser worker transport) / math / cards / random
 */
const ALLOWED: Record<string, readonly string[]> = {
  random: [],
  cards: ['random'],
  engine: ['cards', 'random'],
  equity: ['cards', 'random'],
  math: ['cards'],
  decision: ['engine', 'equity', 'math', 'cards', 'random'],
  game: ['engine', 'cards', 'random'],
  bots: ['decision', 'engine', 'equity', 'math', 'cards', 'random'],
  analysis: ['decision', 'engine', 'equity', 'math', 'cards', 'random'],
  // contract.ts names the grade type the coach receives; training rules never call grading.
  agent: ['analysis', 'decision', 'engine', 'math', 'cards', 'random'],
  app: ['agent', 'analysis', 'bots', 'decision', 'engine', 'equity', 'game', 'math', 'cards', 'random'],
  ui: ['app', 'agent', 'bots', 'decision', 'engine', 'game', 'math', 'cards', 'random'],
  main: ['ui'],
  server: ['agent', 'equity', 'math', 'cards', 'random'],
};

/** The two inferred client/server contracts: type-only, never a runtime import of server code. */
const TYPE_ONLY_EXCEPTIONS = new Set(['src/app/coachSession.ts -> server/tools.ts', 'src/ui/memory/MemoryDrawer.tsx -> server/memory.ts']);

/** Browser-only equity worker transport: Node-side code must not load it. */
const BROWSER_ONLY = new Set(['src/equity/equityClient.ts', 'src/equity/equity.worker.ts']);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'tests' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function layerOf(file: string): string {
  const [top, second] = file.split('/');
  if (top === 'server') return 'server';
  if (second === 'random.ts') return 'random';
  if (second === 'main.tsx') return 'main';
  return second;
}

interface Edge { from: string; to: string; names: string[]; typeOnly: boolean }

function edges(file: string): Edge[] {
  const text = readFileSync(join(root, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Edge[] = [];
  const add = (specifier: string, names: string[], typeOnly: boolean) => {
    if (!specifier.startsWith('.')) return;
    const base = join(dirname(file), specifier);
    const to = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find((candidate) => existsSync(join(root, candidate)) && statSync(join(root, candidate)).isFile());
    if (!to) throw new Error(`${file}: unresolved import ${specifier}`);
    if (/\.tsx?$/.test(to)) found.push({ from: file, to, names, typeOnly });
  };
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      let names: string[] = [];
      let typeOnly = false;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        const named = bindings && ts.isNamedImports(bindings) ? bindings.elements : undefined;
        names = named ? named.map((element) => (element.propertyName ?? element.name).text) : bindings ? ['*'] : [];
        if (clause?.name) names.push('default');
        typeOnly = !!clause && (clause.isTypeOnly || (!clause.name && !!named && named.length > 0 && named.every((element) => element.isTypeOnly)));
      } else {
        const clause = node.exportClause;
        names = clause && ts.isNamedExports(clause) ? clause.elements.map((element) => (element.propertyName ?? element.name).text) : ['*'];
        typeOnly = node.isTypeOnly;
      }
      add(node.moduleSpecifier.text, names, typeOnly);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      add(node.arguments[0].text, ['*'], false);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal.text, ['*'], true);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const all = [...sources('src'), ...sources('server')].flatMap(edges);

it('discovers the production import graph', () => {
  expect(all.length).toBeGreaterThan(100);
  expect(all.some((edge) => edge.from === 'src/app/tableController.ts' && edge.to === 'src/engine/decisionView.ts')).toBe(true);
});

it('keeps every import inside the layer rules', () => {
  const violations = all.filter((edge) => {
    const from = layerOf(edge.from), to = layerOf(edge.to);
    if (from === to) return false;
    if (TYPE_ONLY_EXCEPTIONS.has(`${edge.from} -> ${edge.to}`)) return !edge.typeOnly;
    return !ALLOWED[from].includes(to);
  }).map((edge) => `${edge.from} -> ${edge.to}`);
  expect(violations).toEqual([]);
});

it('keeps the writable table store inside app/', () => {
  const leaks = all.filter((edge) => edge.to === 'src/app/gameStore.ts' && layerOf(edge.from) !== 'app'
    && edge.names.some((name) => name !== 'useGameView')).map((edge) => `${edge.from}: ${edge.names.join(', ')}`);
  expect(leaks).toEqual([]);
});

it('keeps the browser equity worker transport out of Node-side code', () => {
  const loaded = all.filter((edge) => BROWSER_ONLY.has(edge.to) && !BROWSER_ONLY.has(edge.from)).map((edge) => `${edge.from} -> ${edge.to}`);
  expect(loaded).toEqual([]);
});

it('keeps the bot action chooser out of grading and public inference', () => {
  const chooser = all.filter((edge) => edge.to === 'src/bots/botDecision.ts' && !['app', 'bots'].includes(layerOf(edge.from)));
  expect(chooser).toEqual([]);
});
