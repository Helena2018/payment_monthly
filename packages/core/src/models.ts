/**
 * models.ts — 领域模型定义（TypeScript 侧权威声明）
 *
 * 架构决策 ADR-003：单一真相源 = 事件账本（ledger）。
 *   MonthlyBudget / FixedExpense / SavingsGoal / DailyTransaction 是唯一持久化的实体；
 *   所有派生指标（可支配余额、每日额度、节奏健康度…）都**不落库**，由 engine.ts 纯函数重算。
 *   好处：① 离线端与后端可各自重算并互相校验；② 任何一天的历史都能被「重放」还原；
 *         ③ 修一笔历史交易不需要迁移派生数据，也不会产生不一致。
 *
 * 对应后端 Pydantic 模型见 backend/budget_app/models.py（字段一一镜像）。
 * 对应 JSON Schema 契约见 schemas/budget.schema.json。
 */

import { Cents } from './money';
import { ISODate, ISOMonth } from './calendar';

export type UUID = string;

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

/** 固定支出的类型。注意：存款不在这里，它由独立的 SavingsGoal 承载（ADR-004）。 */
export type FixedExpenseKind = 'bill' | 'debt' | 'subscription';

/** reserved = 已从未分配资金中锁定；paid = 已实际扣款；skipped = 本月跳过一次（释放回可支配）。 */
export type FixedExpenseStatus = 'reserved' | 'paid' | 'skipped';

export type SavingsMethod = 'fixed' | 'percent';
export type SavingsStatus = 'planned' | 'transferred' | 'skipped';

/** 记账时的二元标记，作用于「消费性质统计」，不改变主预算扣减。 */
export type Necessity = 'necessary' | 'optional' | 'unclassified';

/** flex = 计入弹性池；off_budget = 预算外（大额专项，需用户显式确认，带审计原因）。 */
export type TransactionScope = 'flex' | 'off_budget';

export type TransactionStatus = 'pending' | 'settled' | 'voided';

export type BudgetState = 'onboarding' | 'healthy' | 'watch' | 'smoothed' | 'overdrawn';

// ---------------------------------------------------------------------------
// 实体
// ---------------------------------------------------------------------------

/** 月度总预算：一个自然月一条。 */
export interface MonthlyBudget {
  id: UUID;
  /** 'YYYY-MM'，业务主键的一部分（userId + month 唯一）。 */
  month: ISOMonth;
  /** 本月可用收入（税后到手），整数分。0 = 尚未填收入（onboarding）。 */
  incomeCents: Cents;
  /** 发薪日，1-31 或 'month_end'。用于「收入未到账」态与提醒。 */
  payday: number | 'month_end';
  /** 上月结转：正 = 结余滚入本月；负 = 上月透支从本月扣减。 */
  carryoverCents: Cents;
  /** 用户备注（可选）。 */
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 固定必用支出 / 账单 / 贷款 / 订阅。
 *
 * 核心机制（ADR-005）：estimatedCents 与 actualCents 分离。
 *  - estimatedCents：月初用于「预留」的金额，保证房租不会被日常消费花掉。
 *  - actualCents：出账后的真实金额，浮动账单的差额自动回冲弹性池。
 */
export interface FixedExpense {
  id: UUID;
  budgetId: UUID;
  name: string;
  kind: FixedExpenseKind;
  estimatedCents: Cents;
  actualCents: Cents | null;
  /** 每月到期日：1-31，或 'month_end'。超出当月天数会被夹到月末。 */
  dueDay: number | 'month_end';
  /** 自动扣款：到期日由系统直接标记 paid，无需用户操作。 */
  autoDebit: boolean;
  status: FixedExpenseStatus;
  reservedAt: ISODate;
  paidAt: ISODate | null;
  active: boolean;
}

/** 月度存款目标。支持固定金额或收入百分比（percent 在引擎里折算成固定分）。 */
export interface SavingsGoal {
  id: UUID;
  budgetId: UUID;
  name: string;
  method: SavingsMethod;
  /** method='fixed' 时使用。 */
  targetCents: Cents;
  /** method='percent' 时使用，0-100（如 12.5 表示 12.5%）。 */
  percent: number | null;
  autoTransferDay: number | 'month_end';
  transferredCents: Cents;
  status: SavingsStatus;
}

/**
 * 日常变动开销（一笔账）。
 *
 * 关键字段说明：
 *  - localDate：端侧写入时确定的「本地自然日」，后端不做时区推断（ADR-002）。
 *  - idempotencyKey：离线补传去重键，重复上报必须幂等。
 *  - isBigTicket / amortize：大额平摊的两个开关（ADR-006，见 reschedule.ts）。
 *  - version：乐观并发控制。
 */
export interface DailyTransaction {
  id: UUID;
  budgetId: UUID;
  /** 正数 = 支出；负数 = 退款 / 撤销（会自动回冲余额）。 */
  amountCents: Cents;
  occurredAt: string;
  localDate: ISODate;
  necessity: Necessity;
  tags: string[];
  note?: string;
  scope: TransactionScope;
  status: TransactionStatus;
  /** 是否被判定为大额（单笔 ≥ bigTicketRatio × 日基线）。 */
  isBigTicket: boolean;
  /** 是否参与「节奏口径」的跨日平摊；false = 全额计入当日节奏。 */
  amortize: boolean;
  /** scope='off_budget' 时的审计原因，必填。 */
  offBudgetReason?: string;
  idempotencyKey: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

// ---------------------------------------------------------------------------
// 引擎配置
// ---------------------------------------------------------------------------

/** 引擎参数：全部可下发（remote config），便于灰度调整产品策略而不发版。 */
export interface EngineConfig {
  /** 保底比例：日额度不会被压到低于 floorRatio × 日基线，防「破罐子」心态。默认 0.6。 */
  floorRatio: number;
  /** 大额判定倍数：单笔 ≥ bigTicketRatio × 日基线 即视为大额。默认 2.0。 */
  bigTicketRatio: number;
  /** 节奏容忍度：消耗进度 − 时间进度 > 该值即触发「花太快」。默认 0.08。 */
  paceTolerance: number;
  /** 月末结余处理：结转 / 转储蓄 / 清零。默认 carry。 */
  carryoverPolicy: 'carry' | 'to_savings' | 'reset';
  /** 超支默认补救策略。默认 deduct_next_month。 */
  defaultOverspendPolicy: 'deduct_next_month' | 'borrow_from_savings' | 'off_budget';
  /** 内部一律 floor（保守），展示层可四舍五入。 */
  rounding: 'floor' | 'round';
}

export const DEFAULT_CONFIG: EngineConfig = {
  floorRatio: 0.6,
  bigTicketRatio: 2.0,
  paceTolerance: 0.08,
  carryoverPolicy: 'carry',
  defaultOverspendPolicy: 'deduct_next_month',
  rounding: 'floor',
};

/** 一次快照计算的完整输入（纯函数入参，可直接序列化进 golden fixtures）。 */
export interface SnapshotInput {
  budget: MonthlyBudget;
  fixedExpenses: readonly FixedExpense[];
  savingsGoals: readonly SavingsGoal[];
  transactions: readonly DailyTransaction[];
  /** 计算基准日（本地自然日）。测试可注入，生产取设备/服务端当日。 */
  today: ISODate;
  config?: Partial<EngineConfig>;
}

export function resolveConfig(override?: Partial<EngineConfig>): EngineConfig {
  return { ...DEFAULT_CONFIG, ...(override ?? {}) };
}

// ---------------------------------------------------------------------------
// 运行时校验（零依赖手写，规则与后端 Pydantic 保持一致）
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message: string, readonly field: string) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('must be a non-empty string', field);
  }
  return value;
}

function requireCents(value: unknown, field: string): Cents {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new ValidationError('must be an integer number of cents', field);
  }
  return value;
}

function requireNonNegativeCents(value: unknown, field: string): Cents {
  const c = requireCents(value, field);
  if (c < 0) throw new ValidationError('must be >= 0', field);
  return c;
}

function requireDueDay(value: unknown, field: string): number | 'month_end' {
  if (value === 'month_end') return value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 31) {
    throw new ValidationError('must be an integer 1-31 or "month_end"', field);
  }
  return value;
}

export function validateMonthlyBudget(b: MonthlyBudget): MonthlyBudget {
  requireString(b.id, 'MonthlyBudget.id');
  requireString(b.month, 'MonthlyBudget.month');
  requireNonNegativeCents(b.incomeCents, 'MonthlyBudget.incomeCents');
  requireDueDay(b.payday, 'MonthlyBudget.payday');
  requireCents(b.carryoverCents, 'MonthlyBudget.carryoverCents');
  return b;
}

export function validateFixedExpense(f: FixedExpense): FixedExpense {
  requireString(f.id, 'FixedExpense.id');
  requireString(f.budgetId, 'FixedExpense.budgetId');
  requireString(f.name, 'FixedExpense.name');
  if (!['bill', 'debt', 'subscription'].includes(f.kind)) {
    throw new ValidationError(`unknown kind "${f.kind}"`, 'FixedExpense.kind');
  }
  requireNonNegativeCents(f.estimatedCents, 'FixedExpense.estimatedCents');
  if (f.actualCents !== null) requireNonNegativeCents(f.actualCents, 'FixedExpense.actualCents');
  requireDueDay(f.dueDay, 'FixedExpense.dueDay');
  if (!['reserved', 'paid', 'skipped'].includes(f.status)) {
    throw new ValidationError(`unknown status "${f.status}"`, 'FixedExpense.status');
  }
  return f;
}

export function validateSavingsGoal(g: SavingsGoal): SavingsGoal {
  requireString(g.id, 'SavingsGoal.id');
  requireString(g.budgetId, 'SavingsGoal.budgetId');
  requireNonNegativeCents(g.targetCents, 'SavingsGoal.targetCents');
  if (g.method === 'percent') {
    if (typeof g.percent !== 'number' || g.percent < 0 || g.percent > 100) {
      throw new ValidationError('percent must be 0-100 when method="percent"', 'SavingsGoal.percent');
    }
  }
  requireDueDay(g.autoTransferDay, 'SavingsGoal.autoTransferDay');
  requireNonNegativeCents(g.transferredCents, 'SavingsGoal.transferredCents');
  return g;
}

export function validateTransaction(t: DailyTransaction): DailyTransaction {
  requireString(t.id, 'DailyTransaction.id');
  requireString(t.budgetId, 'DailyTransaction.budgetId');
  requireCents(t.amountCents, 'DailyTransaction.amountCents');
  requireString(t.localDate, 'DailyTransaction.localDate');
  if (!['necessary', 'optional', 'unclassified'].includes(t.necessity)) {
    throw new ValidationError(`unknown necessity "${t.necessity}"`, 'DailyTransaction.necessity');
  }
  if (!['flex', 'off_budget'].includes(t.scope)) {
    throw new ValidationError(`unknown scope "${t.scope}"`, 'DailyTransaction.scope');
  }
  if (t.scope === 'off_budget' && !t.offBudgetReason) {
    throw new ValidationError(
      'offBudgetReason is required when scope="off_budget"',
      'DailyTransaction',
    );
  }
  if (!['pending', 'settled', 'voided'].includes(t.status)) {
    throw new ValidationError(`unknown status "${t.status}"`, 'DailyTransaction.status');
  }
  requireString(t.idempotencyKey, 'DailyTransaction.idempotencyKey');
  return t;
}

export function validateSnapshotInput(input: SnapshotInput): SnapshotInput {
  validateMonthlyBudget(input.budget);
  input.fixedExpenses.forEach(validateFixedExpense);
  input.savingsGoals.forEach(validateSavingsGoal);
  input.transactions.forEach(validateTransaction);
  return input;
}

/** 离线补传去重：同一 idempotencyKey 只保留第一次出现的记录。 */
export function dedupeByIdempotencyKey(
  transactions: readonly DailyTransaction[],
): DailyTransaction[] {
  const seen = new Set<string>();
  const out: DailyTransaction[] = [];
  for (const t of transactions) {
    if (seen.has(t.idempotencyKey)) continue;
    seen.add(t.idempotencyKey);
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 工厂函数（供 UI 层与测试构造合法实体，避免手写字段遗漏）
// ---------------------------------------------------------------------------

export function nowISO(): string {
  return new Date().toISOString();
}

export function makeBudget(params: {
  id: UUID;
  month: ISOMonth;
  incomeCents: Cents;
  payday?: number | 'month_end';
  carryoverCents?: Cents;
  note?: string;
}): MonthlyBudget {
  const now = nowISO();
  return {
    id: params.id,
    month: params.month,
    incomeCents: params.incomeCents,
    payday: params.payday ?? 'month_end',
    carryoverCents: params.carryoverCents ?? 0,
    note: params.note,
    createdAt: now,
    updatedAt: now,
  };
}

export function makeFixedExpense(params: {
  id: UUID;
  budgetId: UUID;
  name: string;
  kind?: FixedExpenseKind;
  estimatedCents: Cents;
  actualCents?: Cents | null;
  dueDay: number | 'month_end';
  autoDebit?: boolean;
  status?: FixedExpenseStatus;
  reservedAt: ISODate;
  paidAt?: ISODate | null;
  active?: boolean;
}): FixedExpense {
  return {
    id: params.id,
    budgetId: params.budgetId,
    name: params.name,
    kind: params.kind ?? 'bill',
    estimatedCents: params.estimatedCents,
    actualCents: params.actualCents ?? null,
    dueDay: params.dueDay,
    autoDebit: params.autoDebit ?? false,
    status: params.status ?? 'reserved',
    reservedAt: params.reservedAt,
    paidAt: params.paidAt ?? null,
    active: params.active ?? true,
  };
}

export function makeSavingsGoal(params: {
  id: UUID;
  budgetId: UUID;
  name?: string;
  method?: SavingsMethod;
  targetCents?: Cents;
  percent?: number | null;
  autoTransferDay?: number | 'month_end';
  transferredCents?: Cents;
  status?: SavingsStatus;
}): SavingsGoal {
  return {
    id: params.id,
    budgetId: params.budgetId,
    name: params.name ?? '月度储蓄',
    method: params.method ?? 'fixed',
    targetCents: params.targetCents ?? 0,
    percent: params.percent ?? null,
    autoTransferDay: params.autoTransferDay ?? 1,
    transferredCents: params.transferredCents ?? 0,
    status: params.status ?? 'planned',
  };
}

export function makeTransaction(params: {
  id: UUID;
  budgetId: UUID;
  amountCents: Cents;
  localDate: ISODate;
  necessity?: Necessity;
  tags?: string[];
  note?: string;
  scope?: TransactionScope;
  offBudgetReason?: string;
  status?: TransactionStatus;
  isBigTicket?: boolean;
  amortize?: boolean;
  idempotencyKey?: string;
}): DailyTransaction {
  const now = nowISO();
  return {
    id: params.id,
    budgetId: params.budgetId,
    amountCents: params.amountCents,
    occurredAt: now,
    localDate: params.localDate,
    necessity: params.necessity ?? 'unclassified',
    tags: params.tags ?? [],
    note: params.note,
    scope: params.scope ?? 'flex',
    status: params.status ?? 'settled',
    isBigTicket: params.isBigTicket ?? false,
    amortize: params.amortize ?? true,
    offBudgetReason: params.offBudgetReason,
    idempotencyKey: params.idempotencyKey ?? params.id,
    version: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}
