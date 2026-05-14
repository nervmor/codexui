<template>
  <div class="skills-hub">
    <div v-if="toast" class="skills-hub-toast" :class="toastClass">{{ toast.text }}</div>

    <div class="skills-hub-toolbar">
      <div class="skills-hub-search-wrap">
        <IconTablerSearch class="skills-hub-search-icon" />
        <input
          ref="searchRef"
          v-model="query"
          class="skills-hub-search"
          type="text"
          placeholder="Search local skills..."
        />
        <span class="skills-hub-count">{{ filteredInstalled.length }} skills</span>
      </div>
    </div>

    <div v-if="isLoading" class="skills-hub-loading">Loading skills...</div>
    <div v-else-if="error" class="skills-hub-error">{{ error }}</div>
    <div v-else-if="filteredInstalled.length > 0" class="skills-hub-section">
      <div class="skills-hub-section-heading">
        <span class="skills-hub-section-title">Installed ({{ filteredInstalled.length }})</span>
      </div>
      <div class="skills-hub-category-list">
        <div
          v-for="group in installedSkillGroups"
          :key="`installed-${group.key}`"
          class="skills-hub-category"
        >
          <button
            class="skills-hub-category-toggle"
            type="button"
            :aria-expanded="isSkillGroupOpen('installed', group.key)"
            @click="toggleSkillGroup('installed', group.key)"
          >
            <IconTablerChevronRight
              class="skills-hub-section-chevron"
              :class="{ 'is-open': isSkillGroupOpen('installed', group.key) }"
            />
            <span class="skills-hub-category-title">{{ group.label }}</span>
            <span class="skills-hub-category-count">{{ group.skills.length }}</span>
          </button>
          <div v-if="isSkillGroupOpen('installed', group.key)" class="skills-hub-grid">
            <SkillCard
              v-for="skill in group.skills"
              :key="skill.path || `${skill.owner}/${skill.name}`"
              :skill="skill"
              @select="(skill) => openDetail(skill as HubSkill)"
            />
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="query.trim()" class="skills-hub-empty">No local skills found for "{{ query }}"</div>
    <div v-else class="skills-hub-empty">No local skills installed</div>

    <SkillDetailModal
      :skill="detailSkill"
      :visible="isDetailOpen"
      :is-uninstalling="isDetailUninstalling"
      @close="isDetailOpen = false"
      @uninstall="handleUninstall"
      @toggle-enabled="handleToggleEnabled"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import IconTablerSearch from '../icons/IconTablerSearch.vue'
import IconTablerChevronRight from '../icons/IconTablerChevronRight.vue'
import SkillCard from './SkillCard.vue'
import SkillDetailModal, { type HubSkill } from './SkillDetailModal.vue'
import { groupSkillsByNamePrefix } from '../../utils/skillsGrouping'

const EMPTY_SKILL: HubSkill = { name: '', owner: '', description: '', url: '', installed: true }
type SkillsHubPayload = { installed?: HubSkill[]; total: number }

const searchRef = ref<HTMLInputElement | null>(null)
const query = ref('')
const installedSkills = ref<HubSkill[]>([])
const isLoading = ref(false)
const error = ref('')
const openSkillGroupKeys = ref(new Set<string>())
const isDetailOpen = ref(false)
const detailSkill = ref<HubSkill>(EMPTY_SKILL)
const toast = ref<{ text: string; type: 'success' | 'error' } | null>(null)
const actionSkillKey = ref('')
const isUninstallActionInFlight = ref(false)
let toastTimer: ReturnType<typeof setTimeout> | null = null

const emit = defineEmits<{
  'skills-changed': []
}>()

const toastClass = computed(() => toast.value?.type === 'error' ? 'skills-hub-toast-error' : 'skills-hub-toast-success')
const currentDetailSkillKey = computed(() => `${detailSkill.value.owner}/${detailSkill.value.name}`)
const isDetailUninstalling = computed(() =>
  isUninstallActionInFlight.value && actionSkillKey.value === currentDetailSkillKey.value,
)
const filteredInstalled = computed(() => {
  const q = query.value.toLowerCase().trim()
  if (!q) return installedSkills.value
  return installedSkills.value.filter((s) =>
    s.name.toLowerCase().includes(q) ||
    s.owner.toLowerCase().includes(q) ||
    (s.displayName ?? '').toLowerCase().includes(q) ||
    (s.description ?? '').toLowerCase().includes(q),
  )
})
const installedSkillGroups = computed(() => groupSkillsByNamePrefix(filteredInstalled.value))

function skillGroupStateKey(section: 'installed', groupKey: string): string {
  return `${section}:${groupKey}`
}

function isSkillGroupOpen(section: 'installed', groupKey: string): boolean {
  if (query.value.trim()) return true
  return openSkillGroupKeys.value.has(skillGroupStateKey(section, groupKey))
}

function toggleSkillGroup(section: 'installed', groupKey: string): void {
  const stateKey = skillGroupStateKey(section, groupKey)
  const next = new Set(openSkillGroupKeys.value)
  if (next.has(stateKey)) {
    next.delete(stateKey)
  } else {
    next.add(stateKey)
  }
  openSkillGroupKeys.value = next
}

function showToast(text: string, type: 'success' | 'error' = 'success'): void {
  toast.value = { text, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = null }, 3000)
}

function applySkillsPayload(payload: SkillsHubPayload): void {
  installedSkills.value = payload.installed ?? []
}

async function fetchSkills(): Promise<void> {
  isLoading.value = true
  error.value = ''
  try {
    const resp = await fetch('/codex-api/skills-hub')
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as SkillsHubPayload
    applySkillsPayload(data)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load skills'
  } finally {
    isLoading.value = false
  }
}

function openDetail(skill: HubSkill): void {
  detailSkill.value = skill
  isDetailOpen.value = true
}

async function handleUninstall(skill: HubSkill): Promise<void> {
  actionSkillKey.value = `${skill.owner}/${skill.name}`
  isUninstallActionInFlight.value = true
  try {
    const resp = await fetch('/codex-api/skills-hub/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: skill.name, path: skill.path }),
    })
    const data = (await resp.json()) as { ok?: boolean; error?: string }
    if (!data.ok) throw new Error(data.error || 'Uninstall failed')
    installedSkills.value = installedSkills.value.filter((s) => s.name !== skill.name)
    showToast(`${skill.displayName || skill.name} skill uninstalled`)
    isDetailOpen.value = false
    emit('skills-changed')
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to uninstall skill', 'error')
  } finally {
    isUninstallActionInFlight.value = false
  }
}

async function handleToggleEnabled(skill: HubSkill, enabled: boolean): Promise<void> {
  try {
    const resp = await fetch('/codex-api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'skills/config/write', params: { path: skill.path, enabled } }),
    })
    if (!resp.ok) throw new Error('Failed to update skill')
    showToast(`${skill.displayName || skill.name} skill ${enabled ? 'enabled' : 'disabled'}`)
    await fetchSkills()
  } catch (e) {
    showToast(e instanceof Error ? e.message : 'Failed to update skill', 'error')
  }
}

onMounted(() => {
  void fetchSkills()
})
</script>

<style scoped>
@reference "tailwindcss";

.skills-hub {
  @apply flex flex-col gap-3 sm:gap-4 p-3 sm:p-6 max-w-4xl mx-auto w-full overflow-y-auto h-full;
}

.skills-hub-toolbar {
  @apply flex flex-col sm:flex-row items-stretch sm:items-center gap-2;
}

.skills-hub-search-wrap {
  @apply flex-1 flex items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2 transition focus-within:border-zinc-400 focus-within:shadow-sm;
}

.skills-hub-search-icon {
  @apply w-4 h-4 text-zinc-400 shrink-0;
}

.skills-hub-search {
  @apply flex-1 min-w-0 bg-transparent text-sm text-zinc-800 placeholder-zinc-400 outline-none border-none p-0;
}

.skills-hub-count {
  @apply text-xs text-zinc-400 whitespace-nowrap;
}

.skills-hub-toast {
  @apply rounded-lg px-3 py-2 text-sm font-medium;
}

.skills-hub-toast-success {
  @apply border border-emerald-200 bg-emerald-50 text-emerald-700;
}

.skills-hub-toast-error {
  @apply border border-rose-200 bg-rose-50 text-rose-700;
}

.skills-hub-section {
  @apply flex flex-col gap-2;
}

.skills-hub-section-heading {
  @apply flex items-center gap-1.5 text-sm font-medium text-zinc-600;
}

.skills-hub-section-toggle {
  @apply flex items-center gap-1.5 border-0 bg-transparent p-0 text-sm font-medium text-zinc-600 transition hover:text-zinc-900 cursor-pointer;
}

.skills-hub-section-title {
  @apply text-sm font-medium;
}

.skills-hub-section-chevron {
  @apply w-3.5 h-3.5 transition-transform;
}

.skills-hub-section-chevron.is-open {
  @apply rotate-90;
}

.skills-hub-category-list {
  @apply flex flex-col gap-2;
}

.skills-hub-category {
  @apply flex flex-col gap-2;
}

.skills-hub-category-toggle {
  @apply flex w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-left text-sm font-medium text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 cursor-pointer;
}

.skills-hub-category-title {
  @apply flex-1 min-w-0 truncate;
}

.skills-hub-category-count {
  @apply rounded-md border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 leading-none;
}

.skills-hub-grid {
  @apply grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3;
}

.skills-hub-loading {
  @apply text-sm text-zinc-400 py-8 text-center;
}

.skills-hub-error {
  @apply text-sm text-rose-600 py-4 text-center rounded-lg border border-rose-200 bg-rose-50;
}

.skills-hub-empty {
  @apply text-sm text-zinc-400 py-8 text-center;
}
</style>
