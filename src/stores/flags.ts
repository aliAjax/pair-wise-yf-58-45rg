import { defineStore } from 'pinia';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; rollout: number; rules: RuleSet; status: FlagStatus; }

/** 发布档位状态：待生效 / 观察中 / 已通过 / 已回滚 / 已冻结 */
export type TierStatus = 'pending' | 'observing' | 'passed' | 'rolled-back' | 'frozen';
export interface ReleaseTier {
  index: number;
  ratio: number;          // 本档放量比例 %
  observeMinutes: number;  // 观察时长（分钟）
  maxErrorRate: number;    // 错误率阈值 %
  status: TierStatus;
  startedAt?: string;
  observeDeadline?: string;
  baselineErrorRate?: number;
  samples: ErrorSample[];
}
export interface ErrorSample { at: string; errorRate: number; }

/** 命中快照：某档位生效时已命中的用户范围 */
export type SnapshotStatus = 'active' | 'retracted' | 'pending-retract';
export interface HitSnapshot {
  id: string;
  flagId: string;
  tierIndex: number;
  ratio: number;
  scope: string[];          // 已命中用户 ID 列表
  takenAt: string;
  status: SnapshotStatus;
  checkpoint: number;       // 收回断点（档序号）
  attempts: number;         // 已尝试收回次数
}

export interface RolloutPlan {
  id: string; flagId: string; scheduledAt: string; approvals: string[];
  version: number;          // 乐观锁版本号
  tiers: ReleaseTier[];
  currentTierIndex: number;
  frozen: boolean;
}
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }

/** 操作结果：conflict 表示版本冲突，需按新档位重新判断 */
export interface ActionResult {
  ok: boolean;
  conflict?: boolean;
  reason?: string;
  currentTier?: number;
  currentRatio?: number;
  frozen?: boolean;
}

interface State {
  flags: FeatureFlag[];
  plans: RolloutPlan[];
  audit: AuditRecord[];
  snapshots: HitSnapshot[];
  activeId: string;
  actor: string;            // 当前值班员
  retractFailRate: number;  // 收回模拟失败率
}

/** 命中用户池：200 个确定性用户桶 */
const USER_POOL = Array.from({ length: 200 }, (_, i) => `u-${1001 + i}`);
function hashUser(id: string): number {
  let hash = 5381;
  for (const ch of id) hash = ((hash << 5) + hash + ch.charCodeAt(0)) >>> 0;
  return hash % 100;
}
function scopeFor(ratio: number): string[] { return USER_POOL.filter((u) => hashUser(u) < ratio); }
function nowIso() { return new Date().toISOString(); }

function defaultTiers(): ReleaseTier[] {
  return [
    { index: 0, ratio: 5, observeMinutes: 10, maxErrorRate: 5, status: 'pending', samples: [] },
    { index: 1, ratio: 20, observeMinutes: 30, maxErrorRate: 5, status: 'pending', samples: [] },
    { index: 2, ratio: 50, observeMinutes: 60, maxErrorRate: 5, status: 'pending', samples: [] },
    { index: 3, ratio: 100, observeMinutes: 120, maxErrorRate: 5, status: 'pending', samples: [] }
  ];
}

const seed: State = {
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 10, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft' },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling' }
  ],
  plans: [{ id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', approvals: [], version: 3, tiers: defaultTiers(), currentTierIndex: 0, frozen: false }],
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ],
  snapshots: [],
  actor: '值班员·张',
  retractFailRate: 0.3
};

function load(): State {
  const saved = localStorage.getItem('yf58-flag-state');
  const state: State = saved ? JSON.parse(saved) as State : structuredClone(seed);
  for (const plan of state.plans) {
    if (!plan.tiers || !plan.tiers.length) plan.tiers = defaultTiers();
    if (plan.currentTierIndex === undefined) plan.currentTierIndex = 0;
    if (plan.frozen === undefined) plan.frozen = false;
  }
  if (!state.snapshots) state.snapshots = [];
  if (!state.actor) state.actor = '值班员·张';
  if (state.retractFailRate === undefined) state.retractFailRate = 0.3;
  return state;
}

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    activeSnapshots(state): HitSnapshot[] { return state.snapshots.filter((item) => item.flagId === state.activeId); },
    pendingRetracts(state): HitSnapshot[] { return state.snapshots.filter((item) => item.flagId === state.activeId && item.status === 'pending-retract'); }
  },
  actions: {
    persist() { localStorage.setItem('yf58-flag-state', JSON.stringify(this.$state)); },
    logAudit(action: string, detail: string, actor?: string) {
      const actorName = actor ?? this.actor;
      this.audit.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toLocaleTimeString(), actor: actorName, action, detail });
      this.persist();
    },
    select(id: string) { this.activeId = id; this.persist(); },
    setActor(actor: string) { this.actor = actor; this.persist(); },
    setRetractFailRate(value: number) { this.retractFailRate = value; this.persist(); },

    updateRule(rule: Partial<RuleSet>) {
      if (!this.active) return;
      this.active.rules = { ...this.active.rules, ...rule };
      this.active.status = 'draft';
      this.activePlan && (this.activePlan.approvals = []);
      this.logAudit('修改规则', JSON.stringify(this.active.rules));
    },
    setRollout(value: number) { if (!this.active) return; this.active.rollout = value; this.logAudit('调整放量', `${this.active.key} → ${value}%`); },
    schedule(value: string) { if (!this.active || !this.activePlan) return; this.activePlan.scheduledAt = value; this.active.status = 'scheduled'; this.logAudit('设置定时', `${this.active.key} 于 ${value} 生效`); },
    approve(role: string) {
      if (!this.active || !this.activePlan || this.activePlan.approvals.includes(role)) return;
      this.activePlan.approvals.push(role);
      this.active.status = this.activePlan.approvals.length >= 2 ? 'approved' : 'draft';
      this.logAudit('审批发布', `${role} 已确认 ${this.active.key}`, role);
      this.persist();
    },

    /** 校验乐观锁版本号，冲突时返回带新档位状态的结果 */
    checkVersion(plan: RolloutPlan, baseVersion: number): ActionResult | null {
      if (plan.version === baseVersion) return null;
      const cur = plan.tiers[plan.currentTierIndex];
      return {
        ok: false, conflict: true,
        reason: `档位已被他人操作（版本 ${baseVersion} → ${plan.version}），请按新档位重新判断`,
        currentTier: plan.currentTierIndex, currentRatio: cur?.ratio, frozen: plan.frozen
      };
    },

    /** 编排发布计划：拆成几档，每档写清比例和观察时长 */
    setupTiers(rows: { ratio: number; observeMinutes: number; maxErrorRate: number }[]) {
      const flag = this.active; const plan = this.activePlan;
      if (!flag || !plan) return;
      plan.tiers = rows.map((r, i) => ({ index: i, ratio: r.ratio, observeMinutes: r.observeMinutes, maxErrorRate: r.maxErrorRate, status: 'pending' as TierStatus, samples: [] }));
      plan.currentTierIndex = 0; plan.frozen = false; plan.version++;
      this.snapshots = this.snapshots.filter((s) => s.flagId !== flag.id);
      flag.rollout = 0; flag.enabled = false;
      this.logAudit('编排发布档位', `${flag.key} 设 ${rows.length} 档：${rows.map((r) => r.ratio).join('% → ')}%`);
    },

    /** 推进一档：待生效 → 开始观察；已通过 → 激活下一档 */
    advanceTier(actor: string, baseVersion: number): ActionResult {
      const plan = this.activePlan;
      if (!plan) return { ok: false, reason: '未选择发布计划' };
      const conflict = this.checkVersion(plan, baseVersion);
      if (conflict) return conflict;
      const tier = plan.tiers[plan.currentTierIndex];
      if (!tier) return { ok: false, reason: '没有可推进的档位' };
      if (tier.status === 'pending') return this.activateTier(actor, baseVersion);
      if (tier.status === 'observing') return { ok: false, reason: '当前档位观察中，请先结束观察并判定' };
      if (tier.status === 'rolled-back' || plan.frozen) return { ok: false, reason: '计划已冻结，请先解冻再推进' };
      const next = plan.tiers[tier.index + 1];
      if (!next) return { ok: false, reason: '已是最后一档，全量发布' };
      plan.currentTierIndex = next.index;
      return this.activateTier(actor, baseVersion);
    },

    /** 激活当前档：拍命中快照、按新档位重算未收完快照 */
    activateTier(actor: string, baseVersion: number): ActionResult {
      const flag = this.active; const plan = this.activePlan;
      if (!flag || !plan) return { ok: false, reason: '未选择开关' };
      const conflict = this.checkVersion(plan, baseVersion);
      if (conflict) return conflict;
      if (plan.frozen) return { ok: false, reason: '计划已冻结，请先解冻再推进' };
      const tier = plan.tiers[plan.currentTierIndex];
      if (!tier) return { ok: false, reason: '没有可推进的档位' };
      if (tier.status === 'observing') return { ok: false, reason: '当前档位观察期未结束' };
      if (tier.status === 'passed') return { ok: false, reason: '当前档位已通过观察，请推进到下一档' };
      if (tier.status === 'rolled-back') { tier.status = 'pending'; tier.samples = []; tier.startedAt = undefined; tier.observeDeadline = undefined; tier.baselineErrorRate = undefined; }
      tier.status = 'observing';
      tier.startedAt = nowIso();
      tier.observeDeadline = new Date(Date.now() + tier.observeMinutes * 60000).toISOString();
      tier.baselineErrorRate = +(1 + Math.random() * 3).toFixed(2);
      tier.samples = [];
      flag.rollout = tier.ratio;
      flag.enabled = tier.ratio > 0;
      flag.status = 'rolling';
      this.takeSnapshot(flag, tier);
      this.recomputeSnapshots(flag.id, tier.ratio);
      plan.version++;
      this.logAudit('推进档位', `${flag.key} 第 ${tier.index + 1} 档 ${tier.ratio}% 开始观察（${tier.observeMinutes} 分钟）`, actor);
      return { ok: true };
    },

    takeSnapshot(flag: FeatureFlag, tier: ReleaseTier) {
      this.snapshots.push({
        id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        flagId: flag.id, tierIndex: tier.index, ratio: tier.ratio,
        scope: scopeFor(tier.ratio), takenAt: nowIso(),
        status: 'active', checkpoint: 0, attempts: 0
      });
    },

    /** 档位变化后，未收完的快照按新档位比例重算命中范围 */
    recomputeSnapshots(flagId: string, ratio: number) {
      for (const s of this.snapshots) {
        if (s.flagId === flagId && s.status !== 'retracted') {
          s.ratio = ratio;
          s.scope = scopeFor(ratio);
        }
      }
    },

    /** 观察采样：错误率超过阈值立即熔断回滚 */
    observeTick(actor: string): ActionResult {
      const flag = this.active; const plan = this.activePlan;
      if (!flag || !plan) return { ok: false, reason: '未选择开关' };
      const tier = plan.tiers[plan.currentTierIndex];
      if (!tier || tier.status !== 'observing') return { ok: false, reason: '当前档位不在观察期' };
      const noise = (Math.random() - 0.5) * 1.6;
      const spike = Math.random() < 0.15 ? Math.random() * 4 : 0;
      const rate = Math.max(0, +((tier.baselineErrorRate ?? 2) + noise + spike).toFixed(2));
      tier.samples.push({ at: nowIso(), errorRate: rate });
      if (rate > tier.maxErrorRate) {
        return this.rollback(actor, plan.version, `观察期错误率 ${rate}% 超过阈值 ${tier.maxErrorRate}%`);
      }
      plan.version++;
      return { ok: true };
    },

    /** 结束观察并判定：错误率没降下去（末值不低于基线或均值超阈值）就退回上一档并冻结 */
    finalizeObservation(actor: string, baseVersion: number): ActionResult {
      const flag = this.active; const plan = this.activePlan;
      if (!flag || !plan) return { ok: false, reason: '未选择开关' };
      const conflict = this.checkVersion(plan, baseVersion);
      if (conflict) return conflict;
      const tier = plan.tiers[plan.currentTierIndex];
      if (!tier || tier.status !== 'observing') return { ok: false, reason: '当前档位不在观察期' };
      if (!tier.samples.length) return { ok: false, reason: '还没有采样数据' };
      const early = !!tier.observeDeadline && Date.now() < new Date(tier.observeDeadline).getTime();
      const avg = tier.samples.reduce((sum, s) => sum + s.errorRate, 0) / tier.samples.length;
      const last = tier.samples[tier.samples.length - 1].errorRate;
      const dropped = last < (tier.baselineErrorRate ?? 0);
      if (avg > tier.maxErrorRate || !dropped) {
        return this.rollback(actor, plan.version, `观察结束错误率未降下去（末值 ${last}%，基线 ${tier.baselineErrorRate}%，均值 ${avg.toFixed(2)}%）`);
      }
      tier.status = 'passed';
      plan.version++;
      this.logAudit('观察通过', `${flag.key} 第 ${tier.index + 1} 档 ${tier.ratio}%${early ? '提前' : ''}观察结束，错误率降至 ${last}%`, actor);
      return { ok: true };
    },

    /** 值班员紧急停止：退回上一档并冻结 */
    stopAndRollback(actor: string, baseVersion: number): ActionResult {
      const plan = this.activePlan;
      if (!plan) return { ok: false, reason: '未选择发布计划' };
      const conflict = this.checkVersion(plan, baseVersion);
      if (conflict) return conflict;
      return this.rollback(actor, plan.version, '值班员紧急停止');
    },

    /** 回滚主流程：退回上一档并冻结，命中范围与快照一起收回（审计只记一条） */
    rollback(actor: string, baseVersion: number | null, reason: string): ActionResult {
      const flag = this.active; const plan = this.activePlan;
      if (!flag || !plan) return { ok: false, reason: '未选择开关' };
      if (baseVersion !== null) {
        const conflict = this.checkVersion(plan, baseVersion);
        if (conflict) return conflict;
      }
      const tier = plan.tiers[plan.currentTierIndex];
      const prevIndex = Math.max(0, (tier?.index ?? 0) - 1);
      if (tier) tier.status = 'rolled-back';
      for (const t of plan.tiers) {
        if (t.index > prevIndex && t.status !== 'rolled-back') t.status = 'rolled-back';
      }
      if (!tier || tier.index === 0) {
        // 退回起点：关闭开关
        plan.frozen = true;
        plan.currentTierIndex = 0;
        if (plan.tiers[0]) plan.tiers[0].status = 'rolled-back';
        flag.rollout = 0; flag.enabled = false; flag.status = 'stopped';
      } else {
        const prev = plan.tiers[prevIndex];
        if (prev) prev.status = 'frozen';
        plan.frozen = true;
        plan.currentTierIndex = prevIndex;
        flag.rollout = prev.ratio;
        flag.enabled = true;
        flag.status = 'rolling';
      }
      // 已命中的范围和快照一起收回
      const failedCount = this.retract(flag.id, prevIndex);
      // 档位一变，未收完的快照按新档位重算
      this.recomputeSnapshots(flag.id, flag.rollout);
      plan.version++;
      const pendingNote = failedCount > 0 ? `；${failedCount} 个快照收回失败，已记为待收项，从断点重试` : '';
      this.logAudit('回滚', `${flag.key} 退回第 ${plan.currentTierIndex + 1} 档（${flag.rollout}%）并冻结。${reason}${pendingNote}`, actor);
      return { ok: true };
    },

    /** 收回快照：失败则从断点记下，剩余全部记为待收项 */
    retract(flagId: string, targetTierIndex: number): number {
      const targets = this.snapshots
        .filter((s) => s.flagId === flagId && s.tierIndex > targetTierIndex && s.status !== 'retracted')
        .sort((a, b) => b.tierIndex - a.tierIndex || b.takenAt.localeCompare(a.takenAt));
      let failed = 0;
      for (let i = 0; i < targets.length; i++) {
        const s = targets[i];
        s.attempts++;
        if (Math.random() < this.retractFailRate) {
          s.status = 'pending-retract';
          s.checkpoint = s.tierIndex;
          failed++;
          for (const rest of targets.slice(i + 1)) {
            rest.status = 'pending-retract';
            rest.checkpoint = rest.tierIndex;
            failed++;
          }
          break;
        }
        s.status = 'retracted';
        s.scope = [];
      }
      return failed;
    },

    /** 从断点重试收回待收项 */
    retryRetract(actor: string): ActionResult {
      const flag = this.active; const plan = this.activePlan;
      if (!flag || !plan) return { ok: false, reason: '未选择开关' };
      const pending = this.snapshots
        .filter((s) => s.flagId === flag.id && s.status === 'pending-retract')
        .sort((a, b) => b.tierIndex - a.tierIndex);
      if (!pending.length) return { ok: false, reason: '没有待收项' };
      let failed = 0;
      for (const s of pending) {
        s.attempts++;
        if (Math.random() < this.retractFailRate) { s.checkpoint = s.tierIndex; failed++; break; }
        s.status = 'retracted';
        s.scope = [];
      }
      plan.version++;
      const remain = this.snapshots.filter((s) => s.flagId === flag.id && s.status === 'pending-retract').length;
      if (failed) {
        this.logAudit('收回失败', `${flag.key} 第 ${pending[0].tierIndex + 1} 档快照收回失败，断点续收，剩余 ${remain} 项待收`, actor);
        return { ok: false, reason: `收回在第 ${pending[0].tierIndex + 1} 档断点失败，剩余 ${remain} 项待收` };
      }
      this.logAudit('收回完成', `${flag.key} 待收快照全部收回`, actor);
      return { ok: true };
    },

    /** 解除冻结：重置审批，需重新审批后才能再推进 */
    unfreeze(actor: string, baseVersion: number): ActionResult {
      const flag = this.active; const plan = this.activePlan;
      if (!flag || !plan) return { ok: false, reason: '未选择计划' };
      const conflict = this.checkVersion(plan, baseVersion);
      if (conflict) return conflict;
      plan.frozen = false;
      plan.approvals = [];
      const cur = plan.tiers[plan.currentTierIndex];
      if (cur && cur.status === 'frozen') cur.status = 'passed';
      flag.status = 'approved';
      plan.version++;
      this.logAudit('解除冻结', `${flag.key} 解除冻结，审批已重置，需重新审批后再推进`, actor);
      return { ok: true };
    },

    /** 模拟两个值班员同时提交：同版本号，只让一个操作落地，后到的按新档位再判断 */
    simulateConcurrent(): { first: ActionResult; second: ActionResult } {
      const plan = this.activePlan;
      if (!plan) return { first: { ok: false, reason: '未选择计划' }, second: { ok: false, reason: '未选择计划' } };
      const base = plan.version;
      const first = this.advanceTier('值班员·张', base);
      const second = this.stopAndRollback('值班员·李', base);
      return { first, second };
    },

    simulateHit(user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
      if (!this.active || !this.active.enabled) return { hit: false, reason: '开关未启用' };
      const rule = this.active.rules;
      if (rule.region !== '全部' && rule.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rule.region}）` };
      if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户' };
      const hash = hashUser(user.id);
      const hit = hash < this.active.rollout;
      return { hit, reason: hit ? `灰度桶 ${hash} < ${this.active.rollout}%` : `灰度桶 ${hash} ≥ ${this.active.rollout}%` };
    }
  }
});
