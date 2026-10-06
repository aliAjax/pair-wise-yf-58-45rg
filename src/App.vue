<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useOnline } from '@vueuse/core';
import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { z } from 'zod';
import { useFlagStore } from './stores/flags';
import { STAGE_PHASE_LABEL, type ReclaimItem } from './services/rollout';

const store = useFlagStore();
const online = useOnline();
const active = computed(() => store.active);
const plan = computed(() => store.activePlan);
const runtime = computed(() => plan.value?.runtime ?? null);
const reclaim = computed(() => store.reclaim);
const createOpen = ref(false);
const simulation = ref<{ hit: boolean; reason: string } | null>(null);
const user = reactive({ id: 'user-1042', region: '上海', appVersion: '8.3.0', authenticated: true });
const schema = toTypedSchema(z.object({ name: z.string().min(3), key: z.string().regex(/^[a-z0-9-]+$/, '仅支持小写字母、数字和连字符') }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema });
const [name] = defineField('name');
const [key] = defineField('key');

const operator = ref('值班甲');
const operators = ['值班甲', '值班乙'];
const errorInput = ref(0.5);
const simulateFailure = ref(true);
const batchSize = 3;

const create = handleSubmit((values) => {
  const id = `f-${Date.now()}`;
  const stages = [{ id: `s-${Date.now()}-1`, percent: 1, observeMinutes: 30 }, { id: `s-${Date.now()}-2`, percent: 10, observeMinutes: 60 }, { id: `s-${Date.now()}-3`, percent: 50, observeMinutes: 120 }, { id: `s-${Date.now()}-4`, percent: 100, observeMinutes: 240 }];
  store.flags.push({ id, name: values.name, key: values.key, enabled: false, rollout: 0, rules: { region: '全部', appVersion: '>= 1.0', authenticated: false }, status: 'draft' });
  store.plans.push({ id: `p-${Date.now()}`, flagId: id, scheduledAt: '2026-10-02T10:00', approvals: [], version: 1, stages, errorThreshold: 1, runtime: null });
  store.select(id); store.audit('创建开关', `${values.key} 草稿版本 1`); createOpen.value = false; resetForm();
});

function simulate() { if (active.value) simulation.value = store.simulateHit(user); }
function statusColor(status?: string) { return status === 'rolling' ? 'green' : status === 'approved' ? 'blue' : status === 'stopped' || status === 'rolled-back' ? 'red' : 'gold'; }
function stageStatus(index: number) {
  const rt = runtime.value;
  const stage = plan.value?.stages[index];
  if (!rt || !stage) return 'wait';
  const phase = rt.stages[stage.id]?.phase;
  if (phase === 'frozen') return 'error';
  if (phase === 'healthy') return 'finish';
  if (phase === 'observing') return 'process';
  return 'wait';
}
function reclaimColor(item: ReclaimItem) {
  return item.status === 'reclaimed' ? 'green' : item.status === 'recalculated' ? 'gold' : item.status === 'failed' ? 'red' : 'default';
}
const reclaimLabel: Record<ReclaimItem['status'], string> = { pending: '待收', reclaimed: '已收回', failed: '失败', recalculated: '重算作废' };
const reclaimSummary = computed(() => {
  const job = reclaim.value;
  if (!job) return null;
  return {
    reclaimed: job.items.filter((i) => i.status === 'reclaimed').length,
    pending: job.items.filter((i) => i.status === 'pending').length,
    failed: job.items.filter((i) => i.status === 'failed').length,
    recalced: job.items.filter((i) => i.status === 'recalculated').length
  };
});
</script>

<template>
  <a-config-provider><a-layout class="app-shell">
    <a-layout-header class="topbar"><div><div class="eyebrow">FEATURE FLAG / PORT 62023</div><h1>{{ $t('title') }}</h1></div><a-space><a-tag :color="online ? 'green' : 'orange'">{{ online ? '控制面在线' : '离线草稿' }}</a-tag><a-button type="primary" @click="createOpen = true">新建功能开关</a-button></a-space></a-layout-header>
    <a-layout-content class="content">
      <a-alert v-if="!online" type="warning" show-icon message="离线状态" description="规则修改保留在浏览器，恢复网络后仍需完成审批才能发布。" class="mb" />
      <a-alert v-if="store.feedback" :type="store.feedback.type" show-icon closable :message="store.feedback.message" class="mb" @close="store.clearFeedback()" />
      <a-row :gutter="[18,18]">
        <a-col :xs="24" :lg="7">
          <a-card title="功能开关" size="small"><a-list :data-source="store.flags" bordered><template #renderItem="{ item }"><a-list-item :class="{ selected: item.id === store.activeId }" @click="store.select(item.id)"><a-list-item-meta><template #title><a-space><span>{{ item.name }}</span><a-tag :color="statusColor(item.status)">{{ item.status }}</a-tag></a-space></template><template #description><code>{{ item.key }}</code> · {{ item.rollout }}%</template></a-list-item-meta></a-list-item></template></a-list></a-card>
          <a-card title="规则命中模拟" size="small" class="mt"><a-form layout="vertical"><a-form-item label="用户 ID"><a-input v-model:value="user.id" /></a-form-item><a-row :gutter="8"><a-col :span="12"><a-form-item label="地区"><a-input v-model:value="user.region" /></a-form-item></a-col><a-col :span="12"><a-form-item label="版本"><a-input v-model:value="user.appVersion" /></a-form-item></a-col></a-row><a-checkbox v-model:checked="user.authenticated">已登录</a-checkbox><a-button type="primary" block class="mt" @click="simulate">{{ $t('simulate') }}</a-button></a-form><a-alert v-if="simulation" class="mt" :type="simulation.hit ? 'success' : 'info'" show-icon :message="simulation.hit ? '命中新功能' : '未命中'" :description="simulation.reason" /></a-card>
        </a-col>
        <a-col :xs="24" :lg="17">
          <template v-if="active && plan">
            <a-card :title="active.name" class="mb"><template #extra><a-space><a-tag :color="statusColor(active.status)">{{ active.status }}</a-tag><a-button danger :disabled="!active.enabled" @click="store.emergencyStop">紧急停止</a-button><a-button danger ghost @click="store.rollback">回滚</a-button></a-space></template>
              <a-descriptions bordered :column="{ xs: 1, md: 3 }"><a-descriptions-item label="开关 Key"><code>{{ active.key }}</code></a-descriptions-item><a-descriptions-item label="当前放量">{{ active.rollout }}%</a-descriptions-item><a-descriptions-item label="审批">{{ plan.approvals.join('、') || '待审批' }}</a-descriptions-item></a-descriptions>
              <a-divider>规则组合</a-divider><a-form layout="vertical"><a-row :gutter="16"><a-col :span="8"><a-form-item label="目标地区"><a-select :value="active.rules.region" :options="['全部','上海','北京','广东'].map(value => ({ value, label: value }))" @change="(value: string) => store.updateRule({ region: value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="客户端版本"><a-input :value="active.rules.appVersion" @change="(event: Event) => store.updateRule({ appVersion: (event.target as HTMLInputElement).value })" /></a-form-item></a-col><a-col :span="8"><a-form-item label="登录要求"><a-switch :checked="active.rules.authenticated" @change="(checked: boolean) => store.updateRule({ authenticated: checked })" /></a-form-item></a-col></a-row></a-form>

              <a-divider>分档发布计划</a-divider>
              <a-alert v-for="(err, i) in store.stageErrors" :key="i" type="error" :message="err" show-icon class="mb" />
              <a-table
                :data-source="plan.stages"
                :pagination="false"
                size="small"
                :row-key="(r: { id: string }) => r.id"
                :columns="[
                  { title: '档位', key: 'no', width: 70 },
                  { title: '放量比例', key: 'percent', width: 160 },
                  { title: '观察时长（分钟）', key: 'observe', width: 190 },
                  { title: '状态', key: 'phase' }
                ]"
              >
                <template #bodyCell="{ column, index, record }">
                  <template v-if="column.key === 'no'">第 {{ index + 1 }} 档</template>
                  <template v-else-if="column.key === 'percent'">
                    <a-input-number v-if="!runtime" :value="record.percent" :min="1" :max="100" addon-after="%" @update:value="(v: number) => store.updateStage(index, { percent: v ?? 0 })" />
                    <span v-else>{{ record.percent }}%</span>
                  </template>
                  <template v-else-if="column.key === 'observe'">
                    <a-input-number v-if="!runtime" :value="record.observeMinutes" :min="1" :step="15" addon-after="分" @update:value="(v: number) => store.updateStage(index, { observeMinutes: v ?? 1 })" />
                    <span v-else>{{ record.observeMinutes }} 分钟</span>
                  </template>
                  <template v-else-if="column.key === 'phase'">
                    <a-tag :color="stageStatus(index) === 'error' ? 'red' : stageStatus(index) === 'finish' ? 'green' : stageStatus(index) === 'process' ? 'blue' : 'default'">
                      {{ runtime ? STAGE_PHASE_LABEL[runtime.stages[record.id]?.phase ?? 'pending'] : '待发布' }}
                    </a-tag>
                    <span v-if="runtime && runtime.stageIndex === index" class="rollout-label">
                      当前 {{ runtime.stages[record.id]?.observedMinutes ?? 0 }}/{{ record.observeMinutes }} 分
                      <template v-if="runtime.stages[record.id]?.errorRate !== null">，错误率 {{ runtime.stages[record.id]?.errorRate }}%</template>
                    </span>
                  </template>
                </template>
              </a-table>
              <a-space class="mt">
                <a-button v-if="!runtime" size="small" :disabled="plan.stages.length >= 8" @click="store.addStage()">加一档</a-button>
                <span>错误率门禁：<a-input-number v-if="!runtime" :value="plan.errorThreshold" :min="0.1" :step="0.1" addon-after="%" @update:value="(v: number) => store.setErrorThreshold(v ?? 1)" style="width: 120px" /><b v-else>{{ plan.errorThreshold }}%</b></span>
              </a-space>

              <a-divider>定时生效</a-divider><a-space><a-input type="datetime-local" :value="plan.scheduledAt" @change="(event: Event) => store.schedule((event.target as HTMLInputElement).value)" /><a-button @click="store.schedule(plan.scheduledAt)">保存定时</a-button></a-space>

              <a-divider>审批与发布</a-divider>
              <a-space wrap>
                <a-button :disabled="plan.approvals.includes('产品负责人')" @click="store.approve('产品负责人')">产品审批</a-button>
                <a-button :disabled="plan.approvals.includes('研发负责人')" @click="store.approve('研发负责人')">研发审批</a-button>
                <a-button type="primary" :disabled="plan.approvals.length < 2 || store.stageErrors.length > 0 || !!runtime" @click="store.startGatedRollout(operator)">开始灰度（第 1 档 {{ plan.stages[0]?.percent }}%）</a-button>
              </a-space>
            </a-card>

            <a-card v-if="runtime" title="灰度运行台" class="mb">
              <a-descriptions bordered :column="{ xs: 1, md: 4 }" size="small">
                <a-descriptions-item label="档位版本 rev">{{ runtime.rev }}</a-descriptions-item>
                <a-descriptions-item label="当前档位">第 {{ runtime.stageIndex + 1 }} 档 · {{ runtime.activePercent }}%</a-descriptions-item>
                <a-descriptions-item label="状态">
                  <a-tag :color="runtime.frozen ? 'red' : runtime.released ? 'green' : 'blue'">{{ runtime.released ? '已全量' : runtime.frozen ? '已冻结' : '观察/发布中' }}</a-tag>
                </a-descriptions-item>
                <a-descriptions-item label="开始时间">{{ runtime.startedAt }}</a-descriptions-item>
              </a-descriptions>
              <a-alert v-if="runtime.frozen" class="mt" type="error" show-icon message="发布已冻结，推进与停止均被拦截" :description="runtime.frozenReason ?? ''" />
              <a-alert v-else-if="runtime.released" class="mt" type="success" show-icon message="全部档位观察通过，功能已 100% 放量" />

              <template v-if="!runtime.released">
                <a-divider orientation="left">观察期门禁</a-divider>
                <a-space wrap>
                  <span>错误率上报：<a-input-number v-model:value="errorInput" :min="0" :step="0.1" addon-after="%" style="width: 130px" :disabled="runtime.frozen" /></span>
                  <a-button :disabled="runtime.frozen" @click="store.reportError(errorInput)">上报错误率</a-button>
                  <a-button :disabled="runtime.frozen" @click="store.observeMinutes(15)">观察 +15 分</a-button>
                  <a-button :disabled="runtime.frozen" @click="store.observeMinutes(60)">观察 +60 分</a-button>
                  <a-button :disabled="runtime.frozen" @click="store.observeMinutes(9999)">走满本档观察</a-button>
                </a-space>
                <p class="hint">观察时间走满时自动判定：错误率不低于门禁 {{ plan.errorThreshold }}% 即自动退回上一档并冻结。</p>

                <a-divider orientation="left">双人值班指令（乐观锁，同一 rev 只有一个操作落地）</a-divider>
                <a-space wrap>
                  <a-radio-group v-model:value="operator" :options="operators" option-type="button" button-style="solid" />
                  <a-button type="primary" :disabled="runtime.frozen" @click="store.operatorPromote(operator)">推进下一档</a-button>
                  <a-button danger :disabled="runtime.frozen" @click="store.operatorStop(operator)">停止（回退一档并冻结）</a-button>
                  <a-button v-if="runtime.frozen" @click="store.releaseFreeze(operator)">解除冻结，重新观察</a-button>
                </a-space>
                <p class="hint">两位值班员几乎同时提交时：拿着旧 rev 的后到指令不会落地，系统按新档位重新判定并提示原因。</p>
              </template>
            </a-card>

            <a-card v-if="reclaim" title="命中范围与快照收回" class="mb">
              <a-space wrap class="mb">
                <a-tag color="blue">区间 {{ reclaim.toPercent }}%~{{ reclaim.fromPercent }}%</a-tag>
                <a-tag color="green">已收回 {{ reclaimSummary?.reclaimed }}</a-tag>
                <a-tag>待收 {{ reclaimSummary?.pending }}</a-tag>
                <a-tag color="red">失败 {{ reclaimSummary?.failed }}</a-tag>
                <a-tag color="gold">重算作废 {{ reclaimSummary?.recalced }}</a-tag>
                <a-tag>断点 {{ reclaim.checkpoint }}/{{ reclaim.items.length }}</a-tag>
                <a-tag :color="reclaim.done ? 'green' : 'orange'">{{ reclaim.done ? '已结清' : '进行中' }}</a-tag>
              </a-space>
              <a-space wrap>
                <a-checkbox v-model:checked="simulateFailure">本批注入一次收回失败</a-checkbox>
                <a-button type="primary" :disabled="reclaim.done" @click="store.reclaimTick(batchSize, simulateFailure)">收回一批（{{ batchSize }} 个）</a-button>
                <a-button :disabled="reclaim.done || reclaimSummary?.failed === 0" @click="store.reclaimRetry(batchSize)">从断点重试</a-button>
              </a-space>
              <p class="hint">收回失败立即停在断点，剩余项保留为待收；重试与重算不产生回退审计（每次回退只记一条）。</p>
              <a-table :data-source="reclaim.items" :pagination="{ pageSize: 5, size: 'small' }" size="small" :row-key="(r: ReclaimItem) => r.id" class="mt"
                :columns="[
                  { title: '桶', dataIndex: 'bucket', width: 70 },
                  { title: '用户', dataIndex: 'userId', width: 160 },
                  { title: '状态', key: 'status', width: 110 },
                  { title: '尝试', dataIndex: 'attempts', width: 70 },
                  { title: '快照载荷', dataIndex: 'snapshot' },
                  { title: '错误', dataIndex: 'lastError', width: 180 }
                ]">
                <template #bodyCell="{ column, record }">
                  <template v-if="column.key === 'status'"><a-tag :color="reclaimColor(record)">{{ reclaimLabel[record.status as ReclaimItem['status']] }}</a-tag></template>
                  <template v-else-if="column.dataIndex === 'snapshot'"><code class="snap">{{ record.snapshot }}</code></template>
                </template>
              </a-table>
              <a-divider orientation="left">收回日志</a-divider>
              <a-timeline>
                <a-timeline-item v-for="(log, i) in reclaim.logs.slice(-8).reverse()" :key="i"><b>{{ log.at }}</b> {{ log.message }}</a-timeline-item>
              </a-timeline>
            </a-card>

            <a-card title="审计记录"><a-timeline><a-timeline-item v-for="item in store.audit" :key="item.id" :color="item.action.includes('停止') || item.action.includes('回退') || item.action.includes('冻结') ? 'red' : 'blue'"><b>{{ item.at }} · {{ item.actor }}</b><p>{{ item.action }}：{{ item.detail }}</p></a-timeline-item></a-timeline></a-card>
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
.content { max-width: 1400px; width: 100%; margin: 0 auto; padding: 24px; }.mb { margin-bottom: 18px; }.mt { margin-top: 14px; }.selected { background: #eef2ff; cursor: pointer; }.rollout-label { color: #4338ca; font-weight: 700; }.hint { color: #6b7280; font-size: 12px; margin-top: 8px; }.snap { font-size: 11px; word-break: break-all; }.ant-list-item { cursor: pointer; }
@media (max-width: 720px) { .topbar { padding: 18px; flex-direction: column; align-items: flex-start; }.content { padding: 16px; } }
</style>
