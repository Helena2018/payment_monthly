/**
 * engine.ts — 核心计算引擎（端侧权威实现）
 *
 * 设计约束（ADR-003 / ADR-007）：
 *  1. **纯函数**：`computeSnapshot(input)` 只依赖入参，不读时钟、不读网络、不写状态。
 *     因此它可以被离线重放、被后端镜像实现逐位比对（golden fixtures）。
 *  2. **不落库派生值**：Snapshot 是「视图」，不持久化。任何交易变更只需重算。
 *  3. **整数分 + floor**：所有除法向下取整（保守，宁可少给用户 1 分，也不多给）。
 *
 * 核心公式链：
 *      hardExpenseCents   = Σ 固定开销（actual ?? estimated，skipped/停用 = 0）
 *      savingsCents       = Σ 存款目标（percent 按收入折算）
 *      committedCents     = hardExpenseCents + savingsCents          ← 固定开销 + 存款总额
 *      discretionaryCents = incomeCents + carryoverCents − committed  ← 可自由支配总额
 *      spentCents         = Σ 弹性池已消费（退款为负）
 *      remainingCents     = discretionaryCents − spentCents           ← 剩余可支配余额
 *      baselineCents      = floor(discretionaryCents / 当月天数)       ← 日基线（常量）
 *      liveBaselineCents  = floor(max(remaining, 0) / 剩余天数含今天)   ← 真值日均
 *      floorCents         = floor(baselineCents × floorRatio)         ← 保底线
 *      safeToSpendCents   = max(liveBaseline, floor) 且有界           ← ★今日安全可花
 */

import { Cents, allocate, floorDiv, sumCents } from './money';
import {
  ISODate,
  ISOMonth,
  daysInMonth,
  daysLeftInclusive,
  diffDays,
  monthOf,
  resolveDueDay,
} from './calendar';
import {
  BudgetState,
  DailyTransaction,
  EngineConfig,
  FixedExpense,
  MonthlyBudget,
  SavingsGoal,
  SnapshotInput,
  dedupeByIdempotencyKey,
  resolveConfig,
} from './models';

/** 已付固定开销 / 已预留未付 的拆分。 */
export interface FixedBreakdown {
  /** 已实际扣款（status='paid'）的合计。 */
  paidCents: Cents;
  /** 已预留但尚未扣款（status='reserved'）的合计——这部分钱不可花。 */
  reservedCents: Cents;
  /** 本月被跳过/停用的固定项合计（已释放回可支配）。 */
  skippedCents: Cents;
  /** 临近到期且未付的账单（用于 T6 提醒）。 */
  dueSoon: Array<{ id: string; name: string; amountCents: Cents; dueDate: ISODate }>;
}

/** 一笔大额支出的跨日摊销明细。 */
export interface AmortizationEntry {
  transactionId: string;
  amountCents: Cents;
  purchaseDate: ISODate;
  /** 摊销天数（购买日 → 月末，含两端）。 */
  spreadDays: number;
  /** 每日摊销额（allocate 的众数份额，用于展示「每天多背 ¥143」）。 */
  dailyDragCents: Cents;
  /** 截至今日（含）已计入节奏口径的金额。 */
  chargedSoFarCents: Cents;
  /** 尚未摊销的金额。 */
  pendingAmortizationCents: Cents;
}

/** 消费结构统计（不改预算，仅用于复盘与 AI 文案）。 */
export interface SpendingBreakdown {
  /** 计入弹性池的已结算净支出（含退款冲减），= 公式里的 spentCents。 */
  flexSpentCents: Cents;
  /** 其中：必要消费。 */
  necessaryCents: Cents;
  /** 其中：非必要（冲动）消费。 */
  optionalCents: Cents;
  /** 其中：未打标。 */
  unclassifiedCents: Cents;
  /** 退款合计（正数表示退回多少）。 */
  refundCents: Cents;
  /** 预算外支出合计（scope='off_budget'，不进弹性池）。 */
  offBudgetCents: Cents;
  /** 结算中（pending）的支出，不进余额但需要提示用户。 */
  pendingCents: Cents;
  /** 日期在 today 之后的交易（预录/误录），不计入已花，避免污染当前时点的结论。 */
  futureScheduledCents: Cents;
  /** 今日（effectiveToday）已花。 */
  todaySpentCents: Cents;
  /** 节奏口径支出：大额按日摊销后的支出，用于「花得快不快」的判断。 */
  paceSpentCents: Cents;
  /** 判定为大额的笔数。 */
  bigTicketCount: number;
}

/** 首页所需的全部派生指标（一次算完，UI 直接渲染）。 */
export interface BudgetSnapshot {
  month: ISOMonth;
  today: ISODate;
  totalDays: number;
  /** 已过天数（含今天）。 */
  elapsedDays: number;
  /** 剩余天数（含今天）——DailySafeToSpend 的分母。 */
  daysLeft: number;
  daysInMonth: number;

  incomeCents: Cents;
  carryoverCents: Cents;

  fixed: FixedBreakdown;
  /** 固定开销合计（= paid + reserved）。 */
  hardExpenseCents: Cents;
  savingsCents: Cents;
  /** 固定必要开销 + 计划储蓄 = 优先扣除的总额。 */
  committedCents: Cents;

  // —— 三个核心数字 ——
  discretionaryCents: Cents;
  spentCents: Cents;
  remainingCents: Cents;

  // —— 额度口径 ——
  baselineCents: Cents;
  liveBaselineCents: Cents;
  floorCents: Cents;
  /** ★今日安全可花额度。onboarding / overdrawn 时为 0。 */
  safeToSpendCents: Cents;
  /** 今日已花。 */
  todaySpentCents: Cents;
  /** 今日剩余（可能为负，表示今天已经超出建议额度）。 */
  todayRemainingCents: Cents;
  /** 月末调节项：负值 = 保底模式下累计的透支额（将由下月承担）。 */
  monthEndAdjustmentCents: Cents;

  // —— 节奏 ——
  paceRatio: number;
  timeRatio: number;
  paceGap: number;
  paceSpentCents: Cents;
  /** 线性外推的月末剩余（负数 = 预计月末会差这么多）。 */
  projectedMonthEndRemainingCents: Cents;

  state: BudgetState;
  spending: SpendingBreakdown;
  amortization: AmortizationEntry[];
}

export type AlertCode =
  | 'T1_PACE_FAST'
  | 'T2_TODAY_OVER'
  | 'T3_BIG_TICKET'
  | 'T4_CONSECUTIVE_OVER'
  | 'T5_MONTH_END_GAP'
  | 'T6_FIXED_DUE'
  | 'T7_POSITIVE';

/** 告警只描述事实（数字），文案由 LLM 层注入，保证数字不幻觉。 */
export interface BudgetAlert {
  code: AlertCode;
  severity: 'info' | 'gentle' | 'watch';
  /** 本地化 key，UI/文案层做映射。 */
  messageKey: string;
  facts: Record<string, number | string>;
}

// ---------------------------------------------------------------------------
// 1. 固定开销：预留 / 实付 / 跳过
// ---------------------------------------------------------------------------

/**
 * 单个固定项在「预算占用」口径下的金额。
 *  - 停用(active=false) 或 跳过(status='skipped') → 0，钱释放回可支配池。
 *  - 有实际金额 → 用实际金额（浮动账单差额自动回冲）。
 *  - 否则 → 用预估金额（月初即锁定，保证房租不会被日常消费花掉）。
 */
export function effectiveFixedCents(f: FixedExpense): Cents {
  if (!f.active || f.status === 'skipped') return 0;
  return f.actualCents !== null ? f.actualCents : f.estimatedCents;
}

/** 固定开销合计（不含存款）。 */
export function sumHardExpenses(fixed: readonly FixedExpense[]): Cents {
  return sumCents(fixed.map(effectiveFixedCents));
}

/**
 * 存款目标折算成金额。
 * method='percent' 支持按收入比例（如 12.5%），折算后 floor 到分，避免出现 0.5 分。
 */
export function resolveSavingsTargetCents(goal: SavingsGoal, incomeCents: Cents): Cents {
  if (goal.status === 'skipped') return 0;
  if (goal.method === 'percent') {
    const pct = goal.percent ?? 0;
    return Math.floor((incomeCents * pct) / 100);
  }
  return goal.targetCents;
}

/** 计划储蓄合计（已转账与计划转账都计入 committed，避免这部分钱被花掉）。 */
export function sumSavingsCents(goals: readonly SavingsGoal[], incomeCents: Cents): Cents {
  return sumCents(goals.map((g) => resolveSavingsTargetCents(g, incomeCents)));
}

/**
 * 是否属于「临近到期且未付」的固定项（T6 提醒用）。
 * 判定：已预留(未付) 且 到期日 ≤ today + withinDays。
 */
export function findFixedDueSoon(
  fixed: readonly FixedExpense[],
  month: ISOMonth,
  today: ISODate,
  withinDays = 3,
): Array<{ id: string; name: string; amountCents: Cents; dueDate: ISODate }> {
  const out: Array<{ id: string; name: string; amountCents: Cents; dueDate: ISODate }> = [];
  for (const f of fixed) {
    if (!f.active || f.status !== 'reserved') continue;
    const dueDate = resolveDueDay(month, f.dueDay);
    const delta = diffDays(today, dueDate);
    if (delta >= 0 && delta <= withinDays) {
      out.push({
        id: f.id,
        name: f.name,
        amountCents: effectiveFixedCents(f),
        dueDate,
      });
    }
  }
  return out.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0));
}

/**
 * 大额判定阈值：单笔 ≥ bigTicketRatio × 日基线。
 * 日基线为 0（无收入/尚未配置）时用固定阈值兜底，避免全部交易都被判成大额。
 */
export function bigTicketThresholdCents(baselineCents: Cents, config: EngineConfig): Cents {
  if (baselineCents <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.floor(baselineCents * config.bigTicketRatio);
}

/** 交易是否应被当作大额处理（用户/引擎标记 或 金额超过阈值）。 */
export function isBigTicket(
  tx: DailyTransaction,
  thresholdCents: Cents,
): boolean {
  if (tx.amountCents <= 0) return false; // 退款不算
  return tx.isBigTicket || tx.amountCents >= thresholdCents;
}

// ---------------------------------------------------------------------------
// 2. 大额摊销（ADR-006）：真实余额立刻扣，节奏口径按日摊
// ---------------------------------------------------------------------------

/**
 * 单笔大额在「截至 today（含）」已摊销的金额。
 *
 * 摊销区间 = 购买日 → 月末（含两端），每日份额由 allocate 均分且 SUM 精确等于全额。
 * 这样做的产品意义：用户 20 号买了台电脑，真实余额立刻少 ¥3,000（不撒谎），
 * 但「消费节奏」判断上它被摊到剩下的 11 天，AI 才不会冤枉用户「你今天花太疯了」，
 * 也不会让进度条瞬间爆红导致用户放弃月度预算。
 *
 * 边界：购买日在 today 之后（未来日期/错误数据）→ 记 0；购买日在上月 → 全额计入。
 */
export function amortizedChargeCents(tx: DailyTransaction, month: ISOMonth, today: ISODate): Cents {
  if (monthOf(tx.localDate) !== month) return tx.amountCents;
  const spreadDays = daysLeftInclusive(month, tx.localDate);
  if (spreadDays <= 0) return tx.amountCents;
  const elapsed = diffDays(tx.localDate, today);
  if (elapsed < 0) return 0;
  const taken = Math.min(spreadDays, elapsed + 1);
  const shares = allocate(tx.amountCents, spreadDays);
  return sumCents(shares.slice(0, taken));
}

export function buildAmortizationPlan(
  transactions: readonly DailyTransaction[],
  month: ISOMonth,
  today: ISODate,
  thresholdCents: Cents,
): AmortizationEntry[] {
  const entries: AmortizationEntry[] = [];
  for (const tx of transactions) {
    if (!isBigTicket(tx, thresholdCents) || !tx.amortize) continue;
    if (tx.status !== 'settled' || tx.deletedAt) continue;
    // 预算外交易不进弹性池，自然也不参与节奏口径的摊销（与 collectSpending 口径保持一致）。
    if (tx.scope !== 'flex') continue;
    if (monthOf(tx.localDate) !== month) continue;
    // 未来日期的交易不作为「已发生的大额」纳入计划。
    if (tx.localDate > today) continue;
    const spreadDays = Math.max(daysLeftInclusive(month, tx.localDate), 1);
    const shares = allocate(tx.amountCents, spreadDays);
    const charged = amortizedChargeCents(tx, month, today);
    entries.push({
      transactionId: tx.id,
      amountCents: tx.amountCents,
      purchaseDate: tx.localDate,
      spreadDays,
      dailyDragCents: shares[0],
      chargedSoFarCents: charged,
      pendingAmortizationCents: tx.amountCents - charged,
    });
  }
  return entries.sort((a, b) => (a.purchaseDate < b.purchaseDate ? -1 : 1));
}

// ---------------------------------------------------------------------------
// 3. 消费归集
// ---------------------------------------------------------------------------

/** 过滤出「本月、已结算、未删除、生效」的对账交易（pending 与 voided 排除）。 */
export function liveTransactions(
  transactions: readonly DailyTransaction[],
  month: ISOMonth,
): DailyTransaction[] {
  return dedupeByIdempotencyKey(transactions).filter(
    (t) =>
      monthOf(t.localDate) === month &&
      t.status === 'settled' &&
      !t.deletedAt &&
      t.budgetId !== undefined,
  );
}

export function collectSpending(
  transactions: readonly DailyTransaction[],
  month: ISOMonth,
  effectiveToday: ISODate,
  thresholdCents: Cents,
): SpendingBreakdown {
  const all = dedupeByIdempotencyKey(transactions);
  const live = all.filter((t) => monthOf(t.localDate) === month && t.status === 'settled' && !t.deletedAt);

  let flexSpent = 0;
  let necessary = 0;
  let optional = 0;
  let unclassified = 0;
  let refund = 0;
  let offBudget = 0;
  let todaySpent = 0;
  let paceSpent = 0;
  let bigTicketCount = 0;
  let futureScheduled = 0;

  for (const t of live) {
    // 时点语义（ADR-003）：任何一天的结论都必须是「截至 today」的重放结果。
    // 因此日期晚于 today 的交易不计入已花，单独归集，避免历史回放出现前后不一致。
    if (t.localDate > effectiveToday) {
      futureScheduled += t.amountCents;
      continue;
    }
    if (t.scope === 'off_budget') {
      offBudget += t.amountCents;
      continue;
    }
    flexSpent += t.amountCents;
    if (t.amountCents < 0) refund += -t.amountCents;
    if (t.necessity === 'necessary') necessary += t.amountCents;
    else if (t.necessity === 'optional') optional += t.amountCents;
    else unclassified += t.amountCents;

    if (t.localDate === effectiveToday) todaySpent += t.amountCents;

    if (isBigTicket(t, thresholdCents) && t.amortize) {
      bigTicketCount += 1;
      paceSpent += amortizedChargeCents(t, month, effectiveToday);
    } else {
      paceSpent += t.amountCents;
    }
  }

  const pending = all
    .filter((t) => monthOf(t.localDate) === month && t.status === 'pending' && !t.deletedAt)
    .reduce((acc, t) => acc + t.amountCents, 0);

  return {
    flexSpentCents: flexSpent,
    necessaryCents: necessary,
    optionalCents: optional,
    unclassifiedCents: unclassified,
    refundCents: refund,
    offBudgetCents: offBudget,
    pendingCents: pending,
    futureScheduledCents: futureScheduled,
    todaySpentCents: todaySpent,
    paceSpentCents: paceSpent,
    bigTicketCount,
  };
}

/** 逐日支出（用于 T4「连续 N 天超支」判定与明细图）。 */
export function dailySpendMap(
  transactions: readonly DailyTransaction[],
  month: ISOMonth,
): Map<ISODate, Cents> {
  const map = new Map<ISODate, Cents>();
  for (const t of liveTransactions(transactions, month)) {
    if (t.scope === 'off_budget') continue;
    map.set(t.localDate, (map.get(t.localDate) ?? 0) + t.amountCents);
  }
  return map;
}

/**
 * 截至 today（含）连续「超标日」天数。
 * 超标定义：当日弹性支出 > 当月日基线 baselineCents（用常量基线而非动态额度，
 * 因为动态额度会随超支自我收缩，导致「越超越难超」的判定失真）。
 */
export function consecutiveOverDays(
  transactions: readonly DailyTransaction[],
  month: ISOMonth,
  effectiveToday: ISODate,
  baselineCents: Cents,
): number {
  if (baselineCents <= 0) return 0;
  const map = dailySpendMap(transactions, month);
  let streak = 0;
  let cursor: ISODate = effectiveToday;
  while (monthOf(cursor) === month) {
    const spent = map.get(cursor) ?? 0;
    if (spent > baselineCents) {
      streak += 1;
      cursor = requirePrevDay(cursor);
    } else {
      break;
    }
  }
  return streak;
}

function requirePrevDay(date: ISODate): ISODate {
  const [y, m, d] = date.split('-').map((v) => parseInt(v, 10));
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  const mm = String(prev.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(prev.getUTCDate()).padStart(2, '0');
  return `${prev.getUTCFullYear()}-${mm}-${dd}`;
}

function clampISO(value: ISODate, lo: ISODate, hi: ISODate): ISODate {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

// ---------------------------------------------------------------------------
// 4. 快照计算（唯一的对外主入口）
// ---------------------------------------------------------------------------

export function computeSnapshot(input: SnapshotInput): BudgetSnapshot {
  const cfg = resolveConfig(input.config);
  const { budget } = input;
  const month = budget.month;

  const totalDays = daysInMonth(month);
  const firstDay = `${month}-01`;
  const lastDay = resolveDueDay(month, 'month_end');

  // 「今天」被夹在本月范围内：月初之前 → 按月初算；月末之后（复盘/对账）→ 按月末算。
  // 这样 daysLeft 恒 ≥ 1，且不会出现除零；跨月结转由下一月 budget.carryoverCents 承接。
  const effectiveToday = clampISO(input.today, firstDay, lastDay);
  const elapsedDays = Math.min(Math.max(diffDays(firstDay, effectiveToday) + 1, 1), totalDays);
  const daysLeft = totalDays - elapsedDays + 1;

  // —— ① 固定开销：预留 + 实付 ——
  const activeFixed = input.fixedExpenses.filter((f) => f.active);
  const hardExpenseCents = sumHardExpenses(activeFixed);
  const paidCents = sumCents(
    activeFixed.filter((f) => f.status === 'paid').map(effectiveFixedCents),
  );
  const reservedCents = sumCents(
    activeFixed.filter((f) => f.status === 'reserved').map(effectiveFixedCents),
  );
  const skippedCents = sumCents(
    input.fixedExpenses
      .filter((f) => !f.active || f.status === 'skipped')
      .map((f) => (f.actualCents !== null ? f.actualCents : f.estimatedCents)),
  );
  const fixed: FixedBreakdown = {
    paidCents,
    reservedCents,
    skippedCents,
    dueSoon: findFixedDueSoon(activeFixed, month, effectiveToday),
  };

  // —— ② 存款目标 ——
  const savingsCents = sumSavingsCents(input.savingsGoals, budget.incomeCents);

  // —— ③ 三个核心数字 ——
  const committedCents = hardExpenseCents + savingsCents;
  const incomeCents = budget.incomeCents;
  const carryoverCents = budget.carryoverCents;
  const discretionaryCents = incomeCents + carryoverCents - committedCents;

  // —— ④ 额度基线（先算 B，才能判定大额阈值，再算 spent）——
  const baselineCents = discretionaryCents > 0 ? floorDiv(discretionaryCents, totalDays) : 0;
  const floorCents = Math.floor(baselineCents * cfg.floorRatio);
  const thresholdCents = bigTicketThresholdCents(baselineCents, cfg);

  const spending = collectSpending(input.transactions, month, effectiveToday, thresholdCents);
  const spentCents = spending.flexSpentCents;
  const remainingCents = discretionaryCents - spentCents;

  // —— ⑤ Daily Safe-to-Spend：保底机制（ADR-008）——
  const liveBaselineCents = remainingCents > 0 ? floorDiv(remainingCents, daysLeft) : 0;
  const paceRatio = discretionaryCents > 0 ? spending.paceSpentCents / discretionaryCents : 0;
  const timeRatio = elapsedDays / totalDays;
  const paceGap = paceRatio - timeRatio;

  let safeToSpendCents = 0;
  let monthEndAdjustmentCents = 0;
  let state: BudgetState;

  if (discretionaryCents <= 0 && spentCents <= 0) {
    // 还没填收入 → 引导态，不要报错吓用户。
    state = 'onboarding';
  } else if (remainingCents <= 0) {
    // 已透支：日额度归零，剩余缺口由下月 carryover 承接（不显示负数日额度）。
    state = 'overdrawn';
  } else if (floorCents <= 0 || liveBaselineCents >= floorCents) {
    safeToSpendCents = liveBaselineCents;
    state = paceGap > cfg.paceTolerance ? 'watch' : 'healthy';
  } else {
    // 保底模式：真值日均已跌破 60% 日基线（通常因大额消费）。
    // 展示 floor 以维持行动力，并把差额显式记为「月末调节项」——诚实但不打击。
    safeToSpendCents = floorCents;
    monthEndAdjustmentCents = remainingCents - floorCents * daysLeft; // 负数
    state = 'smoothed';
  }

  const avgDailySpendRateCents = floorDiv(Math.max(spentCents, 0), elapsedDays);
  const projectedMonthEndRemainingCents = remainingCents - avgDailySpendRateCents * daysLeft;

  return {
    month,
    today: effectiveToday,
    totalDays,
    elapsedDays,
    daysLeft,
    daysInMonth: totalDays,

    incomeCents,
    carryoverCents,

    fixed,
    hardExpenseCents,
    savingsCents,
    committedCents,

    discretionaryCents,
    spentCents,
    remainingCents,

    baselineCents,
    liveBaselineCents,
    floorCents,
    safeToSpendCents,
    todaySpentCents: spending.todaySpentCents,
    todayRemainingCents: safeToSpendCents - spending.todaySpentCents,
    monthEndAdjustmentCents,

    paceRatio,
    timeRatio,
    paceGap,
    paceSpentCents: spending.paceSpentCents,
    projectedMonthEndRemainingCents,

    state,
    spending,
    amortization: buildAmortizationPlan(
      input.transactions,
      month,
      effectiveToday,
      thresholdCents,
    ),
  };
}

// ---------------------------------------------------------------------------
// 5. 告警生成（只产出「事实 + 本地化 key」，文案由文案层/LLM 注入数字）
// ---------------------------------------------------------------------------

export function buildAlerts(snapshot: BudgetSnapshot, input: SnapshotInput): BudgetAlert[] {
  const cfg = resolveConfig(input.config);
  const alerts: BudgetAlert[] = [];
  const s = snapshot;

  if (s.state === 'onboarding') {
    return [
      {
        code: 'T7_POSITIVE',
        severity: 'info',
        messageKey: 'alert.onboarding',
        facts: {},
      },
    ];
  }

  // T1 节奏过快
  if (s.discretionaryCents > 0 && s.paceGap > cfg.paceTolerance) {
    const expectedPaceCents = Math.floor(s.discretionaryCents * s.timeRatio);
    alerts.push({
      code: 'T1_PACE_FAST',
      severity: 'watch',
      messageKey: 'alert.pace_fast',
      facts: {
        paceRatioPct: Math.round(s.paceRatio * 100),
        timeRatioPct: Math.round(s.timeRatio * 100),
        spentCents: s.paceSpentCents,
        expectedSpentCents: expectedPaceCents,
        aheadCents: s.paceSpentCents - expectedPaceCents,
        daysLeft: s.daysLeft,
      },
    });
  }

  // T2 今日超出建议额度 20% 以上
  if (s.safeToSpendCents > 0 && s.todaySpentCents > Math.floor(s.safeToSpendCents * 1.2)) {
    alerts.push({
      code: 'T2_TODAY_OVER',
      severity: 'watch',
      messageKey: 'alert.today_over',
      facts: {
        todaySpentCents: s.todaySpentCents,
        safeToSpendCents: s.safeToSpendCents,
        overByCents: s.todaySpentCents - s.safeToSpendCents,
        tomorrowCents: Math.max(s.liveBaselineCents, 0),
      },
    });
  }

  // T3 今日/近期大额消费（不评判，仅提示占比）
  const todayBig = s.amortization.filter((a) => a.purchaseDate === s.today);
  for (const big of todayBig) {
    alerts.push({
      code: 'T3_BIG_TICKET',
      severity: 'gentle',
      messageKey: 'alert.big_ticket',
      facts: {
        transactionId: big.transactionId,
        amountCents: big.amountCents,
        dailyDragCents: big.dailyDragCents,
        spreadDays: big.spreadDays,
        remainingCents: s.remainingCents,
      },
    });
  }

  // T4 连续超标日
  const streak = consecutiveOverDays(
    input.transactions,
    s.month,
    s.today,
    s.baselineCents,
  );
  if (streak >= 3) {
    alerts.push({
      code: 'T4_CONSECUTIVE_OVER',
      severity: 'watch',
      messageKey: 'alert.consecutive_over',
      facts: { streak, safeToSpendCents: s.safeToSpendCents, daysLeft: s.daysLeft },
    });
  }

  // T5 月末缺口预测
  if (s.projectedMonthEndRemainingCents < 0 && s.daysLeft > 1) {
    const gap = -s.projectedMonthEndRemainingCents;
    alerts.push({
      code: 'T5_MONTH_END_GAP',
      severity: 'watch',
      messageKey: 'alert.month_end_gap',
      facts: {
        gapCents: gap,
        daysLeft: s.daysLeft,
        perDayCutCents: Math.ceil(gap / s.daysLeft),
      },
    });
  }

  // T6 固定账单临近到期
  if (s.fixed.dueSoon.length > 0) {
    const total = s.fixed.dueSoon.reduce((a, b) => a + b.amountCents, 0);
    alerts.push({
      code: 'T6_FIXED_DUE',
      severity: 'gentle',
      messageKey: 'alert.fixed_due',
      facts: {
        count: s.fixed.dueSoon.length,
        totalCents: total,
        firstName: s.fixed.dueSoon[0].name,
        firstDueDate: s.fixed.dueSoon[0].dueDate,
      },
    });
  }

  // T7 正向反馈（产品要求：提醒里至少一半是正向的）
  if (s.state === 'healthy' && s.timeRatio >= 0.1 && s.paceGap <= -0.08) {
    alerts.push({
      code: 'T7_POSITIVE',
      severity: 'info',
      messageKey: 'alert.on_track',
      facts: {
        paceRatioPct: Math.round(s.paceRatio * 100),
        timeRatioPct: Math.round(s.timeRatio * 100),
        projectedSurplusCents: Math.max(s.projectedMonthEndRemainingCents, 0),
      },
    });
  } else if (s.state === 'healthy' && s.projectedMonthEndRemainingCents > 0 && s.daysLeft <= 3) {
    alerts.push({
      code: 'T7_POSITIVE',
      severity: 'info',
      messageKey: 'alert.month_end_surplus',
      facts: { surplusCents: s.projectedMonthEndRemainingCents, daysLeft: s.daysLeft },
    });
  }

  return alerts;
}

/**
 * 展示层节流（产品规则落地）：每天最多 1 条主提醒（watch/gentle）+ 1 条正向。
 * 主提醒优先级：T2 今日超额 > T1 节奏快 > T5 月末缺口 > T6 账单 > T4 连击 > T3 大额。
 */
export function selectAlertsForDisplay(alerts: readonly BudgetAlert[], maxMain = 1): BudgetAlert[] {
  const priority: Record<AlertCode, number> = {
    T2_TODAY_OVER: 0,
    T1_PACE_FAST: 1,
    T5_MONTH_END_GAP: 2,
    T6_FIXED_DUE: 3,
    T4_CONSECUTIVE_OVER: 4,
    T3_BIG_TICKET: 5,
    T7_POSITIVE: 9,
  };
  const main = alerts
    .filter((a) => a.severity !== 'info')
    .sort((a, b) => priority[a.code] - priority[b.code])
    .slice(0, maxMain);
  const positive = alerts.filter((a) => a.severity === 'info').slice(0, 1);
  return [...main, ...positive];
}

/** 便捷入口：一次拿到快照与展示用告警。 */
export function computeDashboard(
  input: SnapshotInput,
): { snapshot: BudgetSnapshot; alerts: BudgetAlert[] } {
  const snapshot = computeSnapshot(input);
  const alerts = selectAlertsForDisplay(buildAlerts(snapshot, input));
  return { snapshot, alerts };
}
