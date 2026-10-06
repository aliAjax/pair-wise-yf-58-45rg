// 灰度发布编排引擎（纯函数）
// 覆盖：分档计划、观察期错误率门禁、回退一档+冻结、命中范围与快照收回、
// 断点重试/待收项、档位变化重算快照、双人指令乐观锁仲裁。
// 所有状态变更都经由本模块，store 只负责持久化与界面接线。

export interface RolloutStage {
  id: string;
  percent: number; // 0 < percent <= 100，严格递增
  observeMinutes: number; // 该档观察时长（分钟）
}

export type StagePhase = 'pending' | 'observing' | 'healthy' | 'frozen';

export interface StageRuntime {
  phase: StagePhase;
  observedMinutes: number;
  errorRate: number | null; // 最近一次上报的错误率（%）
  threshold: number; // 进入该档时锁定的错误率门禁（%）
}

export type ReclaimItemStatus = 'pending' | 'reclaimed' | 'failed' | 'recalculated';

export interface ReclaimItem {
  id: string;
  bucket: number; // 灰度桶（百分比取模），代表已命中的用户范围
  userId: string;
  status: ReclaimItemStatus;
  attempts: number;
  lastError: string | null;
  snapshot: string; // 收回时一并回收的命中快照（序列化载荷）
}

export interface ReclaimLog {
  at: string;
  message: string;
}

export interface ReclaimJob {
  id: string;
  auditIds: string[]; // 每次回退事件只对应一条审计，这里按发生顺序累积
  fromPercent: number; // 最近一次回退前的比例
  toPercent: number; // 回退后的比例
  checkpoint: number; // 断点：items 中下一个待处理下标
  items: ReclaimItem[];
  logs: ReclaimLog[];
  done: boolean;
}

export interface RolloutRuntime {
  rev: number; // 档位版本号，每次落地的指令 +1，作为乐观锁
  stageIndex: number;
  activePercent: number;
  startedAt: string | null;
  frozen: boolean;
  frozenReason: string | null;
  released: boolean;
  stages: Record<string, StageRuntime>;
  reclaim: ReclaimJob | null;
}

export interface EngineAudit {
  id: string;
  at: string;
  actor: string;
  action: string;
  detail: string;
}

export interface RolloutPlanLike {
  stages: RolloutStage[];
  errorThreshold: number;
  runtime: RolloutRuntime | null;
}

export interface DispatchContext {
  flagKey: string;
  at: string;
  buildSnapshot?: (bucket: number, meta: { fromPercent: number; toPercent: number; stageIndex: number; at: string }) => string;
}

export interface CommandResult {
  accepted: boolean;
  code: 'ok' | 'stale-rejudged' | 'rejected';
  message: string;
  audits: EngineAudit[];
  rev: number;
  activePercent: number;
  frozen: boolean;
}

let seq = 0;
export function uid(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export const DEFAULT_STAGES: RolloutStage[] = [
  { id: 's-1', percent: 1, observeMinutes: 30 },
  { id: 's-2', percent: 10, observeMinutes: 60 },
  { id: 's-3', percent: 50, observeMinutes: 120 },
  { id: 's-4', percent: 100, observeMinutes: 240 }
];

export const STAGE_PHASE_LABEL: Record<StagePhase, string> = {
  pending: '未开始',
  observing: '观察中',
  healthy: '观察通过',
  frozen: '已冻结'
};

// ---------- 计划校验 ----------

export function validateStages(stages: RolloutStage[]): string[] {
  const errors: string[] = [];
  if (stages.length < 2) errors.push('至少配置 2 个发布档');
  if (stages.length > 8) errors.push('发布档不能超过 8 档');
  let prev = 0;
  stages.forEach((stage, index) => {
    if (!Number.isFinite(stage.percent) || stage.percent <= 0 || stage.percent > 100) {
      errors.push(`第 ${index + 1} 档比例需在 0~100 之间`);
    } else if (stage.percent <= prev) {
      errors.push(`第 ${index + 1} 档比例必须高于上一档（${prev}%）`);
    }
    if (!Number.isFinite(stage.observeMinutes) || stage.observeMinutes < 1) {
      errors.push(`第 ${index + 1} 档观察时长至少 1 分钟`);
    }
    prev = stage.percent;
  });
  const last = stages[stages.length - 1];
  if (last && last.percent !== 100) errors.push('最后一档必须是 100% 全量');
  return errors;
}

// ---------- 快照 ----------

function defaultSnapshot(flagKey: string, bucket: number, meta: { fromPercent: number; toPercent: number; stageIndex: number; at: string }): string {
  const userId = `bucket-user-${String(bucket).padStart(3, '0')}`;
  const hashBase = `${flagKey}:${bucket}:${meta.at}`;
  const hash = [...hashBase].reduce((sum, ch) => sum + ch.charCodeAt(0), 0).toString(16);
  return JSON.stringify({
    v: 1,
    flagKey,
    userId,
    bucket,
    hitRange: `${meta.toPercent}%~${meta.fromPercent}%`,
    stageNo: meta.stageIndex + 1,
    capturedAt: meta.at,
    configHash: hash
  });
}

// ---------- 开始灰度 ----------

export function startRollout(plan: RolloutPlanLike, actor: string, ctx: DispatchContext): CommandResult {
  const errors = validateStages(plan.stages);
  if (errors.length) return reject(`发布档配置无效：${errors.join('；')}`, plan);
  if (plan.runtime) return reject('灰度已在进行中', plan);
  const stageMap: Record<string, StageRuntime> = {};
  plan.stages.forEach((stage, index) => {
    stageMap[stage.id] = {
      phase: index === 0 ? 'observing' : 'pending',
      observedMinutes: 0,
      errorRate: null,
      threshold: plan.errorThreshold
    };
  });
  const first = plan.stages[0];
  plan.runtime = {
    rev: 1,
    stageIndex: 0,
    activePercent: first.percent,
    startedAt: ctx.at,
    frozen: false,
    frozenReason: null,
    released: false,
    stages: stageMap,
    reclaim: null
  };
  const audit: EngineAudit = {
    id: uid('a'),
    at: ctx.at,
    actor,
    action: '开始灰度',
    detail: `进入第 1 档 ${first.percent}%，观察 ${first.observeMinutes} 分钟，错误率门禁 ${plan.errorThreshold}%`
  };
  return ok(`灰度开始：第 1 档 ${first.percent}%`, [audit], plan);
}

// ---------- 指令判定 ----------

interface Judge {
  pass: boolean;
  message: string;
}

function currentStage(plan: RolloutPlanLike) {
  const rt = plan.runtime!;
  return { rt, stage: plan.stages[rt.stageIndex], stageRt: rt.stages[plan.stages[rt.stageIndex].id] };
}

function judgePromote(plan: RolloutPlanLike): Judge {
  if (!plan.runtime) return { pass: false, message: '灰度尚未开始' };
  const rt = plan.runtime;
  if (rt.released) return { pass: false, message: '已全量发布，没有更高档位' };
  if (rt.frozen) return { pass: false, message: `发布已冻结：${rt.frozenReason ?? ''}，推进被拦截` };
  const { stage, stageRt } = currentStage(plan);
  if (stageRt.phase === 'healthy') return { pass: true, message: '观察已通过，可推进下一档' };
  if (stageRt.observedMinutes < stage.observeMinutes) {
    return { pass: false, message: `第 ${rt.stageIndex + 1} 档观察期未满（${stageRt.observedMinutes}/${stage.observeMinutes} 分钟）` };
  }
  if (stageRt.errorRate === null) {
    return { pass: false, message: '观察期已满但缺少错误率数据，暂不能推进' };
  }
  if (stageRt.errorRate >= stageRt.threshold) {
    return { pass: false, message: `错误率 ${stageRt.errorRate}% 未降至门禁 ${stageRt.threshold}% 以下，请回退` };
  }
  return { pass: true, message: '观察期满且错误率达标' };
}

function judgeStop(plan: RolloutPlanLike): Judge {
  if (!plan.runtime) return { pass: false, message: '灰度尚未开始' };
  const rt = plan.runtime;
  if (rt.released) return { pass: false, message: '已全量发布' };
  if (rt.frozen) return { pass: false, message: `已处于冻结状态（${rt.frozenReason ?? ''}），无需重复停止` };
  return { pass: true, message: `将从第 ${rt.stageIndex + 1} 档 ${rt.activePercent}% 回退一档` };
}

// ---------- 回退一档 + 冻结 + 建收回任务 ----------

function rollbackOneStage(
  plan: RolloutPlanLike,
  actor: string,
  reason: string,
  ctx: DispatchContext
): EngineAudit[] {
  const rt = plan.runtime!;
  const fromPercent = rt.activePercent;
  const fromStageIndex = rt.stageIndex;
  const toPercent = fromStageIndex === 0 ? 0 : plan.stages[fromStageIndex - 1].percent;
  const stageNo = fromStageIndex + 1;

  rt.stages[plan.stages[fromStageIndex].id].phase = 'frozen';
  rt.frozen = true;
  rt.frozenReason = reason;
  rt.stageIndex = Math.max(0, fromStageIndex - 1);
  rt.activePercent = toPercent;

  // 收回范围：回退后仍留在旧档命中区间 (toPercent, fromPercent] 的所有桶
  const newItems: ReclaimItem[] = [];
  for (let bucket = toPercent; bucket < fromPercent; bucket += 1) {
    const meta = { fromPercent, toPercent, stageIndex: fromStageIndex, at: ctx.at };
    newItems.push({
      id: uid('rc'),
      bucket,
      userId: `bucket-user-${String(bucket).padStart(3, '0')}`,
      status: 'pending',
      attempts: 0,
      lastError: null,
      snapshot: ctx.buildSnapshot ? ctx.buildSnapshot(bucket, meta) : defaultSnapshot(ctx.flagKey, bucket, meta)
    });
  }

  const audit: EngineAudit = {
    id: uid('a'),
    at: ctx.at,
    actor,
    action: '回退一档并冻结',
    // 这次回退只记这一条审计；收回的重试/重算只写任务日志
    detail: `第 ${stageNo} 档 ${fromPercent}% → ${toPercent}%；原因：${reason}；冻结发布，建立收回任务 ${newItems.length} 个命中快照（${toPercent}%~${fromPercent}% 命中范围）`
  };

  if (rt.reclaim && !rt.reclaim.done) {
    // 已有未完成的收回任务：新区间快照并入，旧任务随后按新档位重算
    const job = rt.reclaim;
    job.auditIds.push(audit.id);
    job.fromPercent = Math.max(job.fromPercent, fromPercent);
    job.toPercent = Math.min(job.toPercent, toPercent);
    job.items.push(...newItems);
    job.logs.push({ at: ctx.at, message: `再次回退：新增 ${newItems.length} 个待收快照（${toPercent}%~${fromPercent}%），关联回退审计 ${audit.id}` });
  } else {
    rt.reclaim = {
      id: uid('rj'),
      auditIds: [audit.id],
      fromPercent,
      toPercent,
      checkpoint: 0,
      items: newItems,
      done: newItems.length === 0,
      logs: [{ at: ctx.at, message: `建立收回任务：${newItems.length} 个命中快照待收回（${toPercent}%~${fromPercent}%）` }]
    };
  }
  return [audit];
}

// ---------- 推进一档 ----------

function applyPromote(plan: RolloutPlanLike, actor: string, ctx: DispatchContext): EngineAudit[] {
  const rt = plan.runtime!;
  const audits: EngineAudit[] = [];
  const current = plan.stages[rt.stageIndex];
  rt.stages[current.id].phase = 'healthy';

  if (rt.stageIndex >= plan.stages.length - 1) {
    rt.released = true;
    audits.push({
      id: uid('a'),
      at: ctx.at,
      actor,
      action: '全量发布',
      detail: `所有档位观察通过，${ctx.flagKey} 已 100% 放量`
    });
    rt.rev += 1;
    return audits;
  }

  const next = plan.stages[rt.stageIndex + 1];
  rt.stageIndex += 1;
  rt.activePercent = next.percent;
  rt.stages[next.id] = { phase: 'observing', observedMinutes: 0, errorRate: null, threshold: plan.errorThreshold };
  audits.push({
    id: uid('a'),
    at: ctx.at,
    actor,
    action: '推进一档',
    detail: `第 ${rt.stageIndex} 档 ${current.percent}% → 第 ${rt.stageIndex + 1} 档 ${next.percent}%；观察 ${next.observeMinutes} 分钟，错误率门禁 ${plan.errorThreshold}%`
  });

  // 档位一变，未收完的快照按新档位重算
  if (rt.reclaim && !rt.reclaim.done) {
    recalcReclaim(plan, ctx.at, '推进导致档位变化');
  }
  rt.rev += 1;
  return audits;
}

// ---------- 观察期门禁评估 ----------

function evaluateObservation(plan: RolloutPlanLike, actor: string, ctx: DispatchContext): EngineAudit[] {
  const rt = plan.runtime;
  if (!rt || rt.frozen || rt.released) return [];
  const { stage, stageRt } = currentStage(plan);
  if (stageRt.phase !== 'observing') return [];
  if (stageRt.observedMinutes < stage.observeMinutes) return [];
  if (stageRt.errorRate === null) return []; // 等数据，不判定

  if (stageRt.errorRate >= stageRt.threshold) {
    // 观察期里错误率没降下去：自动退回上一档并冻结
    const audits = rollbackOneStage(
      plan,
      actor,
      `观察期满错误率 ${stageRt.errorRate}% 未降至门禁 ${stageRt.threshold}% 以下`,
      ctx
    );
    rt.rev += 1;
    return audits;
  }

  stageRt.phase = 'healthy';
  // 观察通过不改变档位，rev 不递增；值班员仍可用原 rev 提交推进
  return [{
    id: uid('a'),
    at: ctx.at,
    actor: '系统',
    action: '观察通过',
    detail: `第 ${rt.stageIndex + 1} 档 ${stage.percent}% 观察期满，错误率 ${stageRt.errorRate}% 低于门禁 ${stageRt.threshold}%，可推进`
  }];
}

export function advanceObservation(plan: RolloutPlanLike, minutes: number, ctx: DispatchContext): CommandResult {
  if (!plan.runtime) return reject('灰度尚未开始', plan);
  const rt = plan.runtime;
  if (rt.frozen) return reject(`发布已冻结，观察计时暂停：${rt.frozenReason ?? ''}`, plan);
  if (rt.released) return reject('已全量发布', plan);
  const { stage, stageRt } = currentStage(plan);
  if (stageRt.phase !== 'observing') return reject('当前档位不在观察中（可能已通过），请推进', plan);
  const before = Math.min(stageRt.observedMinutes, stage.observeMinutes);
  stageRt.observedMinutes = Math.min(stage.observeMinutes, stageRt.observedMinutes + Math.max(0, minutes));
  const audits = evaluateObservation(plan, '系统', ctx);
  const added = stageRt.phase === 'observing' ? stageRt.observedMinutes - before : 0;
  const message = audits.length
    ? audits[0].action
    : `观察推进 ${added} 分钟（${stageRt.observedMinutes}/${stage.observeMinutes}）`;
  return audits.length ? ok(message, audits, plan) : { accepted: true, code: 'ok', message, audits: [], rev: rt.rev, activePercent: rt.activePercent, frozen: rt.frozen };
}

export function recordErrorRate(plan: RolloutPlanLike, rate: number, ctx: DispatchContext): CommandResult {
  if (!plan.runtime) return reject('灰度尚未开始', plan);
  const rt = plan.runtime;
  if (rt.frozen) return reject('发布已冻结，错误率数据不再参与判定，请先解除冻结', plan);
  if (rt.released) return reject('已全量发布', plan);
  const { stageRt, stage } = currentStage(plan);
  if (stageRt.phase !== 'observing') return reject('当前档位不在观察中', plan);
  stageRt.errorRate = rate;
  const audits = evaluateObservation(plan, '系统', ctx);
  if (audits.length) return ok(audits[0].detail, audits, plan);
  return {
    accepted: true,
    code: 'ok',
    message: `第 ${rt.stageIndex + 1} 档错误率已记录：${rate}%（门禁 ${stageRt.threshold}%，观察 ${stageRt.observedMinutes}/${stage.observeMinutes} 分钟）`,
    audits: [],
    rev: rt.rev,
    activePercent: rt.activePercent,
    frozen: rt.frozen
  };
}

export function unfreeze(plan: RolloutPlanLike, actor: string, ctx: DispatchContext): CommandResult {
  if (!plan.runtime) return reject('灰度尚未开始', plan);
  const rt = plan.runtime;
  if (!rt.frozen) return reject('当前未冻结', plan);
  rt.frozen = false;
  rt.frozenReason = null;
  // 在落档档位重新开始一轮观察，再决定能否重新推进
  const stage = plan.stages[Math.min(rt.stageIndex, plan.stages.length - 1)];
  rt.stages[stage.id] = { phase: 'observing', observedMinutes: 0, errorRate: null, threshold: plan.errorThreshold };
  rt.rev += 1;
  const audit: EngineAudit = {
    id: uid('a'),
    at: ctx.at,
    actor,
    action: '解除冻结',
    detail: `在第 ${Math.min(rt.stageIndex, plan.stages.length - 1) + 1} 档 ${rt.activePercent}% 重新开始 ${stage.observeMinutes} 分钟观察`
  };
  return ok('已解除冻结，重新观察', [audit], plan);
}

// ---------- 双人指令仲裁（乐观锁） ----------

export interface OperatorCommand {
  type: 'promote' | 'stop';
  rev: number; // 值班员本地看到的档位版本
  actor: string;
}

export function dispatch(plan: RolloutPlanLike, command: OperatorCommand, ctx: DispatchContext): CommandResult {
  if (!plan.runtime) return reject('灰度尚未开始', plan);
  const rt = plan.runtime;
  if (command.rev !== rt.rev) {
    // 后到的指令不落地，按当前新档位重新判定一次并把结论返回
    const judge = command.type === 'promote' ? judgePromote(plan) : judgeStop(plan);
    const verb = command.type === 'promote' ? '推进' : '停止';
    return {
      accepted: false,
      code: 'stale-rejudged',
      message: `${command.actor} 的${verb}指令基于旧档位 rev=${command.rev}，仅 ${command.type === 'promote' ? '首个推进' : '首个停止'} 指令落地；已按当前档位 rev=${rt.rev} 重新判定：${judge.message}`,
      audits: [],
      rev: rt.rev,
      activePercent: rt.activePercent,
      frozen: rt.frozen
    };
  }

  if (command.type === 'promote') {
    const judge = judgePromote(plan);
    if (!judge.pass) return reject(judge.message, plan);
    return ok(judge.message, applyPromote(plan, command.actor, ctx), plan);
  }

  const judge = judgeStop(plan);
  if (!judge.pass) return reject(judge.message, plan);
  const audits = rollbackOneStage(plan, command.actor, `${command.actor} 执行停止`, ctx);
  rt.rev += 1;
  return ok(`已回退至 ${rt.activePercent}% 并冻结`, audits, plan);
}

// ---------- 收回任务执行 ----------

export interface ReclaimTickOptions {
  batchSize?: number;
  willFail?: (item: ReclaimItem) => string | null; // 返回错误文案表示本次收回失败
}

export interface ReclaimTickResult {
  processed: number;
  failed: ReclaimItem | null;
  pending: number;
  done: boolean;
}

function reclaimStats(job: ReclaimJob): ReclaimTickResult {
  const pending = job.items.filter((item) => item.status === 'pending' || item.status === 'failed').length;
  return {
    processed: job.items.filter((item) => item.status === 'reclaimed').length,
    failed: job.items.find((item) => item.status === 'failed') ?? null,
    pending,
    done: job.done
  };
}

export function tickReclaim(plan: RolloutPlanLike, at: string, options: ReclaimTickOptions = {}): ReclaimTickResult {
  const job = plan.runtime?.reclaim ?? null;
  if (!job || job.done) return { processed: 0, failed: null, pending: 0, done: !!job?.done };
  const batchSize = options.batchSize ?? 5;
  let worked = 0;

  while (job.checkpoint < job.items.length && worked < batchSize) {
    const item = job.items[job.checkpoint];
    if (item.status === 'reclaimed' || item.status === 'recalculated') {
      job.checkpoint += 1;
      continue;
    }
    item.attempts += 1;
    const error = options.willFail ? options.willFail(item) : null;
    if (error) {
      item.status = 'failed';
      item.lastError = error;
      job.logs.push({ at, message: `桶 ${item.bucket} 快照收回失败（第 ${item.attempts} 次）：${error}；断点停在 ${job.checkpoint + 1}/${job.items.length}` });
      return reclaimStats(job); // 失败即停，等待从断点重试
    }
    item.status = 'reclaimed';
    item.lastError = null;
    job.logs.push({ at, message: `收回桶 ${item.bucket} 命中范围与快照（${item.id}）` });
    job.checkpoint += 1;
    worked += 1;
  }

  const remaining = job.items.slice(job.checkpoint).some((item) => item.status === 'pending' || item.status === 'failed');
  if (!remaining) {
    job.done = true;
    job.logs.push({ at, message: '收回任务完成：命中范围与快照全部回收' });
  }
  return reclaimStats(job);
}

export function retryReclaim(plan: RolloutPlanLike, at: string, options: ReclaimTickOptions = {}): ReclaimTickResult {
  const job = plan.runtime?.reclaim ?? null;
  if (!job || job.done) {
    return job ? reclaimStats(job) : { processed: 0, failed: null, pending: 0, done: true };
  }
  const item = job.items[job.checkpoint];
  if (item && item.status === 'failed') {
    item.status = 'pending';
    job.logs.push({ at, message: `从断点 ${job.checkpoint + 1}/${job.items.length} 重试桶 ${item.bucket}` });
  }
  // 重试本身不写审计；剩下的仍是待收项
  return tickReclaim(plan, at, options);
}

// 档位一变，未收完的快照按新档位重算
export function recalcReclaim(plan: RolloutPlanLike, at: string, reason: string): void {
  const rt = plan.runtime;
  const job = rt?.reclaim;
  if (!rt || !job || job.done) return;
  job.items.forEach((item) => {
    if (item.status === 'reclaimed') return;
    if (item.bucket < rt.activePercent) {
      // 该桶重新落入命中范围：快照不再收回
      item.status = 'recalculated';
      item.lastError = null;
      job.logs.push({ at, message: `档位变为 ${rt.activePercent}%：桶 ${item.bucket} 重新纳入命中范围，原收回快照作废（${reason}）` });
    } else {
      // 仍在命中范围之外：按新档位重算快照载荷，保留为待收项
      item.status = 'pending';
      const meta = { fromPercent: job.fromPercent, toPercent: rt.activePercent, stageIndex: rt.stageIndex, at };
      item.snapshot = JSON.stringify({ ...JSON.parse(item.snapshot), hitRange: `${rt.activePercent}%~${job.fromPercent}%`, recalculatedAt: at });
      job.logs.push({ at, message: `档位变为 ${rt.activePercent}%：桶 ${item.bucket} 快照按新档位重算，仍记为待收项（${reason}）` });
    }
  });
  job.toPercent = Math.min(job.toPercent, rt.activePercent);
  const nextPending = job.items.findIndex((item) => item.status === 'pending' || item.status === 'failed');
  job.checkpoint = nextPending === -1 ? job.items.length : nextPending;
  if (nextPending === -1) {
    job.done = true;
    job.logs.push({ at, message: '重算后无待收快照，收回任务结清（未新增审计）' });
  }
}

// ---------- 结果工具 ----------

function reject(message: string, plan: RolloutPlanLike): CommandResult {
  const rt = plan.runtime;
  return { accepted: false, code: 'rejected', message, audits: [], rev: rt?.rev ?? 0, activePercent: rt?.activePercent ?? 0, frozen: rt?.frozen ?? false };
}

function ok(message: string, audits: EngineAudit[], plan: RolloutPlanLike): CommandResult {
  const rt = plan.runtime!;
  return { accepted: true, code: 'ok', message, audits, rev: rt.rev, activePercent: rt.activePercent, frozen: rt.frozen };
}
