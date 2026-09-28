# 月度预算 App — 架构设计文档

> 目标：把「本月还能花多少 / 今天还能花多少」这两个数字算得**永不出错**、**离线可用**、**两端一致**。
> 本文档记录架构决策（ADR）、公式语义、状态机、异常处理与验证策略。

---

## 1. 设计约束（不可妥协的 5 条）

| # | 约束 | 原因 |
|---|---|---|
| C1 | 金额只用**整数分** | 浮点误差会让「主数字」与明细求和对不上，一次不一致就永久摧毁信任 |
| C2 | 所有派生指标**不落库**，纯函数重算 | 端与后端各自算一遍才能对账；任何一天都能重放还原 |
| C3 | 任何一天的结论都是「**截至 today**」的时点快照 | 不允许出现「历史回放和当时看到的数字不一样」 |
| C4 | 端侧可独立算出全部数字（**离线优先**） | 预算 App 60% 的使用场景在地铁/电梯里，没有网络 |
| C5 | 展示口径与真值口径**分离**，但绝不撒谎 | 主数字永远是真值；但日额度可以保底，且缺口必须显式记账 |

---

## 2. 分层与数据流

```
                     ┌────────────────────────── 端侧（权威计算，离线可用）
用户操作 ──► UI ──►  Ledger（事件账本，唯一真相源）
                     │   MonthlyBudget / FixedExpense / SavingsGoal / DailyTransaction
                     ▼
              engine.computeSnapshot(input) ──►  BudgetSnapshot（视图，不落库）
                     │                             ├─ safeToSpendCents  ★今日还能花
                     │                             ├─ remainingCents    ★本月剩多少
                     │                             └─ state             ★healthy/watch/smoothed/overdrawn
                     ▼
              reschedule.planOverspendRecovery ──►  补救方案（4 个选项 + 代价）
                     │
                     ▼
              buildAlerts ──► selectAlertsForDisplay（节流：1 主 + 1 正向）──► LLM 文案层（仅措辞）
                     │
        本地持久化（SQLite/Realm）+ 幂等补传（idempotencyKey）
                     ▼
                     ┌────────────────────────── 后端（对账 / 结算 / 推送）
              收到交易 → 用同一套公式重算 → 与端侧上报值比对
                     │  一致 → 静默；不一致 → 埋点 metrics.engine_mismatch + 以服务端为准并回灌
                     └─ 月末结算（carryover 写入下月）、报表、通知/邮件/Widget 快照服务
```

**为什么让端侧权威、后端只对账？**
1. 记账必须 0 延迟（联网等待会杀死「4 秒记账」的体验目标）。
2. 端侧算错的代价是「一次对账告警」，而联网算错的代价是「用户当场看到数字卡住」。
3. 后端只要保证月末结算与对账，职责边界清晰。

---

## 3. 架构决策记录（ADR）

### ADR-001 金额用整数分，除法走统一取整函数
- **决策**：`Cents = int/整数分`；提供 `floorDiv` / `allocate` / `roundHalfAwayFromZero`。
- **原因**：`0.1 + 0.2 !== 0.3`；`parseFloat('1.15') * 100 === 114.99999999999999`。
- **后果**：UI 层统一通过 `formatCents` 展示；任何 `float` 进入金额路径视为 bug（有断言拦截）。

### ADR-002 日期以「本地自然日字符串」为键，端侧写入 `localDate`
- **决策**：交易表存 `localDate: 'YYYY-MM-DD'`，由端侧在写入时按用户本地时区算好；后端不做时区推断。
- **原因**：`Date` 对象携带时区，跨时区/夏令时会让「今天花了多少」漂一天；用户跨时区旅行时，他希望看到的是「当地时间的今天」。
- **后果**：需要「按用户时区看历史」时，只能信任 `localDate`；端侧换时区时应提示确认。

### ADR-003 派生指标不落库；快照是纯函数
- **决策**：`computeSnapshot(input)` 不读时钟、不读网络、不写状态。`today` 由调用方注入。
- **原因**：① 可测试（黄金向量）；② 可重放（把 `today` 设为过去某天即可还原当时的界面）；③ 修一笔历史交易无需迁移派生数据。
- **后果**：每次渲染都要重算（实测 10 万笔交易量级下 O(n) 遍历 ≈ 数毫秒，可接受；如需极致性能，可加「按 version 缓存的快照」。

### ADR-004 存款目标独立成实体，不与固定支出混在一起
- **决策**：`SavingsGoal` 与 `FixedExpense` 分离，`FixedExpense.kind` 只允许 `bill | debt | subscription`。
- **原因**：两者虽然都参与「先扣除」，但语义不同 —— 存款是「付给自己」，账单是「付给世界」；报表、心理账户、达成率都需要分开。
- **后果**：`committed = Σ固定支出 + Σ存款目标`，二者不会重复计入。

### ADR-005 固定支出「预留」与「实付」分离
- **决策**：`estimatedCents` 用于月初锁定（`status='reserved'`），`actualCents` 是出账后真实金额；两者都在 `hardExpenseCents` 里占用预算。
- **原因**：解决月度预算 App 最经典的失败场景 —— 发了工资觉得钱很多，把房租花掉了。
- **后果**：
  - 浮动账单（电费）差额**自动回冲**弹性池：`F = income − (actual ?? estimated) − savings`。
  - 用户看到的可用余额永远不含预留。

### ADR-006 大额消费：真实余额立刻扣，节奏口径按日摊
- **决策**：单笔 ≥ `bigTicketRatio × 日基线`（默认 2 倍）视为大额。它**全额**进入 `remainingCents`（真值），但进入 `paceSpentCents`（节奏口径）时按「购买日 → 月末」均摊，每日一份。
- **原因**：20 号买台电脑，如果节奏口径也一次性计入，进度条会瞬间爆红、AI 会指责用户「你今天花太疯了」，用户会因为「反正已经毁了」而放弃预算 —— 这是月度预算 App 最大的流失点。
- **后果**：`paceSpentCents` 与 `spentCents` 是两个不同口径，必须清楚标注用途：**只用于节奏判断与文案，绝不用于余额展示**。

### ADR-007 保底线 floor + 月末调节项（诚实但不打击）
- **决策**：`floor = floorRatio × 日基线`（默认 0.6）。
  - `真值日均 live = max(remaining,0) / 剩余天数(含今天)`
  - `live ≥ floor` → 展示 `live`
  - `live < floor` → 展示 `floor`，并把差额显式记为 `monthEndAdjustmentCents = remaining − floor × 剩余天数`（负数）
- **原因**：直接把日额度从 ¥238 砸到 ¥95 会让人放弃；但隐瞒缺口等于撒谎。折中方案是「给一个能行动的额度 + 明确告诉你欠了多少，并结转到下月」。
- **后果**：`monthEndAdjustmentCents` 必须出现在月结与下月 `carryoverCents` 里，形成闭环的债务记账。详情页同时展示真值日均（`liveBaselineCents`）与展示额度，保证信息透明。

### ADR-008 时点语义：未来日期的交易不计入已花
- **决策**：`localDate > effectiveToday` 的交易不计入 `spentCents`，单独归集到 `futureScheduledCents`，也不进入摊销计划与节奏口径。
- **原因**：否则「按 date 重放历史」会与当时看到的数字不一致（C3），且预录/误录会立刻污染结论。
- **后果**：需要「计划支出」功能时，应新增独立实体（`PlannedExpense`），复用它会破坏时点语义。

### ADR-009 数字由引擎出，LLM 只负责措辞
- **决策**：告警只产出 `{ code, severity, messageKey, facts }`，`facts` 里的每个数字都来自引擎；LLM 拿 facts 生成自然语言，且**禁止引入 facts 之外的数字**。
- **原因**：LLM 幻觉一个 ¥180 会与本月初数额度互相矛盾，比不说更糟。
- **后果**：文案模板需要 `messageKey` 的本地化资源；后端不重复实现告警生成（端侧算一次，后端只对账数字）。

### ADR-010 离线补传必须幂等
- **决策**：每笔交易带 `idempotencyKey`（客户端 UUID）+ `version`（乐观并发）。重复上报按 key 去重，冲突按 version 判定。
- **原因**：弱网重试是常态，重复扣减会让用户彻底不信任余额。
- **后果**：`dedupeByIdempotencyKey` 在引擎入口处执行，保证「重算了但结果不变」。

### ADR-011 提示词即代码：Prompt 受测试保护
- **决策**：`prompts/financial_agent.system.md` 的 few-shot 金额、公式、金额格式规则、输出行数、禁用词、危机模式，全部由 `tests/test_agent_prompt.py` 断言；提示词的输入由 `schemas/agent_input.schema.json` 约束。
- **原因**：提示词里的错误算术会**被模型学下来**，而这类错误只在用户的真实账单里暴露 —— 比代码 bug 更难发现。提示词与引擎的数字漂移必须由 CI 拦截，不能靠人眼 review。
- **后果**：
  - 改提示词 → 必须同步 `fixtures/agent_eval_cases.json`（否则测试红）；
  - 改引擎 → 若影响了 few-shot 引用的数字，测试同时红，提示词必须一起更新；
  - 金额展示规则（§5「整数省略小数」）必须有代码参考实现 `format_display()`，不允许只由模型实现。

---

## 4. 数据模型总览

| 实体 | 作用 | 关键字段 | 重要约束 |
|---|---|---|---|
| `MonthlyBudget` | 一个自然月一条 | `incomeCents`、`carryoverCents`、`payday` | `(userId, month)` 唯一 |
| `FixedExpense` | 房租/账单/贷款/订阅 | `estimatedCents` / `actualCents` / `status(reserved\|paid\|skipped)` / `dueDay` | `skipped` 时占用归零 |
| `SavingsGoal` | 月度存款目标 | `method(fixed\|percent)`、`targetCents`、`percent` | `percent` 折算后 floor 到分 |
| `DailyTransaction` | 一笔日常开销 | `amountCents`（负=退款）、`localDate`、`necessity`、`scope`、`isBigTicket`、`amortize`、`idempotencyKey` | `scope='off_budget'` 必须带 `offBudgetReason` |

契约文件：`schemas/budget.schema.json`（JSON Schema 2020-12，可直接生成 TS 类型 / Pydantic 模型）。

---

## 5. 核心公式（唯一真相链）

```
输入
  M  = budget.incomeCents + budget.carryoverCents      # 本月可用资金（含上月结转，可为负）
  H  = Σ effectiveFixed(f)                             # 固定开销（actual ?? estimated，skipped=0）
  S  = Σ resolveSavingsTarget(g, income)               # 计划储蓄（percent 按收入折算）

① 固定必要开销 + 计划储蓄（优先扣除的总额）
   committed = H + S

② 本月可自由支配总额
   F = M − committed
   B = floor(F / 当月天数)                              # 日基线（常量，不随消费变化）

③ 余额
   spent     = Σ (flex 且 settled 且未删除 且 localDate ≤ today 的 amountCents)   # 退款为负
   remaining = F − spent            ← ★主数字「本月还能花」

④ 今日安全可花额度
   D     = 当月天数 − 已过天数(含今天) + 1              # 剩余天数（含今天）
   live  = floor(max(remaining, 0) / D)                 # 真值日均
   floor = floor(B × floorRatio)                        # 保底线（默认 0.6）
   safeToSpend = live ≥ floor ? live : floor            ← ★主数字「今天还能花」
   todayRemaining = safeToSpend − todaySpent            # 可能为负 = 今天已超建议

⑤ 节奏（只用于判断与文案，不用于余额）
   paceSpent = Σ(非大额交易全额) + Σ(大额交易按日摊销到今天的份额)
   paceRatio = paceSpent / F
   timeRatio = 已过天数 / 当月天数
   paceGap   = paceRatio − timeRatio                    # > paceTolerance(0.08) → 触发 T1「花太快」

⑥ 月末预测
   avgDailySpendRate = floor(max(spent,0) / 已过天数)
   projectedMonthEndRemaining = remaining − avgDailySpendRate × D
   # 保守估计，宁可早一点预警
```

### 为什么 `safeToSpend = remaining / D` 天然带「结转」语义？
因为 `remaining` 是**实时**的：昨天省下的钱自动抬高今天额度，昨天超支自动压低今天额度。
所以产品上不需要「日结余结转」规则，也不需要向用户解释「结转」这个词。

### 为什么 `floor` 用常量 `B` 而不是动态日均？
若 floor 也随 `remaining` 自我收缩，会出现「越超越没底线」的失控（额度趋近 0，用户直接放弃）。
用月初常量 `B` 作锚，保底线整月稳定 —— 用户知道「再怎么糟，底线就是 ¥120/天」。

---

## 6. 状态机

```
                    income=0 且无支出
        ┌─────────────────────────────────► onboarding（引导态，一切归零，不报错）
        │
   [计算快照] ──► remaining ≤ 0 ──────────► overdrawn（额度归零，不显示负数日额度）
        │                                     └─ 缺口 → 下月 carryoverCents（负数）
        ├──► live < floor ─────────────────► smoothed（保底模式）
        │                                     └─ monthEndAdjustmentCents 记录缺口并结转
        ├──► paceGap > paceTolerance ──────► watch（节奏偏快，琥珀色）
        └──► 其他 ─────────────────────────► healthy（墨黑，唯一可能用绿色的时刻）
```

| 状态 | 日额度 | UI 主数字 | 允许的补救动作 |
|---|---|---|---|
| `onboarding` | 0 | 「先设置本月收入」 | 引导 3 步（收入 → 固定项 → 储蓄目标） |
| `healthy` | `live` | 墨黑 | 无（可给正向反馈 T7） |
| `watch` | `live` | 琥珀 + 时间基准线对比 | 温和提醒 T1、调整计划 |
| `smoothed` | `floor` | 琥珀 + 「另有 ¥X 到月末调节」 | 4 个补救选项（见 §7.3） |
| `overdrawn` | 0 | 红 + 「本月已超出 ¥X」 | 仅记账，下月扣减；不给负数日额度 |

---

## 7. 异常处理：大额超支后的额度重排

### 7.1 数值示例（对应 fixtures 第 2 号用例，可跑通验证）

场景：月入 ¥10,000，固定 ¥2,500 + 储蓄 ¥1,500，9 月 20 日买了一台 ¥3,000 的电脑。

| 步骤 | 计算 | 结果 |
|---|---|---|
| 可自由支配 F | 10000 − (2500 + 1500) | ¥6,000 |
| 日基线 B | floor(6000 / 30) | ¥200 |
| 保底线 floor | floor(200 × 0.6) | ¥120 |
| 大额阈值 | floor(200 × 2) | ¥400（¥3,000 命中） |
| 已花 spent | 6×¥300 + ¥3,000 | ¥4,800 |
| 剩余 remaining | 6000 − 4800 | **¥1,200**（真值，立刻扣全额） |
| 剩余天数 D | 30 − 20 + 1 | 11 |
| 真值日均 live | floor(1200 / 11) | ¥109.09 |
| 展示额度 safeToSpend | 109.09 < 120 → 取保底线 | **¥120** |
| 月末调节项 | 1200 − 120 × 11 | **−¥120**（结转下月） |
| 节奏口径 paceSpent | 1800 + floor(3000 / 11) | ¥2,072.73（而非 ¥4,800） |
| 节奏 gap | 0.345 − 0.667 | −32.1% → **不触发「花太快」提醒** ✅ |

**关键收益**：真值诚实（余额确实只剩 ¥1,200）；展示可行动（每天仍有 ¥120）；AI 不指责（节奏口径显示他花得比时间还慢）；缺口有账（−¥120 结转下月）。

### 7.2 未来 11 天的额度排期

`rescheduleDailyAllowances(snapshot, 11)` 在保底模式下的输出：

| 日期 | 额度 | 花完后真实剩余 | 是否保底 |
|---|---|---|---|
| 9/20 | ¥120 | ¥1,080 | 是 |
| 9/21 | ¥120 | ¥960 | 是 |
| … | … | … | 是 |
| 9/30 | ¥120 | **−¥120** | 是 |

最后一天的真实剩余恰好等于 `monthEndAdjustmentCents` —— 缺口不是拍脑袋来的，而是排期自然推导的结果。

正常模式下排期用 `allocate(remaining, D)`（最大余数法），保证 **Σ每日额度 === remaining**，不会差 1 分钱。

### 7.3 给用户的 4 个可执行选择（每个都带代价）

`planOverspendRecovery()` 返回：

| 选项 | 条件 | 结果 | 代价（必须明示） |
|---|---|---|---|
| ① `accept_smoothed` | 永远可选（默认推荐） | 日额度 ¥120 | 下月弹性 −¥120 |
| ② `borrow_from_savings` | 可动用储蓄 ≥ **¥153.77** | 日额度 ¥123.07 | 下月归还 ¥153.77 |
| ③ `mark_off_budget` | 该笔交易存在且为 flex | 日额度 ¥381.81 | 该 ¥3,000 记为预算外（需审计理由） |
| ④ `rebalance_fixed` | 存在可跳过的订阅/账单 | 取决于释放金额 | 停掉某项固定支出一个月 |

### 7.4 选项 ② 的不动点陷阱（本设计中最容易被写错的地方）

借入 X 会抬高可支配总额 `F' = F + X`，进而抬高日基线 `B' = F'/N` 与保底线 `floor' = 0.6B'`，
所以必须满足 `(R + X)/D ≥ 0.6(F + X)/N` —— 朴素缺口 `floor×D − R = ¥120` **不够**。

闭式解：`X = (0.6·D·F/N − R) / (1 − 0.6·D/N)`，本场景 `X = (132000 − 120000) / 0.78 = ¥153.85`。

实现采用不动点迭代（每轮补足当前缺口，最多 12 轮），返回**满足条件的最小量级** ¥153.77：

| 轮次 | 借入 | F' | 日基线 B' | 保底线 floor' | 真值日均 live' | 是否解出 |
|---|---|---|---|---|---|---|
| 0 | 0 | 600000 | 20000 | 12000 | 10909 | ✗ |
| 1 | +12000 | 612000 | 20400 | 12240 | 12000 | ✗ |
| 2 | +14640 | 614640 | 20488 | 12292 | 12240 | ✗ |
| 3 | +15212 | 615212 | 20507 | 12304 | 12292 | ✗ |
| … | … | … | … | … | … | ✗ |
| 8 | **15377** | 615377 | 20512 | 12307 | **12307** | ✅ |

测试同时断言「少借 1 分就退回 `smoothed`」，把这个最小性锁死。

---

## 8. 边界与异常清单

| 场景 | 规则 | 验证位置 |
|---|---|---|
| 2 月 / 大小月 | 分母用当月真实天数（28/29/30/31） | `daysInMonth`、fixture 05 |
| 账单日 31 落在 2 月 | 夹到 2/28 或 2/29 | `resolveDueDay`、fixture 05 |
| 剩余天数 | 含今天（用户早上打开时，今天还没花） | `daysLeftInclusive` |
| `today` 早于月初 / 晚于月末 | 分别夹到月初 / 月末，`daysLeft ≥ 1`，永不除零 | engine 单测 |
| 退款 / 撤销 | `amountCents < 0` 自动回冲余额；不算大额；不参与摊销 | fixture 04 |
| 浮动账单差额 | `actualCents` 覆盖 `estimatedCents`，差额自动回冲弹性池 | fixture 04 |
| 结算中 pending | 不进余额，单独归集并提示 | engine 单测 |
| 已作废 voided | 完全不参与计算 | engine 单测 |
| 未来日期交易 | 不计入已花，归入 `futureScheduledCents` | engine 单测（ADR-008） |
| 重复上报 | 按 `idempotencyKey` 去重 | 两端单测 |
| 收入为 0 | 进入 `onboarding`，不报错、不显示负数 | fixture 07 |
| 上月透支 | `carryoverCents` 为负，直接压低本月 F | fixture 06 |
| 已透支 | 日额度归零（不给负数），缺口结转下月 | fixture 03 |
| 月结结余 | 默认结转；策略可选 `to_savings` / `reset` | `nextMonthCarryoverFromSnapshot` |
| 固定项月中跳过 | 必须显式确认，并明确告知 F 的变化量 | `withFixedSkipped` |
| 预算外大额 | 需 `offBudgetReason` 审计；不进弹性池、不进节奏 | fixture 08 |
| 跨时区 | 信任端侧写入的 `localDate`（ADR-002） | 契约约束 |

---

## 9. 同步与离线

```
端侧：写本地账本（立即）→ 重算快照（立即）→ 渲染
      └─ 后台队列：POST /sync/transactions  batch + idempotencyKey + version
后端：写入 → 用同一套公式重算 → 与端侧上报的快照摘要比对
      ├─ 一致：200，静默
      └─ 不一致：埋点 engine_mismatch（附输入摘要），以服务端为权威并回灌端侧
```

- **冲突解决**：`version` 大者胜；同 version 时 `updatedAt` 晚者胜。
- **对账摘要**：只上报 6 个整数（`remainingCents`、`safeToSpendCents`、`spentCents`、`committedCents`、`monthEndAdjustmentCents`、`state`），不传全量快照。
- **月末结算**：服务端在跨月时把上月 `remainingCents`（或保底模式下的 `monthEndAdjustmentCents`）写入新月的 `carryoverCents`，并生成一条 rollover 审计记录。

---

## 10. 测试策略

| 层级 | 内容 | 位置 |
|---|---|---|
| **三方逐位一致性（最重要）** | 同一份 `fixtures/golden_cases.json`，TS、Python、网页版各算一遍，断言逐位相等 | `packages/core/test/golden.test.ts` + `tests/test_engine.py` + `tools/validate_webapp_core.js` |
| 单元（TS 36 例） | 整数分运算、日历边界、幂等、摊销、额度排期、4 个补救选项、结转策略、告警节流 | `packages/core/test/*.test.ts` |
| 单元（Python 23 例） | 同上镜像 + Pydantic 校验规则 | `tests/test_engine.py` |
| **网页版独立验证（250 项检查）** | 从 `index.html` 抽取内联核心跑 10 个黄金向量（193 项断言）+ 格式与解析 helper + DOM id 引用完整性（54 个引用静态校验）+ 标签配平 | `tools/validate_webapp_core.js`（`make validate-web`） |
| **Prompt ↔ 引擎绑定（32 例）** | AI 助理输入契约校验、账本口径核对、few-shot 金额溯源、提示词公式与引擎等价、金额格式、行数上限、禁用词、危机模式 | `tests/test_agent_prompt.py` |
| 契约 | JSON Schema 校验（CI 已接 `jsonschema`；可选 `ajv` 校验 TS 侧） | `schemas/*.schema.json` |

黄金向量刻意覆盖：健康月中、大额保底、月末透支、退款 + 账单浮动、2 月边界、跨月结转、全新用户、预算外排除、花太快、连续超标 + 账单到期。

> ⚠️ 开发过程中这套测试已经抓出 3 个真实缺陷（未来日期污染余额、预算外交易误入摊销、借入额不动点算错）—— 这正是把黄金向量做成一等公民的理由。

---

## 11. 性能与实现注意

- `computeSnapshot` 是 O(n)（n = 本月交易数）。1 万笔量级约 1–3ms，可在主线程同步执行。
- 需要极致性能时的缓存策略：`cacheKey = hash(transactions.version + budget.updatedAt + today)`，命中即返回整个快照；**不要**缓存中间量（容易与账本不同步）。
- 大额摊销用 `allocate` 生成数组再切片；单笔摊销天数 ≤ 31，开销可忽略。若改为「前缀和公式」优化，**必须保持与 `allocate` 完全一致的余数分配规则**，否则两端会差 1 分。
- 端侧计算 `localDate` 用 `Intl.DateTimeFormat().resolvedOptions().timeZone`，不要手写 UTC 偏移。

## 12. 未来扩展点（不要提前做）

| 需求 | 建议做法 |
|---|---|
| 计划支出（未来的账） | 新增 `PlannedExpense` 实体，**不要**复用 `DailyTransaction`（会破坏 ADR-008 的时点语义） |
| 多账户 | `DailyTransaction` 加 `accountId`；`F` 仍按单账户算，多账户只影响对账视图 |
| 周末额度更高 | 在 `rescheduleDailyAllowances` 引入权重数组，`allocate` 改为按权重分配（保持总和精确） |
| 周报 / 季报 | 复用 `computeSnapshot` 按月循环 + 汇总，不新增引擎 |
| 家庭共账 | 交易加 `memberId`；预算仍单一，成员维度只做报表 |
