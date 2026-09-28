/**
 * reschedule.ts — 异常处理：大额超支后的额度平摊与「健康成长曲线」重建。
 *
 * 产品目标（ADR-008）：用户买了一台 ¥3,000 的电脑后，App 不能做两件蠢事：
 *   ① 撒谎——不告诉他真实余额还剩多少；
 *   ② 打击——把日额度从 ¥238 直接砸到 ¥95 并弹「你超支了」，让他从此不再打开 App。
 *
 * 解决方式 = 「真值 / 展示值」双口径 + 显式账单化缺口：
 *   realRemaining      = 真值，立刻扣除全额，永不撒谎（主数字用它）。
 *   safeToSpend        = 展示口径，最低于 floor（日基线 × floorRatio）保底，维持行动力。
 *   monthEndAdjustment = 保底模式下的累计缺口，显式记账并结转下月（诚实但不情绪化）。
 *   paceSpent          = 节奏口径，大额按日摊销，避免 AI 冤枉用户「花太快」。
 */

import { Cents, allocate, floorDiv, sumCents } from './money';
import { ISODate, resolveDueDay } from './calendar';
import {
  DailyTransaction,
  EngineConfig,
  FixedExpense,
  SavingsGoal,
  SnapshotInput,
  resolveConfig,
} from './models';
import { BudgetSnapshot, computeSnapshot } from './engine';

export type OverspendLevel = 'none' | 'minor' | 'severe' | 'critical';

export type OverspendOptionCode =
  | 'accept_smoothed'
  | 'borrow_from_savings'
  | 'mark_off_budget'
  | 'rebalance_fixed';

/** 给 UI 的「一个可执行的小选择」——每个选项都必须带出代价，不能只给安慰。 */
export interface OverspendOption {
  code: OverspendOptionCode;
  viable: boolean;
  labelKey: string;
  /** 采纳后：今日安全可花额度。 */
  resultingDailyCents: Cents;
  /** 采纳后：本月剩余可支配余额。 */
  resultingRemainingCents: Cents;
  /** 采纳后：需要由下月承担的缺口（负数）。 */
  resultingNextMonthCarryoverCents: Cents;
  costKey: string;
  costFacts: Record<string, number | string>;
}

export interface OverspendPlan {
  level: OverspendLevel;
  state: BudgetSnapshot['state'];
  daysLeft: number;
  remainingCents: Cents;
  /** 当前展示的日额度。 */
  currentDailyCents: Cents;
  /** 真值日均（详情页展示，用于解释「为什么建议额度比真实更低」）。 */
  requiredDailyCents: Cents;
  /** 说明账户里还有多少钱，但节奏上是什么水平。 */
  paceRatioPct: number;
  timeRatioPct: number;
  monthEndAdjustmentCents: Cents;
  shortfallCents: Cents;
  /** 未来 N 天的额度排期（含今天）。 */
  schedule: DailyAllowancePlan[];
  options: OverspendOption[];
}

export interface DailyAllowancePlan {
  date: ISODate;
  allowanceCents: Cents;
  /** 假设按额度花费后，当日结束时的真实剩余（可能为负 = 当月缺口）。 */
  remainingAfterCents: Cents;
  /** 该额度是否由 floor 保底（而非真值）。 */
  floorProtected: boolean;
}

export interface RecoveryContext {
  input: SnapshotInput;
  /** 触发本次重排的那笔交易 id（大额）。 */
  triggerTransactionId?: string;
  /** 可动用的储蓄余额（分）；无储蓄账户时传 0。 */
  savingsBorrowableCents?: Cents;
  /** 允许「本月跳过」的固定项 id（通常只有订阅，房租不在其中）。 */
  skippableFixedIds?: readonly string[];
  /** 排期天数，默认 7。 */
  horizonDays?: number;
}

// ---------------------------------------------------------------------------
// 1. 级别判定
// ---------------------------------------------------------------------------

export function classifyOverspendLevel(
  snapshot: BudgetSnapshot,
  config?: Partial<EngineConfig>,
): OverspendLevel {
  const cfg = resolveConfig(config);
  const s = snapshot;
  if (s.state === 'onboarding') return 'none';
  if (s.remainingCents <= 0) return 'critical';
  if (s.state === 'smoothed') return 'severe';
  if (s.paceGap > cfg.paceTolerance) return 'minor';
  if (s.safeToSpendCents > 0 && s.todaySpentCents > s.safeToSpendCents) return 'minor';
  return 'none';
}

// ---------------------------------------------------------------------------
// 2. 额度重排：把剩余额度均摊到未来每一天（SUM 精确，不产生 1 分漂移）
// ---------------------------------------------------------------------------

/**
 * 生成未来 horizon 天的「每日可花额度」排期。
 *
 * 两种模式：
 *  - 正常模式：shares = allocate(remaining, daysLeft)，即真值均摊。
 *    因为用的是「实时 remaining」，昨天的结余/超支天然滚进今天 —— 不需要额外的结转逻辑。
 *  - 保底模式（state='smoothed'）：每天固定给 floor，代价是 remainingAfter 逐渐转负，
 *    这就是 monthEndAdjustmentCents 的来源，会被结转进下月。
 *
 * allocate 使用最大余数法，保证 Σshares === remaining（偏差只可能是 0，不会是几分钱）。
 */
export function rescheduleDailyAllowances(
  snapshot: BudgetSnapshot,
  horizonDays = 7,
): DailyAllowancePlan[] {
  const s = snapshot;
  const horizon = Math.max(1, Math.min(horizonDays, s.daysLeft));
  const available = Math.max(s.remainingCents, 0);

  if (s.state === 'onboarding' || s.state === 'overdrawn') {
    return Array.from({ length: horizon }, (_, i) => ({
      date: shiftDate(s.today, i),
      allowanceCents: 0,
      remainingAfterCents: s.remainingCents,
      floorProtected: false,
    }));
  }

  const floorProtected = s.state === 'smoothed' && s.floorCents > 0;
  const shares = floorProtected
    ? new Array<Cents>(s.daysLeft).fill(s.floorCents)
    : allocate(available, s.daysLeft);

  const out: DailyAllowancePlan[] = [];
  let cumulative = 0;
  for (let i = 0; i < horizon; i++) {
    const allowance = shares[i];
    cumulative += allowance;
    out.push({
      date: shiftDate(s.today, i),
      allowanceCents: allowance,
      remainingAfterCents: available - cumulative,
      floorProtected,
    });
  }
  return out;
}

/** 内部日期偏移（保持模块自包含，避免 UI 层依赖 calendar 细节）。 */
function shiftDate(date: ISODate, days: number): ISODate {
  const [y, m, d] = date.split('-').map((v) => parseInt(v, 10));
  const next = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(next.getUTCDate()).padStart(2, '0');
  return `${next.getUTCFullYear()}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// 3. 跨月结转：把「本月的结局」变成「下月的开局」
// ---------------------------------------------------------------------------

/**
 * 计算下月应写入 budget.carryoverCents 的金额。
 *  - 结余：按 carryoverPolicy 决定（carry 结转 / to_savings 转储蓄 / reset 清零）。
 *  - 透支：一律结转（负值），让用户看到真实后果 —— 除非策略显式 reset。
 */
export function nextMonthCarryoverFromSnapshot(
  snapshot: BudgetSnapshot,
  config?: Partial<EngineConfig>,
): Cents {
  const cfg = resolveConfig(config);
  const r = snapshot.remainingCents;
  if (r > 0) {
    return cfg.carryoverPolicy === 'carry' ? r : 0;
  }
  if (r < 0) {
    return cfg.carryoverPolicy === 'reset' ? 0 : r;
  }
  return 0;
}

/**
 * 预测「下月开局会受到什么影响」。
 *  - 保底模式下必须用 monthEndAdjustment：因为计划本身就是按 floor 花完，月末结果为负。
 *  - 其他模式用剩余额（假设用户从此不再乱花）与线性外推取较坏者。
 */
export function projectedCarryoverCents(
  snapshot: BudgetSnapshot,
  config?: Partial<EngineConfig>,
): Cents {
  if (snapshot.state === 'smoothed') return snapshot.monthEndAdjustmentCents;
  const plan = nextMonthCarryoverFromSnapshot(snapshot, config);
  return Math.min(plan, snapshot.projectedMonthEndRemainingCents);
}

// ---------------------------------------------------------------------------
// 4. 输入变形工具（全部返回新对象，保持不可变）
// ---------------------------------------------------------------------------

export function withTransactionScope(
  input: SnapshotInput,
  transactionId: string,
  scope: 'flex' | 'off_budget',
  offBudgetReason?: string,
): SnapshotInput {
  return {
    ...input,
    transactions: input.transactions.map((t) =>
      t.id === transactionId
        ? {
            ...t,
            scope,
            offBudgetReason: scope === 'off_budget' ? (offBudgetReason ?? t.offBudgetReason) : undefined,
            updatedAt: new Date().toISOString(),
          }
        : t,
    ),
  };
}

export function withFixedSkipped(input: SnapshotInput, ids: readonly string[]): SnapshotInput {
  const set = new Set(ids);
  return {
    ...input,
    fixedExpenses: input.fixedExpenses.map((f) =>
      set.has(f.id) ? { ...f, status: 'skipped' as const } : f,
    ),
  };
}

/** 按比例从各存款目标中削减 borrowCents（用于「先向储蓄借，下月归还」）。 */
export function withSavingsReduced(input: SnapshotInput, borrowCents: Cents): SnapshotInput {
  let left = borrowCents;
  const goals: SavingsGoal[] = input.savingsGoals.map((g) => {
    const target =
      g.method === 'percent'
        ? Math.floor((input.budget.incomeCents * (g.percent ?? 0)) / 100)
        : g.targetCents;
    if (left <= 0 || target <= 0 || g.status === 'skipped') return g;
    const cut = Math.min(target, left);
    left -= cut;
    // 削减后统一转成固定金额口径，避免 percent 与 fixed 双口径在 UI 上打架。
    return { ...g, method: 'fixed' as const, percent: null, targetCents: target - cut };
  });
  return { ...input, savingsGoals: goals };
}

/** 记一笔前的实时预览：这笔之后今天还能花多少（记账页即时反馈用）。 */
export function simulateTransaction(input: SnapshotInput, tx: DailyTransaction): BudgetSnapshot {
  return computeSnapshot({ ...input, transactions: [...input.transactions, tx] });
}

/** 记账时的金额分诊：是否大额 + 这笔之后今日剩余多少。 */
export interface TransactionTriage {
  thresholdCents: Cents;
  isBigTicket: boolean;
  safeToSpendCents: Cents;
  todayRemainingCents: Cents;
  state: BudgetSnapshot['state'];
}

export function triageTransactionAmount(
  input: SnapshotInput,
  amountCents: Cents,
): TransactionTriage {
  const before = computeSnapshot(input);
  const isBig =
    before.baselineCents > 0 &&
    amountCents > 0 &&
    amountCents >= Math.floor(before.baselineCents * resolveConfig(input.config).bigTicketRatio);
  return {
    thresholdCents: Math.floor(before.baselineCents * resolveConfig(input.config).bigTicketRatio),
    isBigTicket: isBig,
    safeToSpendCents: before.safeToSpendCents,
    todayRemainingCents: before.safeToSpendCents - before.todaySpentCents - amountCents,
    state: before.state,
  };
}

/**
 * 求解「需要向储蓄借多少钱，才能让真值日均回到保底线之上」。
 *
 * 注意这是一个**不动点问题**，不能只用朴素缺口：
 *   借入 X → 可支配总额 F' = F + X → 日基线 B' = F'/N 变大 → 保底线 floor' = 0.6 × B' 也变大
 *   → 需要满足 (R + X)/D ≥ 0.6 × (F + X)/N 才有解，朴素缺口 floor×D − R 一定不够。
 * 例：F=¥6,000、已花 ¥4,800、剩 11 天时，朴素缺口 ¥120，实际需要借 ¥153.77。
 *
 * 实现用不动点迭代（每轮补足当前缺口），最多 12 轮；单调收敛，且返回的是满足条件的最小量级。
 */
export function computeBorrowToExitFloor(input: SnapshotInput, maxIterations = 12): Cents {
  let borrow = 0;
  for (let i = 0; i < maxIterations; i++) {
    const after = computeSnapshot(borrow === 0 ? input : withSavingsReduced(input, borrow));
    if (after.state !== 'smoothed') return borrow;
    const gap = Math.max(
      after.floorCents * after.daysLeft - Math.max(after.remainingCents, 0),
      0,
    );
    if (gap <= 0) return borrow;
    borrow += gap;
  }
  return borrow;
}

// ---------------------------------------------------------------------------
// 5. 超支重排总入口：产出「重建后的健康额度」+ 给用户的 3 个可执行选择
// ---------------------------------------------------------------------------

export function planOverspendRecovery(ctx: RecoveryContext): OverspendPlan {
  const cfg = resolveConfig(ctx.input.config);
  const snapshot = computeSnapshot(ctx.input);
  const level = classifyOverspendLevel(snapshot, cfg);
  const horizon = ctx.horizonDays ?? 7;

  const available = Math.max(snapshot.remainingCents, 0);
  // 把真值日均重新抬回 floor 所需补的钱（这就是「缺口」的定义）。
  const shortfallCents = Math.max(snapshot.floorCents * snapshot.daysLeft - available, 0);

  const options: OverspendOption[] = [];

  // 选项 ①：接受保底模式（默认推荐）——不改变任何数据，只是把缺口账单化到下月。
  const smoothedCarry =
    snapshot.state === 'smoothed'
      ? snapshot.monthEndAdjustmentCents
      : projectedCarryoverCents(snapshot, cfg);
  options.push({
    code: 'accept_smoothed',
    viable: true,
    labelKey: 'option.accept_smoothed',
    resultingDailyCents: snapshot.safeToSpendCents,
    resultingRemainingCents: snapshot.remainingCents,
    resultingNextMonthCarryoverCents: smoothedCarry,
    costKey: smoothedCarry < 0 ? 'cost.carryover_next_month' : 'cost.no_cost',
    costFacts: {
      carryoverCents: smoothedCarry,
      daysLeft: snapshot.daysLeft,
      dailyCents: snapshot.safeToSpendCents,
    },
  });

  // 选项 ②：向储蓄借（下月自动归还）。借入额必须解不动点，不能直接用朴素缺口。
  const borrowable = ctx.savingsBorrowableCents ?? 0;
  const borrowRequiredCents = computeBorrowToExitFloor(ctx.input);
  if (borrowRequiredCents > 0 && borrowable >= borrowRequiredCents) {
    const after = computeSnapshot(withSavingsReduced(ctx.input, borrowRequiredCents));
    options.push({
      code: 'borrow_from_savings',
      viable: true,
      labelKey: 'option.borrow_from_savings',
      resultingDailyCents: after.safeToSpendCents,
      resultingRemainingCents: after.remainingCents,
      resultingNextMonthCarryoverCents: -borrowRequiredCents,
      costKey: 'cost.savings_repay_next_month',
      costFacts: { borrowCents: borrowRequiredCents, naiveShortfallCents: shortfallCents, repayMonths: 1 },
    });
  } else {
    options.push({
      code: 'borrow_from_savings',
      viable: false,
      labelKey: 'option.borrow_from_savings',
      resultingDailyCents: snapshot.safeToSpendCents,
      resultingRemainingCents: snapshot.remainingCents,
      resultingNextMonthCarryoverCents: smoothedCarry,
      costKey: 'cost.savings_not_enough',
      costFacts: {
        borrowableCents: borrowable,
        shortfallCents,
        borrowRequiredCents,
      },
    });
  }

  // 选项 ③：把这笔大额标记为「预算外」（用户本来就有计划外资金，如年终奖/卖闲置所得）。
  const trigger = ctx.triggerTransactionId
    ? ctx.input.transactions.find((t) => t.id === ctx.triggerTransactionId)
    : undefined;
  if (trigger && trigger.scope === 'flex') {
    const after = computeSnapshot(
      withTransactionScope(ctx.input, trigger.id, 'off_budget', 'overspend_recovery'),
    );
    options.push({
      code: 'mark_off_budget',
      viable: true,
      labelKey: 'option.mark_off_budget',
      resultingDailyCents: after.safeToSpendCents,
      resultingRemainingCents: after.remainingCents,
      resultingNextMonthCarryoverCents: projectedCarryoverCents(after, cfg),
      costKey: 'cost.off_budget_recorded',
      costFacts: { amountCents: trigger.amountCents },
    });
  } else {
    options.push({
      code: 'mark_off_budget',
      viable: false,
      labelKey: 'option.mark_off_budget',
      resultingDailyCents: snapshot.safeToSpendCents,
      resultingRemainingCents: snapshot.remainingCents,
      resultingNextMonthCarryoverCents: smoothedCarry,
      costKey: 'cost.no_trigger_transaction',
      costFacts: {},
    });
  }

  // 选项 ④：重排固定项（把可跳过的订阅停一个月），把额度还给日常。
  const skippable = (ctx.skippableFixedIds ?? []).filter((id) =>
    ctx.input.fixedExpenses.some((f) => f.id === id && f.active && f.status !== 'skipped'),
  );
  if (skippable.length > 0) {
    const after = computeSnapshot(withFixedSkipped(ctx.input, skippable));
    options.push({
      code: 'rebalance_fixed',
      viable: true,
      labelKey: 'option.rebalance_fixed',
      resultingDailyCents: after.safeToSpendCents,
      resultingRemainingCents: after.remainingCents,
      resultingNextMonthCarryoverCents: projectedCarryoverCents(after, cfg),
      costKey: 'cost.fixed_skipped',
      costFacts: {
        skippedCount: skippable.length,
        releasedCents: after.discretionaryCents - snapshot.discretionaryCents,
        freedDailyCents: after.safeToSpendCents - snapshot.safeToSpendCents,
      },
    });
  } else {
    options.push({
      code: 'rebalance_fixed',
      viable: false,
      labelKey: 'option.rebalance_fixed',
      resultingDailyCents: snapshot.safeToSpendCents,
      resultingRemainingCents: snapshot.remainingCents,
      resultingNextMonthCarryoverCents: smoothedCarry,
      costKey: 'cost.no_skippable_fixed',
      costFacts: {},
    });
  }

  return {
    level,
    state: snapshot.state,
    daysLeft: snapshot.daysLeft,
    remainingCents: snapshot.remainingCents,
    currentDailyCents: snapshot.safeToSpendCents,
    requiredDailyCents: snapshot.liveBaselineCents,
    paceRatioPct: Math.round(snapshot.paceRatio * 100),
    timeRatioPct: Math.round(snapshot.timeRatio * 100),
    monthEndAdjustmentCents: snapshot.monthEndAdjustmentCents,
    shortfallCents,
    schedule: rescheduleDailyAllowances(snapshot, horizon),
    options,
  };
}

/**
 * 生成「温和提醒」所需的全部事实（不含文案）。
 * 文案层只允许引用这里的数字，禁止 LLM 自行编造 —— 见 ADR-009。
 */
export interface GentleMessageFacts {
  overByTodayCents: Cents;
  daysLeft: number;
  tomorrowDailyCents: Cents;
  projectedGapCents: Cents;
  perDayCutCents: Cents;
  dailyDragCents: Cents;
  carryoverCents: Cents;
}

export function buildGentleMessageFacts(
  snapshot: BudgetSnapshot,
  plan: OverspendPlan,
): GentleMessageFacts {
  const overByToday = Math.max(snapshot.todaySpentCents - snapshot.safeToSpendCents, 0);
  const projectedGap = Math.max(-snapshot.projectedMonthEndRemainingCents, 0);
  const dailyDrag = snapshot.amortization
    .filter((a) => a.purchaseDate === snapshot.today)
    .reduce((acc, a) => acc + a.dailyDragCents, 0);
  return {
    overByTodayCents: overByToday,
    daysLeft: snapshot.daysLeft,
    tomorrowDailyCents: Math.max(snapshot.liveBaselineCents, 0),
    projectedGapCents: projectedGap,
    perDayCutCents: snapshot.daysLeft > 0 ? Math.ceil(projectedGap / snapshot.daysLeft) : 0,
    dailyDragCents: dailyDrag,
    carryoverCents: plan.options[0].resultingNextMonthCarryoverCents,
  };
}

