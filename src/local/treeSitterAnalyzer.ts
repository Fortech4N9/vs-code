import * as path from 'path';
import type { AnalysisEntry, PatternType, Severity } from '../types';

// ── local type aliases for web-tree-sitter (loaded at runtime) ──

interface TSPoint { row: number; column: number }

interface TSNode {
  type: string;
  text: string;
  startPosition: TSPoint;
  endPosition: TSPoint;
  childCount: number;
  children: TSNode[];
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
  parent: TSNode | null;
  descendantsOfType(types: string | string[]): TSNode[];
}

interface TSTree {
  rootNode: TSNode;
  delete(): void;
}

interface TSParser {
  setLanguage(lang: unknown): void;
  parse(input: string): TSTree | null;
  delete(): void;
}

// ── singleton state ─────────────────────────────────────────

let parser: TSParser | null = null;
let initPromise: Promise<void> | null = null;

export function isReady(): boolean {
  return parser !== null;
}

export function initTreeSitter(extensionPath: string): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const wts = require('web-tree-sitter');
    const ParserClass = wts.Parser ?? wts.default?.Parser ?? wts;

    const distDir = path.join(extensionPath, 'dist');
    await ParserClass.init({
      locateFile: (file: string) => path.join(distDir, file),
    });

    const p: TSParser = new ParserClass();
    const LangClass = wts.Language ?? wts.default?.Language ?? ParserClass.Language;
    const lang = await LangClass.load(path.join(distDir, 'tree-sitter-c.wasm'));
    p.setLanguage(lang);
    parser = p;
  })();

  return initPromise;
}

// ── public API ──────────────────────────────────────────────

export function analyzeLocally(source: string, fileName = 'input.c'): AnalysisEntry[] {
  if (!parser) throw new Error('Tree-sitter not initialized');
  const tree = parser.parse(source);
  if (!tree) return [];

  const ctx: Ctx = { entries: [], seq: 0, fileName };
  walk(tree.rootNode, ctx, '<global>', 0, new Set());
  tree.delete();
  return deduplicate(ctx.entries);
}

// ── AST walk ────────────────────────────────────────────────

interface Ctx {
  entries: AnalysisEntry[];
  seq: number;
  fileName: string;
}

function walk(
  node: TSNode,
  ctx: Ctx,
  funcName: string,
  loopDepth: number,
  loopVars: Set<string>,
): void {
  if (node.type === 'function_definition') {
    const name = funcDeclName(node.childForFieldName('declarator'));
    const body = node.childForFieldName('body');
    if (body) walk(body, ctx, name || funcName, 0, new Set());
    return;
  }

  if (node.type === 'for_statement') {
    const v = extractForVar(node);
    const vars = new Set(loopVars);
    if (v) vars.add(v);
    const body = node.childForFieldName('body');
    if (body) {
      collectSubscripts(body, ctx, funcName, loopDepth + 1, vars);
      walk(body, ctx, funcName, loopDepth + 1, vars);
    }
    return;
  }

  if (node.type === 'while_statement' || node.type === 'do_statement') {
    const body = node.childForFieldName('body')
      || node.namedChildren.find((c) => c.type === 'compound_statement');
    if (body) {
      collectSubscripts(body, ctx, funcName, loopDepth + 1, loopVars);
      walk(body, ctx, funcName, loopDepth + 1, loopVars);
    }
    return;
  }

  for (const child of node.namedChildren) {
    walk(child, ctx, funcName, loopDepth, loopVars);
  }
}

// ── find array accesses ─────────────────────────────────────

function collectSubscripts(
  root: TSNode,
  ctx: Ctx,
  funcName: string,
  depth: number,
  loopVars: Set<string>,
): void {
  if (root.type === 'subscript_expression') {
    processSubscript(root, ctx, funcName, depth, loopVars);
    return;
  }
  for (const child of root.namedChildren) {
    collectSubscripts(child, ctx, funcName, depth, loopVars);
  }
}

function processSubscript(
  node: TSNode,
  ctx: Ctx,
  funcName: string,
  loopDepth: number,
  loopVars: Set<string>,
): void {
  const argNode = node.childForFieldName('argument');
  const idxNode = node.childForFieldName('index');
  if (!argNode || !idxNode) return;

  const baseSymbol = argNode.text;
  const indexExpr = idxNode.text;
  const line = node.startPosition.row + 1;
  const col = node.startPosition.column + 1;

  const { pattern, stride, suggestion } = classify(idxNode, loopVars, baseSymbol);
  const fillFactor = estimateFill(pattern, stride);
  const missRate = Math.max(0, Math.min(1, 1 - fillFactor));
  const accessCount = estimateAccesses(loopDepth);
  const hitCount = Math.round(accessCount * fillFactor);
  const missCount = accessCount - hitCount;
  const severity = toSeverity(missRate);

  ctx.entries.push({
    id: `local_${++ctx.seq}`,
    source_line: line,
    source_column: col,
    base_symbol: baseSymbol,
    index_expr: indexExpr,
    instruction: node.text,
    pattern_type: pattern,
    stride,
    element_size: 8,
    fill_factor: fillFactor,
    access_count: accessCount,
    hit_count: hitCount,
    miss_count: missCount,
    miss_rate: missRate,
    cache_line_utilization: fillFactor,
    loop_depth: loopDepth,
    function_name: funcName,
    severity,
    suggestion,
  });
}

// ── pattern classification ──────────────────────────────────

interface Classification {
  pattern: PatternType;
  stride: number;
  suggestion: string;
}

function classify(idx: TSNode, vars: Set<string>, sym: string): Classification {
  if (idx.type === 'number_literal') {
    return { pattern: 'constant', stride: 0, suggestion: `\`${sym}\` — constant index, single cache line reused.` };
  }

  const ids = collectIds(idx);
  const usesVar = [...ids].some((v) => vars.has(v));

  if (!usesVar && vars.size > 0) {
    return { pattern: 'constant', stride: 0, suggestion: `\`${sym}\` — index independent of loop iterator.` };
  }

  if (hasSubscript(idx)) {
    return {
      pattern: 'gather_scatter', stride: -1,
      suggestion: `Indirect (gather/scatter) access on \`${sym}\`. Consider sorting the index array or restructuring data layout.`,
    };
  }

  if (idx.type === 'identifier' && vars.has(idx.text)) {
    return { pattern: 'unit_stride', stride: 1, suggestion: `Sequential access on \`${sym}\` — optimal cache utilization.` };
  }

  if (idx.type === 'binary_expression') {
    return classifyBinary(idx, vars, sym);
  }

  if (idx.type === 'unary_expression') {
    const inner = idx.namedChildren.find((c) => c.type === 'identifier');
    if (inner && vars.has(inner.text)) {
      return { pattern: 'unit_stride', stride: -1, suggestion: `Reverse sequential access on \`${sym}\` — still good cache utilization.` };
    }
  }

  if (idx.type === 'parenthesized_expression' && idx.namedChildren.length === 1) {
    return classify(idx.namedChildren[0], vars, sym);
  }

  if (usesVar) {
    return { pattern: 'random', stride: -1, suggestion: `Complex index on \`${sym}\` — may cause unpredictable cache behavior.` };
  }
  return { pattern: 'constant', stride: 0, suggestion: `\`${sym}\` — fixed index.` };
}

function classifyBinary(node: TSNode, vars: Set<string>, sym: string): Classification {
  const children = node.children.filter((c) => c.type !== '(' && c.type !== ')');
  if (children.length < 3) {
    return { pattern: 'random', stride: -1, suggestion: `Complex access on \`${sym}\`.` };
  }
  const [left, op, right] = children;
  const opText = op.text;

  if (opText === '+' || opText === '-') {
    const lVar = left.type === 'identifier' && vars.has(left.text);
    const rVar = right.type === 'identifier' && vars.has(right.text);
    const lConst = left.type === 'number_literal';
    const rConst = right.type === 'number_literal';
    if ((lVar && rConst) || (lConst && rVar)) {
      return { pattern: 'unit_stride', stride: 1, suggestion: `Sequential access with offset on \`${sym}\` — good cache utilization.` };
    }
    if (lVar && rVar) {
      return { pattern: 'random', stride: -1, suggestion: `Two loop variables in index of \`${sym}\` — unpredictable stride.` };
    }
  }

  if (opText === '*') {
    const lVar = left.type === 'identifier' && vars.has(left.text);
    const rVar = right.type === 'identifier' && vars.has(right.text);
    const lVal = left.type === 'number_literal' ? parseInt(left.text, 10) : NaN;
    const rVal = right.type === 'number_literal' ? parseInt(right.text, 10) : NaN;

    if (lVar && !isNaN(rVal) && rVal > 1) {
      return {
        pattern: 'non_unit_stride', stride: rVal,
        suggestion: `\`${sym}\` accessed with stride ${rVal} — only 1/${rVal} of each cache line used. Consider AoS→SoA transformation.`,
      };
    }
    if (rVar && !isNaN(lVal) && lVal > 1) {
      return {
        pattern: 'non_unit_stride', stride: lVal,
        suggestion: `\`${sym}\` accessed with stride ${lVal} — only 1/${lVal} of each cache line used. Consider data layout optimization.`,
      };
    }
    if (lVar && rVal === 1) return { pattern: 'unit_stride', stride: 1, suggestion: `Sequential access on \`${sym}\`.` };
    if (rVar && lVal === 1) return { pattern: 'unit_stride', stride: 1, suggestion: `Sequential access on \`${sym}\`.` };
  }

  if (opText === '/' || opText === '%') {
    return { pattern: 'random', stride: -1, suggestion: `\`${sym}\` index uses ${opText} — may fragment cache line usage.` };
  }

  if (opText === '>>' || opText === '<<') {
    const shift = right.type === 'number_literal' ? parseInt(right.text, 10) : NaN;
    if (!isNaN(shift)) {
      const s = opText === '>>' ? Math.pow(2, shift) : 1;
      const p: PatternType = s > 1 ? 'non_unit_stride' : 'unit_stride';
      return { pattern: p, stride: s, suggestion: `\`${sym}\` — effective stride ~${s} via ${opText}.` };
    }
  }

  const usesVar = [...collectIds(node)].some((v) => vars.has(v));
  if (usesVar) {
    return { pattern: 'random', stride: -1, suggestion: `Complex computed index on \`${sym}\`.` };
  }
  return { pattern: 'constant', stride: 0, suggestion: `\`${sym}\` — constant within loop.` };
}

// ── helpers ─────────────────────────────────────────────────

function funcDeclName(node: TSNode | null): string {
  if (!node) return '';
  if (node.type === 'identifier') return node.text;
  if (node.type === 'function_declarator') {
    const d = node.childForFieldName('declarator');
    return d ? funcDeclName(d) : (node.namedChildren[0]?.text ?? '');
  }
  if (node.type === 'pointer_declarator') {
    for (const c of node.namedChildren) {
      const n = funcDeclName(c);
      if (n) return n;
    }
  }
  return '';
}

function extractForVar(forNode: TSNode): string | null {
  const init = forNode.childForFieldName('initializer');
  if (!init) return null;

  if (init.type === 'declaration') {
    for (const c of init.namedChildren) {
      if (c.type === 'init_declarator') {
        const d = c.childForFieldName('declarator');
        if (d?.type === 'identifier') return d.text;
      }
    }
  }

  if (init.type === 'expression_statement') {
    const expr = init.namedChildren[0];
    if (expr?.type === 'assignment_expression') {
      const left = expr.childForFieldName('left');
      if (left?.type === 'identifier') return left.text;
    }
  }

  return null;
}

function collectIds(node: TSNode): Set<string> {
  const out = new Set<string>();
  (function rec(n: TSNode) {
    if (n.type === 'identifier') out.add(n.text);
    for (const c of n.namedChildren) rec(c);
  })(node);
  return out;
}

function hasSubscript(node: TSNode): boolean {
  if (node.type === 'subscript_expression') return true;
  return node.namedChildren.some(hasSubscript);
}

function estimateFill(pattern: PatternType, stride: number): number {
  switch (pattern) {
    case 'unit_stride': return 1.0;
    case 'non_unit_stride': return stride > 0 ? Math.min(1, 1 / stride) : 0.25;
    case 'gather_scatter': return 0.18;
    case 'constant': return 1.0;
    case 'random': return 0.15;
  }
}

function estimateAccesses(loopDepth: number): number {
  return Math.pow(1024, Math.min(loopDepth, 3));
}

function toSeverity(missRate: number): Severity {
  if (missRate >= 0.5) return 'error';
  if (missRate >= 0.2) return 'warning';
  return 'info';
}

function deduplicate(entries: AnalysisEntry[]): AnalysisEntry[] {
  const map = new Map<string, AnalysisEntry>();
  for (const e of entries) {
    const key = `${e.source_line}:${e.base_symbol}:${e.index_expr}`;
    const prev = map.get(key);
    if (!prev || e.miss_rate > prev.miss_rate) map.set(key, e);
  }
  return [...map.values()].sort((a, b) => a.source_line - b.source_line);
}
