/**
 * money.ts — 金额只允许用「整数分」表示。
 *
 * 架构决策 ADR-001：全系统金额一律使用整数分（Cents），禁止浮点数做金额运算。
 *  - JS/Python 的 float 无法精确表示 0.1，预算类 App 一旦出现 0.01 的漂移，
 *    UI 上「¥2,340」和明细求和就会对不上，直接摧毁用户信任。
 *  - TS 侧 number 在 2^53 以内是安全整数，个人月度预算量级远小于该上限。
 *  - 所有除法必须走 floorDiv / allocate，确保「分」不会凭空产生或消失。
 */

/** 整数分。¥1 = 100。 */
export type Cents = number;

export const CENTS_PER_YUAN = 100;

export function assertCents(value: number, name = 'cents'): Cents {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${String(value)}`);
  }
  if (!Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer number of cents, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  return value;
}

/** 向下取整除法（对负数同样向 -Infinity 取整，与 Python // 语义一致）。 */
export function floorDiv(numerator: Cents, denominator: number): Cents {
  assertCents(numerator, 'numerator');
  if (!Number.isInteger(denominator) || denominator === 0) {
    throw new RangeError(`denominator must be a non-zero integer, got ${denominator}`);
  }
  return Math.floor(numerator / denominator);
}

/** 四舍五入除法（银行家舍入会让用户困惑，这里用半上舍入，且两端实现保持一致）。 */
export function divRound(numerator: Cents, denominator: number): Cents {
  assertCents(numerator, 'numerator');
  if (!Number.isInteger(denominator) || denominator === 0) {
    throw new RangeError(`denominator must be a non-zero integer, got ${denominator}`);
  }
  return Math.sign(numerator) * Math.round(Math.abs(numerator) / Math.abs(denominator));
}

/**
 * 四舍五入（远离零方向），用于**跨语言一致性**场景。
 *
 * 为什么不用 Math.round / Python round()：
 *  - Python 的 round() 是「银行家舍入」（round-half-even），JS 的 Math.round 是「半上舍入」，
 *    两者在 x.5 处结果不同。黄金测试向量要在 TS 与 Python 两侧逐位相等，
 *    必须显式约定一个规则 —— 这里统一为「远离零」。
 */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError(`value must be finite, got ${value}`);
  if (value === 0) return 0;
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

export function sumCents(values: readonly Cents[]): Cents {
  let acc = 0;
  for (const v of values) acc += assertCents(v, 'value');
  return acc;
}

/**
 * 把 total 精确拆成 parts 份，保证 Σ结果 === total（最大余数法）。
 *
 * 用途：① 大额支出的「每日摊销额」数组；② 未来 N 天的额度排期。
 * 约定：余数优先分配给**靠前**的份额（即离今天更近的日子多拿 1 分），
 *       这样 today 的额度不会被低估，且结果是确定性的（可测试、可对账）。
 */
export function allocate(total: Cents, parts: number): Cents[] {
  assertCents(total, 'total');
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(`parts must be a positive integer, got ${parts}`);
  }
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / parts);
  const remainder = abs - base * parts;
  const out: Cents[] = new Array(parts).fill(base);
  for (let i = 0; i < remainder; i++) out[i] += 1;
  return out.map((v) => v * sign);
}

/** 展示用：分 → 「1,234.56」字符串（不带货币符号，由 UI 层决定符号与本地化）。 */
export function formatCents(cents: Cents, fractionDigits = 2): string {
  assertCents(cents, 'cents');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / CENTS_PER_YUAN);
  const frac = abs - yuan * CENTS_PER_YUAN;
  const grouped = yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fractionDigits === 0 ? `${sign}${grouped}` : `${sign}${grouped}.${frac.toString().padStart(2, '0')}`;
}

/** 用户输入「12.3」→ 1230 分；用整数化解析避免 parseFloat * 100 的精度陷阱。 */
export function fromYuanString(input: string): Cents {
  const trimmed = input.trim().replace(/,/g, '');
  const m = /^(-?)(\d*)(?:\.(\d{0,2}))?$/.exec(trimmed);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    throw new TypeError(`invalid yuan amount: "${input}"`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const yuanPart = m[2] === '' ? 0 : parseInt(m[2], 10);
  const fracPart = (m[3] ?? '').padEnd(2, '0');
  return sign * (yuanPart * CENTS_PER_YUAN + (fracPart === '' ? 0 : parseInt(fracPart, 10)));
}
