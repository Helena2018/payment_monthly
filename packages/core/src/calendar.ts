/**
 * calendar.ts — 纯日期工具，零依赖、时区安全。
 *
 * 架构决策 ADR-002：日期一律以「本地自然日字符串」(YYYY-MM-DD) 作为计算键。
 *  - 不把 `Date` 对象在业务层传来传去：`new Date()` 带时区，跨时区/夏令时会漂一天。
 *  - 端侧在交易写入时就把本地自然日算好写进 `localDate`（见 models.ts），
 *    后端不再做时区推断，只信任该字段 → 同步后「今天花了多少」不会变。
 *  - 内部用 Date.UTC 构造，避免本地时区与 DST 干扰。日差用 86,400,000 毫秒整除。
 */

import { Cents } from './money';

export type ISODate = string; // 'YYYY-MM-DD'
export type ISOMonth = string; // 'YYYY-MM'

const MS_PER_DAY = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export function parseISODate(date: ISODate): DateParts {
  const m = DATE_RE.exec(date);
  if (!m) throw new TypeError(`invalid ISODate: "${date}", expected YYYY-MM-DD`);
  const parts = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) {
    throw new RangeError(`invalid ISODate: "${date}"`);
  }
  return parts;
}

export function parseISOMonth(month: ISOMonth): { year: number; month: number } {
  const m = MONTH_RE.exec(month);
  if (!m) throw new TypeError(`invalid ISOMonth: "${month}", expected YYYY-MM`);
  const parts = { year: Number(m[1]), month: Number(m[2]) };
  if (parts.month < 1 || parts.month > 12) throw new RangeError(`invalid ISOMonth: "${month}"`);
  return parts;
}

export function toISODate(parts: DateParts): ISODate {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(
    parts.day,
  ).padStart(2, '0')}`;
}

export function monthOf(date: ISODate): ISOMonth {
  return date.slice(0, 7);
}

export function dayOfMonth(date: ISODate): number {
  return parseISODate(date).day;
}

/** 该月自然天数：28/29/30/31。 */
export function daysInMonth(month: ISOMonth): number {
  const { year, month: m } = parseISOMonth(month);
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

function epochDay(date: ISODate): number {
  const { year, month, day } = parseISODate(date);
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/** b - a，单位天。 */
export function diffDays(a: ISODate, b: ISODate): number {
  return epochDay(b) - epochDay(a);
}

export function addDays(date: ISODate, days: number): ISODate {
  const { year, month, day } = parseISODate(date);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return toISODate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/**
 * 「本月剩余天数（含今天）」—— 这是 Daily Safe-to-Spend 的分母。
 * 含今天是有意为之：用户早上打开 App 时，今天还没花出去的钱当然算可花。
 */
export function daysLeftInclusive(month: ISOMonth, today: ISODate): number {
  const total = daysInMonth(month);
  const dom = dayOfMonth(today);
  const left = total - dom + 1;
  return left < 0 ? 0 : left;
}

export function isSameMonth(date: ISODate, month: ISOMonth): boolean {
  return monthOf(date) === month;
}

/**
 * 把「每月 1-31 号 / 月末」的账单日解析成具体日期。
 * 边界：2 月 + 31 号 → 当月最后一天（2/28 或 2/29）；不做「提前到工作日」的偏移，
 * 因为国内账单多数按自然日扣款，偏移反而会让用户对不上账单。
 */
export function resolveDueDay(month: ISOMonth, dueDay: number | 'month_end'): ISODate {
  const total = daysInMonth(month);
  const day = dueDay === 'month_end' ? total : Math.min(Math.max(Math.trunc(dueDay), 1), total);
  const { year, month: m } = parseISOMonth(month);
  return toISODate({ year, month: m, day });
}

export function monthFromDate(date: ISODate): { first: ISODate; last: ISODate } {
  const month = monthOf(date);
  const total = daysInMonth(month);
  return { first: `${month}-01`, last: `${month}-${String(total).padStart(2, '0')}` };
}

/** 供未来 N 天排期使用：给出从 today 起的 N 个自然日。 */
export function dateRange(today: ISODate, days: number): ISODate[] {
  const out: ISODate[] = [];
  for (let i = 0; i < days; i++) out.push(addDays(today, i));
  return out;
}

/** 仅用于展示层：把分/天换算成「约 ¥x/天」的日均口径（不做业务计算）。 */
export function perDay(total: Cents, days: number): Cents {
  if (days <= 0) return 0;
  return Math.floor(total / days);
}
