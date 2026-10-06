// 引擎测试：node --test 运行（通过 esbuild 把 TS 编成 ESM）
// 运行方式见 scripts/engine-test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateStages,
  startRollout,
  dispatch,
  recordErrorRate,
  advanceObservation,
  tickReclaim,
  retryReclaim,
  unfreeze,
  DEFAULT_STAGES
} from './rollout.ts';
import type { RolloutPlanLike, RolloutRuntime, ReclaimItem, ReclaimJob, ReclaimLog } from './rollout.ts';

function makePlan(overrides: Partial<RolloutPlanLike> = {}): RolloutPlanLike {
  return {
    stages: DEFAULT_STAGES.map((s) => ({ ...s })),
    errorThreshold: 1,
    runtime: null,
    ...overrides
  };
}
const ctx = (extra = {}) => ({ flagKey: 'checkout-v2', at: '2026-10-06T10:00', ...extra });

function rtOf(plan: RolloutPlanLike): RolloutRuntime {
  if (!plan.runtime) throw new Error('runtime should exist');
  return plan.runtime;
}
function jobOf(plan: RolloutPlanLike): ReclaimJob {
  const job = rtOf(plan).reclaim;
  if (!job) throw new Error('reclaim job should exist');
  return job;
}

function passFirstStage(plan: RolloutPlanLike, rate = 0.2) {
  const c1 = { ...ctx() };
  recordErrorRate(plan, rate, c1);
  advanceObservation(plan, 30, { ...ctx(), at: '2026-10-06T10:30' });
}

test('计划校验：比例必须严格递增、末档 100%、观察时长合法', () => {
  assert.deepEqual(validateStages(DEFAULT_STAGES), []);
  const bad = [
    { id: 'a', percent: 10, observeMinutes: 30 },
    { id: 'b', percent: 10, observeMinutes: 30 },
    { id: 'c', percent: 50, observeMinutes: 0 }
  ];
  const errors = validateStages(bad);
  assert.ok(errors.some((e) => e.includes('高于上一档')));
  assert.ok(errors.some((e) => e.includes('观察时长')));
  assert.ok(errors.some((e) => e.includes('100%')));
});

test('开始灰度只放第 1 档（1%），不是一次全量', () => {
  const plan = makePlan();
  const r = startRollout(plan, '产品负责人', ctx());
  assert.equal(r.accepted, true);
  assert.equal(rtOf(plan).activePercent, 1);
  assert.equal(rtOf(plan).stageIndex, 0);
  assert.equal(rtOf(plan).rev, 1);
  assert.equal(rtOf(plan).stages[DEFAULT_STAGES[0].id].phase, 'observing');
});

test('观察期未满不能推进；满 30 分钟且错误率达标后可推进到 10%', () => {
  const plan = makePlan();
  startRollout(plan, 'op', ctx());
  let r = dispatch(plan, { type: 'promote', rev: 1, actor: '值班甲' }, ctx());
  assert.equal(r.accepted, false, '观察期未满拒绝推进');
  assert.ok(r.message.includes('观察期未满'));

  recordErrorRate(plan, 0.5, ctx());
  r = dispatch(plan, { type: 'promote', rev: 1, actor: '值班甲' }, ctx());
  assert.equal(r.accepted, false, '有数据但时间未满仍拒绝');

  advanceObservation(plan, 30, { ...ctx(), at: '2026-10-06T10:30' });
  r = dispatch(plan, { type: 'promote', rev: 1, actor: '值班甲' }, ctx());
  assert.equal(r.accepted, true);
  assert.equal(rtOf(plan).activePercent, 10);
  assert.equal(rtOf(plan).stageIndex, 1);
  assert.equal(rtOf(plan).rev, 2);
});

test('观察期里错误率没降下去：自动退回上一档、冻结，并建立命中快照收回任务', () => {
  const plan = makePlan();
  startRollout(plan, 'op', ctx({ at: '2026-10-06T10:00' }));
  passFirstStage(plan);
  dispatch(plan, { type: 'promote', rev: 1, actor: '值班甲' }, ctx({ at: '2026-10-06T10:31' }));
  assert.equal(rtOf(plan).activePercent, 10);

  // 第 2 档观察期错误率 3.2%，超过门禁 1%
  recordErrorRate(plan, 3.2, ctx({ at: '2026-10-06T11:00' }));
  const r = advanceObservation(plan, 60, ctx({ at: '2026-10-06T12:00' }));
  assert.equal(r.frozen, true);
  assert.equal(rtOf(plan).activePercent, 1, '退回上一档 1%');
  assert.equal(rtOf(plan).stageIndex, 0, '档位索引回退');
  assert.ok(rtOf(plan).frozen);
  assert.match(rtOf(plan).frozenReason!, /3\.2%/);

  // 收回范围 (1, 10]：桶 1..9 共 9 个快照
  const job = jobOf(plan);
  assert.equal(job.items.length, 9);
  assert.deepEqual(job.items.map((i: ReclaimItem) => i.bucket), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(job.items.every((i: ReclaimItem) => i.status === 'pending'));
  const snap = JSON.parse(job.items[0].snapshot);
  assert.equal(snap.flagKey, 'checkout-v2');
  assert.equal(snap.bucket, 1);
  assert.equal(snap.hitRange, '1%~10%');

  // 这次回退只记一条审计
  assert.equal(r.audits.length, 1);
  assert.equal(r.audits[0].action, '回退一档并冻结');
  assert.equal(job.auditIds.length, 1);
});

test('冻结后推进/停止/继续观察都被拦截', () => {
  const plan = makePlan();
  startRollout(plan, 'op', ctx());
  passFirstStage(plan);
  dispatch(plan, { type: 'promote', rev: 1, actor: '甲' }, ctx());
  recordErrorRate(plan, 5, ctx());
  advanceObservation(plan, 60, ctx());
  assert.equal(rtOf(plan).frozen, true);

  let r = dispatch(plan, { type: 'promote', rev: rtOf(plan).rev, actor: '甲' }, ctx());
  assert.equal(r.accepted, false);
  assert.match(r.message, /冻结/);
  r = dispatch(plan, { type: 'stop', rev: rtOf(plan).rev, actor: '甲' }, ctx());
  assert.equal(r.accepted, false);
  assert.match(r.message, /冻结/);
  r = advanceObservation(plan, 10, ctx());
  assert.equal(r.accepted, false);
});

test('双人同时提交推进：只有一个落地，后到的按新档位重判（stale-rejudged）', () => {
  const plan = makePlan();
  startRollout(plan, 'op', ctx());
  passFirstStage(plan);

  const r1 = dispatch(plan, { type: 'promote', rev: 1, actor: '值班甲' }, ctx({ at: '2026-10-06T10:31' }));
  assert.equal(r1.accepted, true);
  assert.equal(rtOf(plan).activePercent, 10);
  assert.equal(rtOf(plan).rev, 2);

  // 值班乙拿着旧 rev=1 几乎同时点推进
  const r2 = dispatch(plan, { type: 'promote', rev: 1, actor: '值班乙' }, ctx({ at: '2026-10-06T10:31' }));
  assert.equal(r2.accepted, false);
  assert.equal(r2.code, 'stale-rejudged');
  assert.match(r2.message, /值班乙/);
  assert.match(r2.message, /观察期未满/); // 按新档（第 2 档 0/60 分钟）重判
  assert.equal(rtOf(plan).activePercent, 10, '第二个指令没有落地');
  assert.equal(rtOf(plan).rev, 2, 'rev 不再增加');
  // 只有一条推进审计
  assert.equal(r1.audits.length, 1);
});

test('双人同时提交停止：只有一个落地；已冻结后第二个停止被重判为无需重复', () => {
  const plan = makePlan();
  startRollout(plan, 'op', ctx());
  passFirstStage(plan);
  dispatch(plan, { type: 'promote', rev: 1, actor: '甲' }, ctx());
  assert.equal(rtOf(plan).rev, 2);

  const r1 = dispatch(plan, { type: 'stop', rev: 2, actor: '值班甲' }, ctx({ at: '2026-10-06T10:35' }));
  assert.equal(r1.accepted, true);
  assert.equal(rtOf(plan).activePercent, 1);
  assert.equal(rtOf(plan).frozen, true);
  assert.equal(rtOf(plan).rev, 3);

  const r2 = dispatch(plan, { type: 'stop', rev: 2, actor: '值班乙' }, ctx({ at: '2026-10-06T10:35' }));
  assert.equal(r2.accepted, false);
  assert.equal(r2.code, 'stale-rejudged');
  assert.match(r2.message, /已处于冻结状态/);
  assert.equal(rtOf(plan).rev, 3);
  assert.equal(jobOf(plan).items.length, 9);
});

test('收回失败：从断点重试；成功后继续，剩下的记为待收项；过程不写审计', () => {
  const plan = makePlan();
  startRollout(plan, 'op', ctx());
  passFirstStage(plan);
  dispatch(plan, { type: 'promote', rev: 1, actor: '甲' }, ctx());
  recordErrorRate(plan, 5, ctx());
  advanceObservation(plan, 60, ctx());
  const job = jobOf(plan);
  const auditCountBefore = job.auditIds.length;

  // 桶 1、2 成功，桶 3 失败
  let r = tickReclaim(plan, '2026-10-06T12:05', {
    batchSize: 10,
    willFail: (item: ReclaimItem) => (item.bucket === 3 ? '快照服务 500' : null)
  });
  assert.equal(r.processed, 2);
  assert.ok(r.failed);
  assert.equal(r.failed!.bucket, 3);
  assert.equal(r.pending, 7);
  assert.equal(job.checkpoint, 2, '断点停在下标 2（3/9）');

  // 断点重试，桶 3 仍失败 -> 继续停在断点，剩余仍为待收项
  r = retryReclaim(plan, '2026-10-06T12:06', {
    batchSize: 10,
    willFail: (item: ReclaimItem) => (item.bucket === 3 ? '快照服务 500' : null)
  });
  assert.equal(r.processed, 2);
  assert.equal(r.failed!.bucket, 3);
  assert.equal(job.items[2].attempts, 2);

  // 恢复后重试，全部收回
  r = retryReclaim(plan, '2026-10-06T12:07', { batchSize: 10 });
  assert.equal(r.processed, 9);
  assert.equal(r.pending, 0);
  assert.equal(r.done, true);
  assert.equal(job.auditIds.length, auditCountBefore, '重试不新增审计');
  assert.ok(job.logs.some((l: ReclaimLog) => l.message.includes('从断点 3/9 重试')));
});

test('档位一变（解除冻结后重新推进），未收完的快照按新档位重算：桶重新命中标记 recalculated，其余重算仍待收', () => {
  const plan = makePlan();
  startRollout(plan, 'op', ctx());
  passFirstStage(plan);
  dispatch(plan, { type: 'promote', rev: 1, actor: '甲' }, ctx());
  recordErrorRate(plan, 5, ctx());
  advanceObservation(plan, 60, ctx()); // 10% -> 1%，收回桶 1..9

  // 先收回桶 1、2
  let r = tickReclaim(plan, '2026-10-06T12:05', {
    batchSize: 2,
    willFail: () => null
  });
  assert.equal(r.processed, 2);
  assert.equal(r.done, false);

  // 解除冻结：在 1% 档重新观察
  let u = unfreeze(plan, '值班甲', ctx({ at: '2026-10-06T13:00' }));
  assert.equal(u.accepted, true);
  recordErrorRate(plan, 0.1, ctx({ at: '2026-10-06T13:30' }));
  advanceObservation(plan, 30, ctx({ at: '2026-10-06T13:30' }));
  // 推进到 10%：档位变化触发重算
  const p = dispatch(plan, { type: 'promote', rev: rtOf(plan).rev, actor: '甲' }, ctx({ at: '2026-10-06T13:31' }));
  assert.equal(p.accepted, true);
  assert.equal(rtOf(plan).activePercent, 10);

  const job = jobOf(plan);
  // 桶 3..9 重新落入命中范围(percent >= bucket 命中条件为 bucket < percent，桶 1..9 在 10% 下均命中）
  const recalced = job.items.filter((i: ReclaimItem) => i.status === 'recalculated');
  assert.equal(recalced.length, 7);
  assert.deepEqual(recalced.map((i: ReclaimItem) => i.bucket), [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(job.done, true, '重算后无待收项，任务结清');
  assert.ok(job.logs.some((l: ReclaimLog) => l.message.includes('重算') || l.message.includes('重新纳入命中范围')));
  // 回退仍然只有一条审计；推进是另一条正常审计，重算本身不记审计
  const rollbackAudits = p.audits; // 本次 dispatch 只有推进审计
  assert.equal(rollbackAudits.length, 1);
  assert.equal(rollbackAudits[0].action, '推进一档');
});

test('已收回的快照不受重算影响；仍在范围外的快照重算载荷后保留为待收项', async () => {
  const plan = makePlan();
  startRollout(plan, 'op', ctx());
  passFirstStage(plan);
  dispatch(plan, { type: 'promote', rev: 1, actor: '甲' }, ctx()); // 10%
  recordErrorRate(plan, 5, ctx());
  advanceObservation(plan, 60, ctx()); // 回 1%，待收桶 1..9
  // 桶 1、2 已收回
  tickReclaim(plan, 't1', { batchSize: 2 });

  const { recalcReclaim } = await import('./rollout.ts');
  const rt = rtOf(plan);
  rt.activePercent = 5; // 对应“档位一变”到 5%
  recalcReclaim(plan, 't3', '变更到 5%');

  const job = jobOf(plan);
  assert.equal(job.items[0].status, 'reclaimed', '桶 1 已收回，不动');
  assert.equal(job.items[1].status, 'reclaimed', '桶 2 已收回，不动');
  const recalced = job.items.filter((i: ReclaimItem) => i.status === 'recalculated');
  assert.deepEqual(recalced.map((i: ReclaimItem) => i.bucket), [3, 4], '桶 3、4 重新命中，快照作废');
  const pending = job.items.filter((i: ReclaimItem) => i.status === 'pending');
  assert.deepEqual(pending.map((i: ReclaimItem) => i.bucket), [5, 6, 7, 8, 9], '桶 5..9 仍待收');
  assert.ok(pending.every((i: ReclaimItem) => JSON.parse(i.snapshot).hitRange === '5%~10%'), '待收快照按新档位重算');
  assert.equal(job.done, false);
});

test('四档全部通过后 100% 全量发布，之后推进被拒绝', () => {
  const plan = makePlan();
  startRollout(plan, 'op', ctx({ at: 't0' }));
  const timings = ['t1', 't2', 't3', 't4'];
  for (let stage = 0; stage < 4; stage += 1) {
    recordErrorRate(plan, 0.1, { ...ctx(), at: timings[stage] });
    advanceObservation(plan, DEFAULT_STAGES[stage].observeMinutes, { ...ctx(), at: timings[stage] });
    const r = dispatch(plan, { type: 'promote', rev: rtOf(plan).rev, actor: '甲' }, { ...ctx(), at: timings[stage] });
    if (stage < 3) assert.equal(r.accepted, true, `推进到第 ${stage + 2} 档`);
    else assert.equal(r.audits[0].action, '全量发布');
  }
  assert.equal(rtOf(plan).activePercent, 100);
  assert.equal(rtOf(plan).released, true);
  const again = dispatch(plan, { type: 'promote', rev: rtOf(plan).rev, actor: '甲' }, ctx());
  assert.equal(again.accepted, false);
  assert.match(again.message, /全量/);
});
