import { defineStore } from 'pinia';
import {
  DEFAULT_STAGES,
  type RolloutStage,
  type RolloutRuntime,
  type ReclaimJob,
  type EngineAudit,
  type CommandResult,
  validateStages,
  startRollout,
  dispatch,
  recordErrorRate,
  advanceObservation,
  tickReclaim,
  retryReclaim,
  unfreeze,
  type ReclaimTickResult
} from '../services/rollout';

export type FlagStatus = 'draft' | 'approved' | 'rolling' | 'scheduled' | 'stopped' | 'rolled-back';
export interface RuleSet { region: string; appVersion: string; authenticated: boolean; }
export interface FeatureFlag { id: string; name: string; key: string; enabled: boolean; rollout: number; rules: RuleSet; status: FlagStatus; }
export interface RolloutPlan {
  id: string;
  flagId: string;
  scheduledAt: string;
  approvals: string[];
  version: number;
  stages: RolloutStage[];
  errorThreshold: number;
  runtime: RolloutRuntime | null;
}
export interface AuditRecord { id: string; at: string; actor: string; action: string; detail: string; }
export interface Feedback { type: 'success' | 'info' | 'warning' | 'error'; message: string; }

interface State { flags: FeatureFlag[]; plans: RolloutPlan[]; audit: AuditRecord[]; activeId: string; feedback: Feedback | null; }

const seed: State = {
  activeId: 'f1',
  flags: [
    { id: 'f1', name: '新版结算页', key: 'checkout-v2', enabled: false, rollout: 0, rules: { region: '上海', appVersion: '>= 8.2', authenticated: true }, status: 'draft' },
    { id: 'f2', name: '推荐模型 B', key: 'recommend-model-b', enabled: true, rollout: 35, rules: { region: '全部', appVersion: '>= 8.0', authenticated: false }, status: 'rolling' }
  ],
  plans: [
    { id: 'p1', flagId: 'f1', scheduledAt: '2026-10-01T10:00', approvals: [], version: 3, stages: structuredClone(DEFAULT_STAGES), errorThreshold: 1, runtime: null },
    { id: 'p2', flagId: 'f2', scheduledAt: '2026-10-01T10:00', approvals: ['产品负责人', '研发负责人'], version: 1, stages: structuredClone(DEFAULT_STAGES), errorThreshold: 1, runtime: null }
  ],
  audit: [
    { id: 'a1', at: '09:10', actor: '产品负责人', action: '创建草稿', detail: 'checkout-v2 规则草案 v3' },
    { id: 'a2', at: '09:22', actor: '研发负责人', action: '规则校验', detail: '依赖 payment-v3 已启用' }
  ],
  feedback: null
};

function now(): string { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

function load(): State {
  const saved = localStorage.getItem('yf58-flag-state');
  if (!saved) return structuredClone(seed);
  const state = JSON.parse(saved) as State;
  // 旧版本数据补齐分档字段
  state.feedback = null;
  state.plans = state.plans.map((plan) => ({
    ...plan,
    stages: plan.stages ?? structuredClone(DEFAULT_STAGES),
    errorThreshold: plan.errorThreshold ?? 1,
    runtime: plan.runtime ?? null
  }));
  return state;
}

export const useFlagStore = defineStore('flags', {
  state: () => load(),
  getters: {
    active(state): FeatureFlag | undefined { return state.flags.find((item) => item.id === state.activeId); },
    activePlan(state): RolloutPlan | undefined { return state.plans.find((item) => item.flagId === state.activeId); },
    reclaim(): ReclaimJob | null { return this.activePlan?.runtime?.reclaim ?? null; },
    stageErrors(): string[] { return this.activePlan ? validateStages(this.activePlan.stages) : []; }
  },
  actions: {
    persist() { localStorage.setItem('yf58-flag-state', JSON.stringify(this.$state)); },
    audit(action: string, detail: string, actor = '当前操作人') { this.audit.unshift({ id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: now(), actor, action, detail }); this.persist(); },
    notify(type: Feedback['type'], message: string) { this.feedback = { type, message }; },
    clearFeedback() { this.feedback = null; },
    select(id: string) { this.activeId = id; this.feedback = null; this.persist(); },
    updateRule(rule: Partial<RuleSet>) { if (!this.active) return; this.active.rules = { ...this.active.rules, ...rule }; this.active.status = 'draft'; const p = this.activePlan; if (p) p.approvals = []; this.audit('修改规则', JSON.stringify(this.active.rules)); },
    schedule(value: string) { if (!this.active || !this.activePlan) return; this.activePlan.scheduledAt = value; this.active.status = 'scheduled'; this.audit('设置定时', `${this.active.key} 于 ${value} 生效`); },
    approve(role: string) { if (!this.active || !this.activePlan || this.activePlan.approvals.includes(role)) return; this.activePlan.approvals.push(role); this.active.status = this.activePlan.approvals.length >= 2 ? 'approved' : 'draft'; this.audit('审批发布', `${role} 已确认 ${this.active.key}`, role); this.persist(); },
    emergencyStop() { if (!this.active) return; this.active.enabled = false; this.active.status = 'stopped'; this.audit('紧急停止', `${this.active.key} 已立即关闭`); },
    rollback() { if (!this.active) return; this.active.enabled = false; this.active.rollout = 0; this.active.status = 'rolled-back'; this.audit('执行回滚', `${this.active.key} 回滚至关闭状态`); },
    simulateHit(user: { region: string; appVersion: string; authenticated: boolean; id: string }) {
      if (!this.active) return { hit: false, reason: '未选择开关' };
      if (!this.active.enabled) return { hit: false, reason: '开关未启用' };
      const rule = this.active.rules;
      if (rule.region !== '全部' && rule.region !== user.region) return { hit: false, reason: `地区不匹配（要求${rule.region}）` };
      if (rule.authenticated && !user.authenticated) return { hit: false, reason: '要求已登录用户' };
      const hash = [...user.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100;
      const hit = hash < this.active.rollout;
      return { hit, reason: hit ? `灰度桶 ${hash} < ${this.active.rollout}%` : `灰度桶 ${hash} ≥ ${this.active.rollout}%` };
    },

    // ---------- 分档计划 ----------
    updateStage(index: number, patch: Partial<RolloutStage>) {
      const plan = this.activePlan;
      if (!plan || plan.runtime) return;
      plan.stages[index] = { ...plan.stages[index], ...patch };
      this.persist();
    },
    setErrorThreshold(value: number) {
      const plan = this.activePlan;
      if (!plan || plan.runtime) return;
      plan.errorThreshold = value;
      this.persist();
    },
    addStage() {
      const plan = this.activePlan;
      if (!plan || plan.runtime || plan.stages.length >= 8) return;
      const last = plan.stages[plan.stages.length - 1];
      plan.stages.splice(plan.stages.length - 1, 0, {
        id: `s-${Date.now()}`,
        percent: Math.min(99, Math.max(last.percent, 1) + 10),
        observeMinutes: 60
      });
      this.persist();
    },
    removeStage(index: number) {
      const plan = this.activePlan;
      if (!plan || plan.runtime || plan.stages.length <= 2) return;
      plan.stages.splice(index, 1);
      this.persist();
    },

    // ---------- 分档灰度编排 ----------
    ctx(flagKey: string) { return { flagKey, at: new Date().toISOString() }; },
    applyResult(result: CommandResult): CommandResult {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan) return result;
      (result.audits as EngineAudit[]).forEach((entry) => this.audit(entry.action, entry.detail, entry.actor));
      if (plan.runtime) {
        flag.rollout = plan.runtime.activePercent;
        flag.enabled = plan.runtime.activePercent > 0 && !plan.runtime.frozen ? true : flag.enabled;
        if (plan.runtime.frozen) flag.status = 'stopped';
        else if (plan.runtime.released) flag.status = 'rolling';
        else if (plan.runtime.activePercent > 0) flag.status = 'rolling';
      }
      const type: Feedback['type'] = !result.accepted ? (result.code === 'stale-rejudged' ? 'warning' : 'error') : 'success';
      this.notify(type, result.message);
      this.persist();
      return result;
    },

    startGatedRollout(actor: string) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan) return;
      const result = startRollout(plan, actor, this.ctx(flag.key));
      this.applyResult(result);
    },
    operatorPromote(actor: string) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || !plan.runtime) { this.notify('warning', '灰度尚未开始'); return; }
      const result = dispatch(plan, { type: 'promote', rev: plan.runtime.rev, actor }, this.ctx(flag.key));
      this.applyResult(result);
    },
    operatorStop(actor: string) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan || !plan.runtime) { this.notify('warning', '灰度尚未开始'); return; }
      const result = dispatch(plan, { type: 'stop', rev: plan.runtime.rev, actor }, this.ctx(flag.key));
      this.applyResult(result);
    },
    reportError(rate: number) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan) return;
      const result = recordErrorRate(plan, rate, this.ctx(flag.key));
      this.applyResult(result);
    },
    observeMinutes(minutes: number) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan) return;
      const result = advanceObservation(plan, minutes, this.ctx(flag.key));
      this.applyResult(result);
    },
    releaseFreeze(actor: string) {
      const flag = this.active;
      const plan = this.activePlan;
      if (!flag || !plan) return;
      const result = unfreeze(plan, actor, this.ctx(flag.key));
      this.applyResult(result);
    },

    // ---------- 收回任务 ----------
    applyReclaimResult(result: ReclaimTickResult) {
      const job = this.reclaim;
      if (!job) return;
      if (result.failed) this.notify('warning', `桶 ${result.failed.bucket} 快照收回失败：${result.failed.lastError}；已停在断点，可重试`);
      else if (result.done) this.notify('success', '命中范围与快照已全部收回');
      else this.notify('info', `本批收回完成：已收 ${result.processed}，待收 ${result.pending}`);
      this.persist();
    },
    reclaimTick(batchSize: number, simulateFailure: boolean) {
      const plan = this.activePlan;
      if (!plan?.runtime?.reclaim || plan.runtime.reclaim.done) return;
      const result = tickReclaim(plan, now(), {
        batchSize,
        willFail: simulateFailure ? (item) => (item.status === 'pending' && item.attempts === 0 ? '快照服务暂时不可用（模拟）' : null) : undefined
      });
      this.applyReclaimResult(result);
    },
    reclaimRetry(batchSize: number) {
      const plan = this.activePlan;
      if (!plan?.runtime?.reclaim || plan.runtime.reclaim.done) return;
      const result = retryReclaim(plan, now(), { batchSize });
      this.applyReclaimResult(result);
    }
  }
});
