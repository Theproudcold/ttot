/**
 * 自定义植被指数公式。
 *
 * 竞品（如 QGIS CropSense）提供"自定义公式构建器"，本模块补齐这一能力。
 *
 * **安全前提**：绝不用 `eval` / `new Function`。公式来自用户输入，
 * 一旦走了 JS 求值就等于把任意代码执行权交出去。这里实现一个小型递归下降解析器，
 * 语法严格限定为「数字、白名单波段名、+ - * / ^、括号、一元正负号」，
 * 并限制表达式长度与嵌套深度。
 *
 * 约定：任一参与运算的波段取不到值（缺失/无值）时结果为 null，
 * 而不是 0——0 是合法指数值（裸土），两者混淆会让后续分级把"无数据"当成"无植被"。
 */

import { isValidRasterSample } from './rasterPreview';
import {
  SPECTRAL_BAND_ROLE_LABELS,
  type SpectralBandRole,
  type VegetationIndexRaster,
} from './vegetationIndex';

/** 公式长度上限，防止病态输入 */
export const MAX_CUSTOM_INDEX_LENGTH = 500;
/** 括号/一元运算嵌套深度上限，防止递归爆栈 */
export const MAX_CUSTOM_INDEX_DEPTH = 64;
/** 除法分母保护阈值 */
const DIVISION_EPSILON = 1e-10;
/** 允许出现在公式里的波段名（大小写不敏感） */
const VARIABLE_NAMES: readonly SpectralBandRole[] = ['blue', 'green', 'red', 'redEdge', 'nir'];

export type CustomIndexError = {
  message: string;
  /** 出错位置（公式中的 0 基下标） */
  position: number;
};

export type CompiledCustomIndex = {
  source: string;
  /** 公式引用到的波段（去重，按标准顺序） */
  requiredBands: SpectralBandRole[];
  /** 求值；无法计算时返回 null */
  evaluate: (bands: Partial<Record<SpectralBandRole, number>>) => number | null;
};

export type CompileCustomIndexResult =
  | { ok: true; index: CompiledCustomIndex }
  | { ok: false; errors: CustomIndexError[] };

type AstNode =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; role: SpectralBandRole }
  | { kind: 'unary'; operator: '-' | '+'; operand: AstNode }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/' | '^'; left: AstNode; right: AstNode };

type Token =
  | { kind: 'number'; value: number; position: number }
  | { kind: 'identifier'; name: string; position: number }
  | { kind: 'operator'; operator: '+' | '-' | '*' | '/' | '^'; position: number }
  | { kind: 'paren'; paren: '(' | ')'; position: number }
  | { kind: 'end'; position: number };

class FormulaError extends Error {
  position: number;

  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1;
      continue;
    }

    if (isDigit(char) || (char === '.' && isDigit(source[index + 1] ?? ''))) {
      const start = index;
      let seenDot = false;
      let seenExponent = false;

      while (index < source.length) {
        const current = source[index];

        if (isDigit(current)) {
          index += 1;
          continue;
        }

        if (current === '.' && !seenDot && !seenExponent) {
          seenDot = true;
          index += 1;
          continue;
        }

        if ((current === 'e' || current === 'E') && !seenExponent && index > start) {
          seenExponent = true;
          index += 1;

          if (source[index] === '+' || source[index] === '-') {
            index += 1;
          }

          continue;
        }

        break;
      }

      const text = source.slice(start, index);
      const value = Number(text);

      if (!Number.isFinite(value)) {
        throw new FormulaError(`无法识别的数字「${text}」`, start);
      }

      tokens.push({ kind: 'number', value, position: start });
      continue;
    }

    if (isIdentifierStart(char)) {
      const start = index;

      while (index < source.length && isIdentifierPart(source[index])) {
        index += 1;
      }

      tokens.push({ kind: 'identifier', name: source.slice(start, index), position: start });
      continue;
    }

    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '^') {
      tokens.push({ kind: 'operator', operator: char, position: index });
      index += 1;
      continue;
    }

    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', paren: char, position: index });
      index += 1;
      continue;
    }

    throw new FormulaError(`不支持的字符「${char}」`, index);
  }

  tokens.push({ kind: 'end', position: source.length });
  return tokens;
}

/** 把标识符解析为波段角色（大小写不敏感） */
export function resolveVariableRole(name: string): SpectralBandRole | null {
  const normalized = name.toLowerCase();

  for (const role of VARIABLE_NAMES) {
    if (role.toLowerCase() === normalized) {
      return role;
    }
  }

  return null;
}

type ParserState = {
  tokens: Token[];
  cursor: number;
  depth: number;
};

function peek(state: ParserState): Token {
  return state.tokens[state.cursor];
}

function next(state: ParserState): Token {
  const token = state.tokens[state.cursor];
  state.cursor += 1;
  return token;
}

function enterDepth(state: ParserState, position: number): void {
  state.depth += 1;

  if (state.depth > MAX_CUSTOM_INDEX_DEPTH) {
    throw new FormulaError(`公式嵌套过深（上限 ${MAX_CUSTOM_INDEX_DEPTH} 层）`, position);
  }
}

function parseExpression(state: ParserState): AstNode {
  let left = parseTerm(state);

  for (;;) {
    const token = peek(state);

    if (token.kind === 'operator' && (token.operator === '+' || token.operator === '-')) {
      next(state);
      const right = parseTerm(state);
      left = { kind: 'binary', operator: token.operator, left, right };
      continue;
    }

    return left;
  }
}

function parseTerm(state: ParserState): AstNode {
  let left = parseUnary(state);

  for (;;) {
    const token = peek(state);

    if (token.kind === 'operator' && (token.operator === '*' || token.operator === '/')) {
      next(state);
      const right = parseUnary(state);
      left = { kind: 'binary', operator: token.operator, left, right };
      continue;
    }

    return left;
  }
}

function parseUnary(state: ParserState): AstNode {
  const token = peek(state);

  if (token.kind === 'operator' && (token.operator === '-' || token.operator === '+')) {
    next(state);
    enterDepth(state, token.position);
    const operand = parseUnary(state);
    state.depth -= 1;
    return { kind: 'unary', operator: token.operator, operand };
  }

  return parsePower(state);
}

function parsePower(state: ParserState): AstNode {
  const base = parsePrimary(state);
  const token = peek(state);

  if (token.kind === 'operator' && token.operator === '^') {
    next(state);
    enterDepth(state, token.position);
    // 幂运算右结合：2^3^2 = 2^(3^2)
    const exponent = parseUnary(state);
    state.depth -= 1;
    return { kind: 'binary', operator: '^', left: base, right: exponent };
  }

  return base;
}

function parsePrimary(state: ParserState): AstNode {
  const token = next(state);

  if (token.kind === 'number') {
    return { kind: 'number', value: token.value };
  }

  if (token.kind === 'identifier') {
    const role = resolveVariableRole(token.name);

    if (!role) {
      const valid = VARIABLE_NAMES.map(
        (name) => `${name}（${SPECTRAL_BAND_ROLE_LABELS[name]}）`,
      ).join('、');
      throw new FormulaError(`未知波段「${token.name}」，可用：${valid}`, token.position);
    }

    return { kind: 'variable', role };
  }

  if (token.kind === 'paren' && token.paren === '(') {
    enterDepth(state, token.position);
    const inner = parseExpression(state);
    const closing = next(state);

    if (closing.kind !== 'paren' || closing.paren !== ')') {
      throw new FormulaError('括号没有闭合', closing.position);
    }

    state.depth -= 1;
    return inner;
  }

  if (token.kind === 'end') {
    throw new FormulaError('公式不完整', token.position);
  }

  throw new FormulaError('表达式缺少操作数', token.position);
}

function collectRequiredBands(node: AstNode, sink: Set<SpectralBandRole>): void {
  switch (node.kind) {
    case 'variable':
      sink.add(node.role);
      return;
    case 'unary':
      collectRequiredBands(node.operand, sink);
      return;
    case 'binary':
      collectRequiredBands(node.left, sink);
      collectRequiredBands(node.right, sink);
      return;
    default:
      return;
  }
}

function evaluateNode(node: AstNode, bands: Partial<Record<SpectralBandRole, number>>): number | null {
  switch (node.kind) {
    case 'number':
      return node.value;

    case 'variable': {
      const value = bands[node.role];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    case 'unary': {
      const operand = evaluateNode(node.operand, bands);
      if (operand === null) return null;
      return node.operator === '-' ? -operand : operand;
    }

    case 'binary': {
      const left = evaluateNode(node.left, bands);
      if (left === null) return null;
      const right = evaluateNode(node.right, bands);
      if (right === null) return null;

      let result: number;
      switch (node.operator) {
        case '+':
          result = left + right;
          break;
        case '-':
          result = left - right;
          break;
        case '*':
          result = left * right;
          break;
        case '/':
          if (Math.abs(right) < DIVISION_EPSILON) return null;
          result = left / right;
          break;
        case '^':
          result = left ** right;
          break;
      }

      return Number.isFinite(result) ? result : null;
    }
  }
}

/**
 * 编译公式。返回结构化错误（含位置），便于界面直接指出问题。
 */
export function compileCustomIndex(source: string): CompileCustomIndexResult {
  const trimmed = source.trim();

  if (trimmed.length === 0) {
    return { ok: false, errors: [{ message: '公式不能为空', position: 0 }] };
  }

  if (trimmed.length > MAX_CUSTOM_INDEX_LENGTH) {
    return {
      ok: false,
      errors: [{ message: `公式过长（上限 ${MAX_CUSTOM_INDEX_LENGTH} 个字符）`, position: 0 }],
    };
  }

  try {
    const tokens = tokenize(trimmed);
    const state: ParserState = { tokens, cursor: 0, depth: 0 };
    const ast = parseExpression(state);
    const tail = peek(state);

    if (tail.kind !== 'end') {
      throw new FormulaError('表达式尾部有多余内容', tail.position);
    }

    const required = new Set<SpectralBandRole>();
    collectRequiredBands(ast, required);

    const requiredBands = VARIABLE_NAMES.filter((role) => required.has(role));

    return {
      ok: true,
      index: {
        source: trimmed,
        requiredBands,
        evaluate: (bands) => evaluateNode(ast, bands),
      },
    };
  } catch (error) {
    if (error instanceof FormulaError) {
      return { ok: false, errors: [{ message: error.message, position: error.position }] };
    }

    return { ok: false, errors: [{ message: '公式解析失败', position: 0 }] };
  }
}

/** 自定义指数的栅格结果；与内置指数同构，只是记录公式而非枚举 id */
export type CustomIndexRaster = Omit<VegetationIndexRaster, 'index'> & { source: string };

/**
 * 计算整幅自定义指数栅格。
 * 缺波段属于调用方错误（编译结果已声明 requiredBands），直接抛错。
 */
export function computeCustomIndexRaster(input: {
  compiled: CompiledCustomIndex;
  width: number;
  height: number;
  bands: Partial<Record<SpectralBandRole, ArrayLike<number>>>;
  noDataValue?: number | null;
}): CustomIndexRaster {
  const { compiled, width, height, bands, noDataValue = null } = input;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('计算自定义指数需要合法的影像宽高');
  }

  const pixelCount = Math.floor(width) * Math.floor(height);

  for (const role of compiled.requiredBands) {
    const band = bands[role];

    if (!band) {
      throw new Error(`自定义公式需要「${SPECTRAL_BAND_ROLE_LABELS[role]}」波段`);
    }

    if (band.length !== pixelCount) {
      throw new Error(`自定义公式的「${SPECTRAL_BAND_ROLE_LABELS[role]}」波段长度与影像尺寸不一致`);
    }
  }

  const data = new Float32Array(pixelCount);
  const samples: Partial<Record<SpectralBandRole, number>> = {};
  let validCount = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    let usable = true;

    for (const role of compiled.requiredBands) {
      const value = bands[role]![pixel] as number;

      if (!isValidRasterSample(value, noDataValue)) {
        usable = false;
        break;
      }

      samples[role] = value;
    }

    const result = usable ? compiled.evaluate(samples) : null;

    if (result === null) {
      data[pixel] = Number.NaN;
      continue;
    }

    data[pixel] = result;
    validCount += 1;
    min = Math.min(min, result);
    max = Math.max(max, result);
  }

  return {
    source: compiled.source,
    width: Math.floor(width),
    height: Math.floor(height),
    data,
    validCount,
    totalCount: pixelCount,
    range: validCount > 0 ? { min, max } : null,
  };
}
