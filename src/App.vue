<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useOnline, useNow } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore } from './stores/flags';
import type { ActionResult, ReleaseTier, SnapshotStatus, TierStatus } from './stores/flags';

const store = useFlagStore();
const online = useOnline();
const now = useNow({ interval: 1000 });
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const snapshots = computed(() => store.activeSnapshots);
const pendingCount = computed(() => store.pendingRetracts.length);
const currentTier = computed(() => plan.value?.tiers[plan.value.currentTierIndex]);

const createOpen = ref(false);
const simulation = ref<{ hit: boolean; reason: string } | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');
const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft' });
  store.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-02T10:00', approvals: [], version: 1, tiers: [], currentTierIndex: 0, frozen: false });
  store.select(id); store.logAudit('创建开关', `${values.key} 草稿版本 1`); createOpen.value = false; resetForm();
});
function simulate() { if (active.value) simulation.value = store.simulateHit(user); }
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold'; }

/** 档位编排本地编辑行 */
interface TierRow { ratio: number; observeMinutes: number; maxErrorRate: number; }
const tierRows = ref<TierRow[]>([]);
function syncTierRows() { if (plan.value) tierRows.value = plan.value.tiers.map((t) => ({ ratio: t.ratio, observeMinutes: t.observeMinutes, maxErrorRate: t.maxErrorRate })); }
watch(() => store.activeId, syncTierRows, { immediate: true });
function addTierRow() { tierRows.value.push({ ratio: 10, observeMinutes: 30, maxErrorRate: 5 }); }
function removeTierRow(index: number) { tierRows.value.splice(index, 1); }
function applyTiers() {
  const rows = tierRows.value.filter((r) => r.ratio > 0 && r.observeMinutes > 0);
  if (!rows.length) { lastResult.value = { ok: false, reason: '至少保留一档有效配置' }; return; }
  store.setupTiers(rows);
}

const conflict = ref<ActionResult | null>(null);
const lastResult = ref<ActionResult | null>(null);

function run(fn: (actor: string, version: number) => ActionResult) {
  if (!plan.value) return;
  conflict.value = null; lastResult.value = null;
  const result = fn(store.actor, plan.value.version);
  if (result.conflict) conflict.value = result;
  else if (!result.ok) lastResult.value = result;
}
function advance() { run(store.advanceTier); }
function finalize() { run(store.finalizeObservation); }
function stopAll() { run(store.stopAndRollback); }
function unfreeze() { run(store.unfreeze); }
function tick() {
  if (!plan.value) return;
  conflict.value = null; lastResult.value = null;
  const result = store.observeTick(store.actor);
  if (result.conflict) conflict.value = result;
  else if (!result.ok) lastResult.value = result;
}
function fastForward() {
  if (!plan.value) return;
  conflict.value = null; lastResult.value = null;
  let result: ActionResult = { ok: true };
  for (let i = 0; i < 8; i++) {
    result = store.observeTick(store.actor);
    if (!result.ok || result.conflict) break;
  }
  if (result.conflict) conflict.value = result;
  else if (!result.ok) lastResult.value = result;
}
function retry() {
  if (!plan.value) return;
  lastResult.value = null;
  const result = store.retryRetract(store.actor);
  if (!result.ok) lastResult.value = result;
}
/** 模拟两个值班员同时提交：同版本号，只让一个操作落地，后到的按新档位再判断 */
function concurrentDemo() {
  if (!plan.value) return;
  conflict.value = null; lastResult.value = null;
  const base = plan.value.version;
  const first = store.advanceTier('值班员·张', base);
  const second = store.stopAndRollback('值班员·李', base);
  lastResult.value = first;
  if (second.conflict) conflict.value = second;
}

/** 观察期倒计时 */
const deadlineLeft = computed(() => {
  const t = currentTier.value;
  if (!t || t.status !== 'observing' || !t.observeDeadline) return '';
  const ms = new Date(t.observeDeadline).getTime() - now.value.getTime();
  if (ms <= 0) return '观察期已结束';
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `剩余 ${min}分${sec}秒`;
});

function tierStatusColor(status?: TierStatus): string {
  return status === 'observing' ? 'processing' : status === 'passed' ? 'success' : status === 'rolled-back' ? 'error' : status === 'frozen' ? 'warning' : 'default';
}
function tierStatusText(status?: TierStatus): string {
  return status === 'observing' ? '观察中' : status === 'passed' ? '已通过' : status === 'rolled-back' ? '已回滚' : status === 'frozen' ? '已冻结' : '待生效';
}
function stepStatus(t: ReleaseTier): 'wait' | 'process' | 'finish' | 'error' {
  if (t.status === 'observing') return 'process';
  if (t.status === 'passed') return 'finish';
  if (t.status === 'rolled-back') return 'error';
  return 'wait';
}
function snapshotColor(status: SnapshotStatus): string { return status === 'retracted' ? 'default' : status === 'pending-retract' ? 'orange' : 'blue'; }
function snapshotText(status: SnapshotStatus): string { return status === 'retracted' ? '已收回' : status === 'pending-retract' ? '待收项' : '生效中'; }

const tierColumns = [
  { title: '档位', dataIndex: 'index', width: 64 },
  { title: '比例 %', dataIndex: 'ratio', width: 110 },
  { title: '观察(分)', dataIndex: 'observeMinutes', width: 110 },
  { title: '阈值 %', dataIndex: 'maxErrorRate', width: 100 },
  { title: '状态', dataIndex: 'status', width: 96 },
  { title: '采样', dataIndex: 'samples', width: 64 }
];
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar"><div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div><a-space wrap><a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag><a-radio-group :value="store.actor" button-style="solid" @change="(e: any) => store.setActor(e.target.value)"><a-radio-button value="值班员·张">值班员·张</a-radio-button><a-radio-button value="值班员·李">值班员·李</a-radio-button></a-radio-group><a-button type="primary" @click="createOpen = true">新建功能开关</a-button></a-space></a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small"><a-list :data-source="store.flags" bordered><template #renderItem="{ item }"><a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)"><a-list-item-meta><template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag></a-space></template><template #description><code>{{ item.key }}</code> · {{ item.rollout }}%</template></a-list-item-meta></a-list-item></template></a-list></a-card>
          <a-card title="规则命中模拟" size="small" class="mt"><a-form layout="vertical"><a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item><a-row :gutter="8"><a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col><a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col></a-row><a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox><a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button></a-form><a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon :message="simulation.hit ? '命中新功能' : '未命中'" :description="simulation.reason" /></a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active && plan">
            <a-card :title="active.name" class="mb"><template #extra><a-space><a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag><a-tag color="purple">版本 v{{ plan.version }}</a-tag><a-tag v-if="plan.frozen" color="red">已冻结</a-tag><a-button danger :disabled="!active.enabled" @click="stopAll">紧急停止</a-button></a-space></template>
              <a-descriptions bordered :column="{ xs: 1, md: 4 }"><a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item><a-descriptions-item label="当前放量">{{ active.rollout }}%</a-descriptions-item><a-descriptions-item label="当前档位">第 {{ (currentTier?.index ?? 0) + 1 }} 档</a-descriptions-item><a-descriptions-item label="审批">{{ plan.approvals.join('、') || '待审批' }}</a-descriptions-item></a-descriptions>

              <a-alert v-if="plan.frozen" type="error" show-icon class="mt" message="计划已冻结" description="回退后冻结在当前档位：已命中范围与快照正在/已收回，需解除冻结并重新审批后才能再推进。" />
              <a-alert v-if="conflict" type="warning" show-icon class="mt" :message="conflict.reason" :description="`后到的操作不落地，请按新档位（第 ${(conflict.currentTier ?? 0) + 1} 档 / ${conflict.currentRatio}%）重新判断后再提交。`" @close="conflict = null" />
              <a-alert v-if="lastResult && !lastResult.ok" type="error" show-icon class="mt" :message="lastResult.reason" />

              <a-divider>发布档位</a-divider>
              <a-steps :current="plan.currentTierIndex" size="small" class="mb"><a-step v-for="t in plan.tiers" :key="t.index" :title="`${t.ratio}%`" :description="`${t.observeMinutes}分钟`" :status="stepStatus(t)" /></a-steps>
              <a-table :data-source="tierRows" :columns="tierColumns" size="small" pagination="false" row-key="index" bordered>
                <template #bodyCell="{ column, index }">
                  <template v-if="column.key === 'index'">第 {{ index + 1 }} 档</template>
                  <template v-else-if="column.key === 'ratio'"><a-input-number v-model:value="tierRows[index].ratio" :min="0" :max="100" :disabled="plan.tiers[index]?.status !== 'pending'" addon-after="%" style="width: 100%" /></template>
                  <template v-else-if="column.key === 'observeMinutes'"><a-input-number v-model:value="tierRows[index].observeMinutes" :min="1" :disabled="plan.tiers[index]?.status !== 'pending'" addon-after="分" style="width: 100%" /></template>
                  <template v-else-if="column.key === 'maxErrorRate'"><a-input-number v-model:value="tierRows[index].maxErrorRate" :min="0" :max="100" :disabled="plan.tiers[index]?.status !== 'pending'" addon-after="%" style="width: 100%" /></template>
                  <template v-else-if="column.key === 'status'"><a-tag :color="tierStatusColor(plan.tiers[index]?.status)">{{ tierStatusText(plan.tiers[index]?.status) }}</a-tag></template>
                  <template v-else-if="column.key === 'samples'">{{ plan.tiers[index]?.samples?.length ?? 0 }}</template>
                </template>
              </a-table>
              <a-space class="mt" wrap><a-button size="small" @click="addTierRow">加一档</a-button><a-button size="small" danger @click="tierRows.pop()">删末尾档</a-button><a-button size="small" type="primary" ghost @click="applyTiers">应用档位方案</a-button><span class="hint">观察时长/比例需在待生效状态调整</span></a-space>

              <a-alert v-if="currentTier?.status === 'observing'" type="blue" show-icon class="mt" :message="`第 ${currentTier.index + 1} 档观察中：基线 ${currentTier.baselineErrorRate}%，已采样 ${currentTier.samples.length} 次，${deadlineLeft}`">
                <template #description><a-space wrap><a-tag v-for="(s, i) in currentTier.samples" :key="i" :color="s.errorRate > currentTier.maxErrorRate ? 'red' : 'blue'">{{ s.errorRate }}%</a-tag><span class="hint">末值需低于基线 {{ currentTier.baselineErrorRate }}% 才算错误率降下去</span></a-space></template>
              </a-alert>

              <a-space class="tier-actions" wrap>
                <a-button type="primary" :disabled="plan.frozen || currentTier?.status === 'observing'" @click="advance">{{ currentTier?.status === 'pending' ? '开始观察' : '推进到下一档' }}</a-button>
                <a-button :disabled="currentTier?.status !== 'observing'" @click="tick">模拟一次采样</a-button>
                <a-button :disabled="currentTier?.status !== 'observing'" @click="fastForward">快进 8 次采样</a-button>
                <a-button :disabled="currentTier?.status !== 'observing'" @click="finalize">结束观察并判定</a-button>
                <a-button v-if="plan.frozen" type="primary" ghost @click="unfreeze">解除冻结</a-button>
                <a-button danger ghost @click="concurrentDemo">模拟双人同时提交</a-button>
              </a-space>

              <a-divider>已命中快照与待收项<a-tag v-if="pendingCount" color="orange" class="ml">{{ pendingCount }} 待收</a-tag></a-divider>
              <a-space class="mt" wrap><a-button :disabled="!pendingCount" @click="retry">从断点重试收回</a-button><span class="hint">收回失败率 <a-slider class="fail-slider" :min="0" :max="0.8" :step="0.05" :value="store.retractFailRate" @change="(v: number) => store.setRetractFailRate(v)" /> {{ Math.round(store.retractFailRate * 100) }}%</span></a-space>
              <a-list class="mt" :data-source="snapshots" size="small" bordered><template #renderItem="{ item }"><a-list-item><a-list-item-meta><template #title><a-space><a-tag :color="snapshotColor(item.status)">{{ snapshotText(item.status) }}</a-tag><span>第 {{ item.tierIndex + 1 }} 档 · {{ item.ratio }}%</span></a-space></template><template #description>命中 {{ item.scope.length }} 人 · 已尝试 {{ item.attempts }} 次<template v-if="item.checkpoint"> · 断点：第 {{ item.checkpoint + 1 }} 档</template> · {{ item.takenAt }}</template></a-list-item-meta></a-list-item></template></a-list>

              <a-divider>规则组合</a-divider><a-form layout="vertical"><a-row :gutter="16"><a-col :span="8"><a-form-item label="目标地区"><a-select :value="active.rules.region" :options="['全部','上海','北京','广东'].map(value => ({ value, label: value }))" @change="(value: string) => store.updateRule({ region: value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="客户端版本"><a-input :value="active.rules.appVersion" @change="(event: Event) => store.updateRule({ appVersion: (event.target as HTMLInputElement).value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="登录要求"><a-switch :checked="active.rules.authenticated" @change="(checked: boolean) => store.updateRule({ authenticated: checked })" /></a-form-item></a-col></a-row></a-form>
              <a-divider>逐步放量</a-divider><a-slider :value="active.rollout" :min="0" :max="100" :step="5" @change="(value: number) => store.setRollout(value)" /><div class="rollout-label">{{ active.rollout }}% 用户可命中</div>
              <a-divider>定时生效</a-divider><a-space><a-input type="datetime-local" :value="plan.scheduledAt" @change="(event: Event) => store.schedule((event.target as HTMLInputElement).value)" /><a-button @click="store.schedule(plan.scheduledAt)">保存定时</a-button></a-space>
              <a-divider>审批与发布</a-divider><a-space><a-button :disabled="plan.approvals.includes('产品负责人')" @click="store.approve('产品负责人')">产品审批</a-button><a-button :disabled="plan.approvals.includes('研发负责人')" @click="store.approve('研发负责人')">研发审批</a-button><span class="hint">审批通过后即可在上方按档位推进灰度</span></a-space>
            </a-card>
            <a-card title="审计记录"><a-timeline><a-timeline-item v-for="item in store.audit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回滚') || item.action.includes('失败') ? 'red' : 'blue'"><b>{{ item.at }} · {{ item.actor }}</b><p>{{ item.action }}：{{ item.detail }}</p></a-timeline-item></a-timeline></a-card>
          </template>
        </a-col>
      </a-row>
    </a-layout-content>
    <a-modal v-model:open="createOpen" title="新建功能开关" @ok="create"><a-form layout="vertical"><a-form-item label="展示名称" :validate-status="errors.name ? 'error' : ''" :help="errors.name"><a-input v-model:value="name" /></a-form-item><a-form-item label="开关 Key" :validate-status="errors.key ? 'error' : ''" :help="errors.key"><a-input v-model:value="key" /></a-form-item></a-form></a-modal>
  </a-layout></a-config-provider>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; background: #f4f6fb; font-family: Inter, "PingFang SC", sans-serif; }
.app-shell { min-height: 100vh; background: transparent; }
.topbar { height: auto; min-height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 32px; color: white; background: linear-gradient(120deg, #111827, #312e81); }
.topbar h1 { color: white; margin: 3px 0; font-size: 25px; }
.eyebrow { color: #a5b4fc; font-size: 11px; letter-spacing: .13em; }
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }.ml { margin-left: 8px; }
.selected { background: #eef2ff; cursor: pointer; }.rollout-label { color: #4338ca; font-weight: 700; }.ant-list-item { cursor: pointer; }
.tier-actions { margin-top: 14px; }
.hint { color: #6b7280; font-size: 12px; }
.fail-slider { width: 120px; margin: 0 8px; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
