<template>
  <div class="automations-hub">
    <div class="automations-hub-header">
      <div class="automations-hub-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          class="automations-hub-tab"
          :class="{ 'is-active': activeTab === tab.value }"
          type="button"
          @click="activeTab = tab.value"
        >
          {{ tab.label }}
        </button>
      </div>
      <div class="automations-hub-actions">
        <button class="automations-hub-button" type="button" @click="isListVisible = !isListVisible">
          {{ isListVisible ? 'Hide list' : 'Show list' }}
        </button>
        <button class="automations-hub-button" type="button" :disabled="loading" @click="refreshAll">
          {{ loading ? 'Refreshing…' : 'Refresh' }}
        </button>
        <button class="automations-hub-button is-primary" type="button" @click="startCreate">
          New automation
        </button>
      </div>
    </div>

    <div v-if="toast" class="automations-hub-toast" :class="toast.type === 'error' ? 'is-error' : 'is-success'">
      {{ toast.text }}
    </div>

    <div
      v-if="activeTab === 'triage'"
      class="automations-hub-split automations-hub-split--triage"
      :class="{ 'is-list-hidden': !isListVisible }"
    >
      <section v-if="isListVisible" class="automations-hub-panel automations-hub-panel--list">
        <div class="automations-hub-section-header">
          <h3 class="automations-hub-section-title">Inbox</h3>
          <div class="automations-hub-pill-row">
            <button
              v-for="filter in triageFilters"
              :key="filter.value"
              class="automations-hub-pill"
              :class="{ 'is-active': triageFilter === filter.value }"
              type="button"
              @click="triageFilter = filter.value"
            >
              {{ filter.label }}
            </button>
          </div>
        </div>

        <div v-if="filteredRuns.length === 0" class="automations-hub-empty">
          No triage items for the current filter.
        </div>

        <div v-else class="automations-hub-run-list">
          <button
            v-for="run in filteredRuns"
            :key="run.id"
            class="automations-hub-run-card"
            :class="{ 'is-active': selectedRunId === run.id, 'is-unread': run.unread }"
            type="button"
            @click="selectRun(run.id)"
          >
            <div class="automations-hub-run-top">
              <span class="automations-hub-run-title">{{ run.automationTitle }}</span>
              <span class="automations-hub-run-status" :class="`is-${run.status}`">{{ runStatusLabel(run) }}</span>
            </div>
            <p class="automations-hub-run-meta">{{ shortPath(run.projectPath) }} · {{ formatDateTime(run.startedAtIso) }}</p>
          </button>
        </div>
      </section>

      <section class="automations-hub-panel automations-hub-panel--detail">
        <template v-if="selectedRun">
          <div class="automations-hub-section-header">
            <div>
              <h3 class="automations-hub-section-title">{{ selectedRun.automationTitle }}</h3>
              <p class="automations-hub-detail-meta">
                {{ shortPath(selectedRun.projectPath) }} · {{ runStatusLabel(selectedRun) }} ·
                {{ formatDateTime(selectedRun.startedAtIso) }}
                <template v-if="selectedRun.completedAtIso">- {{ formatDateTime(selectedRun.completedAtIso) }}</template>
                · {{ selectedRun.effectiveRunMode }} · {{ selectedRun.model || defaults.model || 'default' }}
                · {{ usageLabel(selectedRun) }}
              </p>
            </div>
            <div class="automations-hub-inline-actions">
              <button
                v-if="selectedRun.unread"
                class="automations-hub-inline-link"
                type="button"
                @click="markRunRead(selectedRun.id)"
              >
                Mark read
              </button>
              <button
                class="automations-hub-inline-link"
                type="button"
                @click="setRunArchived(selectedRun.id, !selectedRun.archived)"
              >
                {{ selectedRun.archived ? 'Restore' : 'Archive' }}
              </button>
              <button class="automations-hub-inline-link" type="button" @click="openRunWorkspace(selectedRun)">
                Open project
              </button>
            </div>
          </div>

          <p v-if="selectedRun.error" class="automations-hub-callout is-error">{{ selectedRun.error }}</p>
          <p v-else-if="selectedRun.archived" class="automations-hub-callout">Auto-archived because the run did not report notable findings.</p>

          <div class="automations-hub-chip-row">
            <span v-if="selectedRun.threadId" class="automations-hub-chip">thread: {{ selectedRun.threadId }}</span>
            <span v-if="selectedRun.resumedThreadId" class="automations-hub-chip">resumed: {{ selectedRun.resumedThreadId }}</span>
            <span class="automations-hub-chip">approval: {{ selectedRun.approvalPolicy }}</span>
            <span class="automations-hub-chip">reviewer: {{ selectedRun.approvalsReviewer }}</span>
            <span class="automations-hub-chip">web: {{ selectedRun.webSearchMode }}</span>
          </div>

          <div v-if="selectedRun.items.length > 0" class="automations-hub-event-list">
            <article v-for="item in selectedRun.items" :key="item.id" class="automations-hub-event">
              <div class="automations-hub-event-top">
                <span class="automations-hub-event-title">{{ item.title }}</span>
                <span class="automations-hub-chip">{{ item.type }} · {{ item.status || 'done' }}</span>
              </div>
              <div v-if="item.body" class="automations-hub-event-body" v-html="renderAutomationMarkdown(item.body)" />
            </article>
          </div>

          <pre v-if="selectedRunStructuredJson" class="automations-hub-structured-output">{{ selectedRunStructuredJson }}</pre>
          <div class="automations-hub-output" v-html="renderAutomationMarkdown(selectedRun.finalMessage || 'No final message recorded yet.')" />
        </template>
        <div v-else class="automations-hub-empty">Select a triage item to inspect the latest run output.</div>
      </section>
    </div>

    <div v-else class="automations-hub-split" :class="{ 'is-list-hidden': !isListVisible }">
      <section v-if="isListVisible" class="automations-hub-panel automations-hub-panel--list">
        <div class="automations-hub-section-header">
          <h3 class="automations-hub-section-title">Automations</h3>
          <span class="automations-hub-section-count">{{ automations.length }}</span>
        </div>

        <div v-if="automations.length === 0" class="automations-hub-empty">
          No automations yet. Create one to schedule recurring work.
        </div>

        <div v-else class="automations-hub-automation-list">
          <article
            v-for="automation in automations"
            :key="automation.id"
            class="automations-hub-automation-card"
            :class="{ 'is-selected': editingId === automation.id }"
          >
            <div class="automations-hub-run-top">
              <span class="automations-hub-run-title">{{ automation.title }}</span>
              <span class="automations-hub-run-status" :class="automation.enabled ? 'is-completed' : 'is-archived'">
                {{ automation.enabled ? 'Enabled' : 'Paused' }}
              </span>
            </div>
            <p class="automations-hub-run-meta">
              {{ automation.projectPaths.length }} project{{ automation.projectPaths.length === 1 ? '' : 's' }} · {{ automation.runMode }}
            </p>
            <p class="automations-hub-run-summary">{{ automation.prompt }}</p>
            <div class="automations-hub-chip-row">
              <span class="automations-hub-chip">cron: {{ automation.cronExpression }}</span>
              <span v-if="automation.nextRunAtIso" class="automations-hub-chip">next: {{ formatRelative(automation.nextRunAtIso) }}</span>
              <span v-if="automation.skillNames.length > 0" class="automations-hub-chip">{{ automation.skillNames.length }} skills</span>
            </div>
            <div class="automations-hub-inline-actions">
              <button class="automations-hub-inline-link" type="button" @click="startEdit(automation)">Edit</button>
              <button class="automations-hub-inline-link" type="button" :disabled="runningAutomationId === automation.id" @click="triggerRun(automation.id)">
                {{ runningAutomationId === automation.id ? 'Running…' : 'Run now' }}
              </button>
              <button class="automations-hub-inline-link" type="button" @click="toggleAutomation(automation)">
                {{ automation.enabled ? 'Pause' : 'Enable' }}
              </button>
              <button class="automations-hub-inline-link is-danger" type="button" :disabled="deletingAutomationId === automation.id" @click="removeAutomation(automation.id)">
                {{ deletingAutomationId === automation.id ? 'Deleting…' : 'Delete' }}
              </button>
            </div>
          </article>
        </div>
      </section>

      <section class="automations-hub-panel automations-hub-panel--detail">
        <div class="automations-hub-section-header">
          <div>
            <h3 class="automations-hub-section-title">{{ editingId ? 'Edit automation' : 'New automation' }}</h3>
            <p class="automations-hub-detail-meta">Matches the official app model: recurring background runs with project-scoped context.</p>
          </div>
          <button v-if="editingId" class="automations-hub-inline-link" type="button" @click="startCreate">Create new instead</button>
        </div>

        <div class="automations-hub-form">
          <label class="automations-hub-field">
            <span class="automations-hub-label">Title</span>
            <input v-model="form.title" class="automations-hub-input" type="text" placeholder="Weekly PR triage" />
          </label>

          <label class="automations-hub-field">
            <span class="automations-hub-label">Prompt</span>
            <textarea
              v-model="form.prompt"
              class="automations-hub-textarea"
              rows="8"
              placeholder="Review incoming pull requests and report only issues that need attention."
            />
          </label>

          <label class="automations-hub-field">
            <span class="automations-hub-label">Output schema</span>
            <textarea
              v-model="form.outputSchema"
              class="automations-hub-textarea automations-hub-textarea--compact"
              rows="5"
              placeholder='{"type":"object","properties":{"summary":{"type":"string"},"status":{"type":"string","enum":["clear","findings","action_required"]}},"required":["summary","status"],"additionalProperties":false}'
            />
          </label>

          <div class="automations-hub-field">
            <span class="automations-hub-label">Projects</span>
            <ComposerSearchDropdown
              class="automations-hub-picker"
              :options="projectDropdownOptions"
              :selected-values="form.projectPaths"
              placeholder="Select projects"
              search-placeholder="Search projects..."
              @toggle="onProjectToggle"
            />
          </div>

          <div class="automations-hub-field-grid">
            <label class="automations-hub-field">
              <span class="automations-hub-label">Run mode</span>
              <ComposerDropdown
                class="automations-hub-dropdown"
                :model-value="form.runMode"
                :options="runModeOptions"
                placeholder="Run mode"
                @update:model-value="onRunModeSelect"
              />
            </label>

            <label class="automations-hub-field">
              <span class="automations-hub-label">Schedule</span>
              <ComposerDropdown
                class="automations-hub-dropdown"
                :model-value="form.schedulePreset"
                :options="presetOptions"
                placeholder="Schedule"
                @update:model-value="onPresetChange"
              />
            </label>
          </div>

          <label class="automations-hub-field">
            <span class="automations-hub-label">Cron</span>
            <input v-model="form.cronExpression" class="automations-hub-input" type="text" placeholder="0 9 * * 1" />
          </label>

          <div class="automations-hub-field-grid">
            <label class="automations-hub-field">
              <span class="automations-hub-label">Model</span>
              <ComposerDropdown
                class="automations-hub-dropdown"
                :model-value="form.model"
                :options="modelOptions"
                placeholder="Default model"
                @update:model-value="onModelSelect"
              />
            </label>

            <label class="automations-hub-field">
              <span class="automations-hub-label">Thinking</span>
              <ComposerDropdown
                class="automations-hub-dropdown"
                :model-value="form.reasoningEffort"
                :options="reasoningOptions"
                placeholder="Default thinking"
                @update:model-value="onReasoningEffortSelect"
              />
            </label>
          </div>

          <div class="automations-hub-field-grid">
            <label class="automations-hub-field">
              <span class="automations-hub-label">Sandbox</span>
              <ComposerDropdown
                class="automations-hub-dropdown"
                :model-value="form.sandboxMode"
                :options="sandboxOptions"
                placeholder="Default sandbox"
                @update:model-value="onSandboxModeSelect"
              />
            </label>

            <div class="automations-hub-field">
              <span class="automations-hub-label">Skills</span>
              <ComposerSearchDropdown
                class="automations-hub-picker"
                :options="skillDropdownOptions"
                :selected-values="form.skillNames"
                placeholder="Optional skills"
                search-placeholder="Search skills..."
                @toggle="onSkillToggle"
              />
            </div>
          </div>

          <div class="automations-hub-field-grid">
            <label class="automations-hub-field">
              <span class="automations-hub-label">Web search</span>
              <ComposerDropdown
                class="automations-hub-dropdown"
                :model-value="form.webSearchMode"
                :options="webSearchOptions"
                placeholder="Web search"
                @update:model-value="onWebSearchModeSelect"
              />
            </label>

            <label class="automations-hub-field">
              <span class="automations-hub-label">Approval policy</span>
              <ComposerDropdown
                class="automations-hub-dropdown"
                :model-value="form.approvalPolicy"
                :options="approvalPolicyOptions"
                placeholder="Approval policy"
                @update:model-value="onApprovalPolicySelect"
              />
            </label>
          </div>

          <label class="automations-hub-field">
            <span class="automations-hub-label">Approval reviewer</span>
            <ComposerDropdown
              class="automations-hub-dropdown"
              :model-value="form.approvalsReviewer"
              :options="approvalsReviewerOptions"
              placeholder="Approval reviewer"
              @update:model-value="onApprovalsReviewerSelect"
            />
          </label>

          <div class="automations-hub-switch-grid">
            <label class="automations-hub-switch">
              <input v-model="form.resumeThread" type="checkbox" />
              <span>Resume the previous thread for each project.</span>
            </label>

            <label class="automations-hub-switch">
              <input v-model="form.ephemeral" type="checkbox" />
              <span>Run without persisting Codex session files.</span>
            </label>

            <label class="automations-hub-switch">
              <input v-model="form.ignoreUserConfig" type="checkbox" />
              <span>Ignore user config for this run.</span>
            </label>

            <label class="automations-hub-switch">
              <input v-model="form.ignoreRules" type="checkbox" />
              <span>Ignore exec policy rules for this run.</span>
            </label>

            <label class="automations-hub-switch">
              <input v-model="form.networkAccess" type="checkbox" />
              <span>Enable workspace-write network access.</span>
            </label>
          </div>

          <label class="automations-hub-switch">
            <input v-model="form.autoArchiveEmpty" type="checkbox" />
            <span>Archive runs automatically when the result looks empty or “nothing to report”.</span>
          </label>

          <label class="automations-hub-switch">
            <input v-model="form.enabled" type="checkbox" />
            <span>Enable immediately after saving.</span>
          </label>

          <div class="automations-hub-inline-actions">
            <button class="automations-hub-button is-primary" type="button" :disabled="saving" @click="saveAutomation">
              {{ saving ? 'Saving…' : editingId ? 'Save automation' : 'Create automation' }}
            </button>
            <button v-if="editingId" class="automations-hub-button" type="button" @click="startCreate">Cancel edit</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import ComposerDropdown from './ComposerDropdown.vue'
import ComposerSearchDropdown from './ComposerSearchDropdown.vue'
import {
  createAutomation,
  deleteAutomation,
  getAutomationsState,
  getAvailableModels,
  getSkillsList,
  getWorkspaceRootsState,
  markAutomationRunRead,
  runAutomationNow,
  setAutomationEnabled,
  setAutomationRunArchived,
  type UiAutomation,
  type UiAutomationDefaults,
  type UiAutomationRun,
  updateAutomation,
} from '../../api/codexGateway'
import type { ReasoningEffort, UiCodexModel } from '../../types/codex'
import { buildReasoningEffortOptions, isReasoningEffortSupported } from '../../utils/codexModels'
import { buildFilesRouteLocation } from '../../utils/fileExplorer'

const tabs = [
  { value: 'triage', label: 'Triage' },
  { value: 'automations', label: 'Automations' },
] as const

const triageFilters = [
  { value: 'unread', label: 'Unread' },
  { value: 'active', label: 'Needs attention' },
  { value: 'all', label: 'All' },
  { value: 'archived', label: 'Archived' },
] as const

const router = useRouter()
const activeTab = ref<(typeof tabs)[number]['value']>('triage')
const triageFilter = ref<(typeof triageFilters)[number]['value']>('unread')
const loading = ref(false)
const saving = ref(false)
const runningAutomationId = ref('')
const deletingAutomationId = ref('')
const editingId = ref('')
const toast = ref<{ text: string; type: 'success' | 'error' } | null>(null)
const automations = ref<UiAutomation[]>([])
const runs = ref<UiAutomationRun[]>([])
const defaults = ref<UiAutomationDefaults>({ model: '', reasoningEffort: '', sandboxMode: '' })
const models = ref<UiCodexModel[]>([])
const skills = ref<Array<{ name: string; description: string; path: string; scope?: string; projectName?: string }>>([])
const projects = ref<Array<{ path: string; label: string }>>([])
const selectedRunId = ref('')
const isListVisible = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null
let hasInitializedCreateForm = false

const form = reactive({
  title: '',
  prompt: '',
  projectPaths: [] as string[],
  skillNames: [] as string[],
  enabled: true,
  runMode: 'worktree' as 'local' | 'worktree',
  schedulePreset: 'weekly' as 'hourly' | 'daily' | 'weekly' | 'custom',
  cronExpression: '0 9 * * 1',
  model: '',
  reasoningEffort: '' as ReasoningEffort | '',
  sandboxMode: 'default' as 'default' | 'read-only' | 'workspace-write' | 'danger-full-access',
  outputSchema: '',
  resumeThread: false,
  ephemeral: false,
  ignoreUserConfig: false,
  ignoreRules: false,
  networkAccess: false,
  webSearchMode: 'default' as 'default' | 'disabled' | 'live',
  approvalPolicy: 'default' as 'default' | 'never' | 'on-request' | 'on-failure' | 'untrusted',
  approvalsReviewer: 'default' as 'default' | 'user' | 'auto_review',
  autoArchiveEmpty: true,
})

const presetOptions = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'custom', label: 'Custom' },
]

const runModeOptions = [
  { value: 'local', label: 'Local' },
  { value: 'worktree', label: 'Worktree' },
]

const sandboxOptions = [
  { value: 'default', label: 'Use defaults' },
  { value: 'read-only', label: 'Read-only' },
  { value: 'workspace-write', label: 'Workspace write' },
  { value: 'danger-full-access', label: 'Danger full access' },
]

const webSearchOptions = [
  { value: 'default', label: 'Use defaults' },
  { value: 'disabled', label: 'Disabled' },
  { value: 'live', label: 'Live' },
]

const approvalPolicyOptions = [
  { value: 'default', label: 'Use exec default' },
  { value: 'never', label: 'Never' },
  { value: 'on-request', label: 'On request' },
  { value: 'on-failure', label: 'On failure' },
  { value: 'untrusted', label: 'Untrusted' },
]

const approvalsReviewerOptions = [
  { value: 'default', label: 'Use defaults' },
  { value: 'user', label: 'User' },
  { value: 'auto_review', label: 'Auto review' },
]

const effectiveModelId = computed(() => form.model || defaults.value.model || '')

const reasoningOptions = computed(() =>
  buildReasoningEffortOptions(models.value, effectiveModelId.value, true),
)

const modelOptions = computed(() => [
  { value: '', label: 'Use defaults' },
  ...models.value.map((model) => ({ value: model.id, label: model.displayName })),
])

const projectDropdownOptions = computed(() =>
  projects.value.map((project) => ({
    value: project.path,
    label: project.label,
    description: project.path,
  })),
)

const skillDropdownOptions = computed(() =>
  skills.value.map((skill) => ({
    value: skill.name,
    label: skill.name,
    description: skill.scope === 'repo' && skill.projectName
      ? [`Project · ${skill.projectName}`, skill.description].filter(Boolean).join(' · ')
      : skill.description,
  })),
)

const filteredRuns = computed(() => {
  if (triageFilter.value === 'unread') {
    return runs.value.filter((run) => run.unread)
  }
  if (triageFilter.value === 'active') {
    return runs.value.filter((run) => !run.archived && (run.status === 'failed' || run.hasFindings || run.unread))
  }
  if (triageFilter.value === 'archived') {
    return runs.value.filter((run) => run.archived)
  }
  return runs.value
})

const selectedRun = computed(() =>
  filteredRuns.value.find((run) => run.id === selectedRunId.value)
    ?? runs.value.find((run) => run.id === selectedRunId.value)
    ?? filteredRuns.value[0]
    ?? null,
)

const selectedRunStructuredJson = computed(() => {
  const value = selectedRun.value?.structuredResult
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
})

const shouldPollRuns = computed(() =>
  runningAutomationId.value.length > 0 || runs.value.some((run) => run.status === 'running'),
)

type AutomationMarkdownBlock =
  | { kind: 'paragraph'; value: string }
  | { kind: 'heading'; level: number; value: string }
  | { kind: 'unorderedList'; items: string[] }
  | { kind: 'orderedList'; items: string[]; start: number }
  | { kind: 'codeBlock'; language: string; value: string }
  | { kind: 'divider' }

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

function renderInlineAutomationMarkdown(value: string): string {
  const placeholders: string[] = []
  const protect = (html: string): string => {
    const token = `\u0000${placeholders.length}\u0000`
    placeholders.push(html)
    return token
  }

  let rendered = escapeHtml(value)
  rendered = rendered.replace(/`([^`\n]+)`/gu, (_match, code: string) => protect(`<code>${code}</code>`))
  rendered = rendered.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/gu, '<strong>$1</strong>')
  rendered = rendered.replace(/\*([^*\n][^*\n]*?)\*/gu, '<em>$1</em>')
  rendered = rendered.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')

  placeholders.forEach((html, index) => {
    rendered = rendered.split(`\u0000${index}\u0000`).join(html)
  })
  return rendered
}

function parseAutomationMarkdown(value: string): AutomationMarkdownBlock[] {
  const lines = value.replace(/\r\n/gu, '\n').split('\n')
  const blocks: AutomationMarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    if (!trimmed) {
      index += 1
      continue
    }

    const fence = trimmed.match(/^(```+|~~~+)\s*([^\s`]*)?/u)
    if (fence) {
      const marker = fence[1]
      const language = fence[2] ?? ''
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && lines[index].trim() !== marker) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ kind: 'codeBlock', language, value: codeLines.join('\n') })
      continue
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/u)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, value: heading[2].trim() })
      index += 1
      continue
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) {
      blocks.push({ kind: 'divider' })
      index += 1
      continue
    }

    const unordered = trimmed.match(/^[-*+]\s+(.+)$/u)
    if (unordered) {
      const items: string[] = []
      while (index < lines.length) {
        const item = lines[index].trim().match(/^[-*+]\s+(.+)$/u)
        if (!item) break
        items.push(item[1].trim())
        index += 1
      }
      blocks.push({ kind: 'unorderedList', items })
      continue
    }

    const ordered = trimmed.match(/^(\d+)[.)]\s+(.+)$/u)
    if (ordered) {
      const items: string[] = []
      const start = Number.parseInt(ordered[1], 10) || 1
      while (index < lines.length) {
        const item = lines[index].trim().match(/^\d+[.)]\s+(.+)$/u)
        if (!item) break
        items.push(item[1].trim())
        index += 1
      }
      blocks.push({ kind: 'orderedList', items, start })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length) {
      const next = lines[index]
      const nextTrimmed = next.trim()
      if (!nextTrimmed) break
      if (/^(```+|~~~+)/u.test(nextTrimmed) || /^#{1,6}\s+/u.test(nextTrimmed) || /^[-*+]\s+/u.test(nextTrimmed) || /^\d+[.)]\s+/u.test(nextTrimmed)) break
      paragraph.push(nextTrimmed)
      index += 1
    }
    blocks.push({ kind: 'paragraph', value: paragraph.join(' ') })
  }

  return blocks
}

function renderAutomationMarkdown(value: string): string {
  return parseAutomationMarkdown(value)
    .map((block) => {
      if (block.kind === 'heading') {
        const level = Math.min(3, Math.max(2, block.level + 1))
        return `<h${level}>${renderInlineAutomationMarkdown(block.value)}</h${level}>`
      }
      if (block.kind === 'unorderedList') {
        return `<ul>${block.items.map((item) => `<li>${renderInlineAutomationMarkdown(item)}</li>`).join('')}</ul>`
      }
      if (block.kind === 'orderedList') {
        return `<ol start="${block.start}">${block.items.map((item) => `<li>${renderInlineAutomationMarkdown(item)}</li>`).join('')}</ol>`
      }
      if (block.kind === 'codeBlock') {
        const language = block.language ? `<span>${escapeHtml(block.language)}</span>` : ''
        return `<pre>${language}<code>${escapeHtml(block.value)}</code></pre>`
      }
      if (block.kind === 'divider') return '<hr>'
      return `<p>${renderInlineAutomationMarkdown(block.value)}</p>`
    })
    .join('')
}

function showToast(text: string, type: 'success' | 'error' = 'success'): void {
  toast.value = { text, type }
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toast.value = null
  }, 3200)
}

function resetForm(): void {
  editingId.value = ''
  form.title = ''
  form.prompt = ''
  form.projectPaths = projects.value[0] ? [projects.value[0].path] : []
  form.skillNames = []
  form.enabled = true
  form.runMode = 'worktree'
  form.schedulePreset = 'weekly'
  form.cronExpression = '0 9 * * 1'
  form.model = ''
  form.reasoningEffort = ''
  form.sandboxMode = 'default'
  form.outputSchema = ''
  form.resumeThread = false
  form.ephemeral = false
  form.ignoreUserConfig = false
  form.ignoreRules = false
  form.networkAccess = false
  form.webSearchMode = 'default'
  form.approvalPolicy = 'default'
  form.approvalsReviewer = 'default'
  form.autoArchiveEmpty = true
  hasInitializedCreateForm = true
}

function hydrateForm(automation: UiAutomation): void {
  editingId.value = automation.id
  form.title = automation.title
  form.prompt = automation.prompt
  form.projectPaths = [...automation.projectPaths]
  form.skillNames = [...automation.skillNames]
  form.enabled = automation.enabled
  form.runMode = automation.runMode
  form.schedulePreset = automation.schedulePreset
  form.cronExpression = automation.cronExpression
  form.model = automation.model
  form.reasoningEffort = automation.reasoningEffort as ReasoningEffort | ''
  form.sandboxMode = automation.sandboxMode
  form.outputSchema = automation.outputSchema
  form.resumeThread = automation.resumeThread
  form.ephemeral = automation.ephemeral
  form.ignoreUserConfig = automation.ignoreUserConfig
  form.ignoreRules = automation.ignoreRules
  form.networkAccess = automation.networkAccess
  form.webSearchMode = automation.webSearchMode
  form.approvalPolicy = automation.approvalPolicy
  form.approvalsReviewer = automation.approvalsReviewer
  form.autoArchiveEmpty = automation.autoArchiveEmpty
}

async function refreshAll(): Promise<void> {
  loading.value = true
  try {
    const [automationState, workspaceState, availableModels, installedSkills] = await Promise.all([
      getAutomationsState(),
      getWorkspaceRootsState(),
      getAvailableModels().catch(() => []),
      getSkillsList().catch(() => []),
    ])

    automations.value = automationState.automations
    runs.value = automationState.runs
    defaults.value = automationState.defaults
    models.value = availableModels
    skills.value = installedSkills
    projects.value = workspaceState.order.map((path) => ({
      path,
      label: workspaceState.labels[path] || shortPath(path),
    }))

    if (!editingId.value && !hasInitializedCreateForm) {
      resetForm()
    }
    if (!selectedRunId.value && automationState.runs[0]) {
      selectedRunId.value = automationState.runs[0].id
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to refresh automations', 'error')
  } finally {
    loading.value = false
    syncRunPolling()
  }
}

function onPresetChange(value: string): void {
  const preset = value === 'hourly' || value === 'daily' || value === 'weekly' ? value : 'custom'
  form.schedulePreset = preset
  if (preset === 'hourly') form.cronExpression = '0 * * * *'
  if (preset === 'daily') form.cronExpression = '0 9 * * *'
  if (preset === 'weekly') form.cronExpression = '0 9 * * 1'
}

function onRunModeSelect(value: string): void {
  form.runMode = value === 'local' ? 'local' : 'worktree'
}

function onSandboxModeSelect(value: string): void {
  if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
    form.sandboxMode = value
    return
  }
  form.sandboxMode = 'default'
}

function onWebSearchModeSelect(value: string): void {
  form.webSearchMode = value === 'disabled' || value === 'live' ? value : 'default'
}

function onApprovalPolicySelect(value: string): void {
  if (value === 'never' || value === 'on-request' || value === 'on-failure' || value === 'untrusted') {
    form.approvalPolicy = value
    return
  }
  form.approvalPolicy = 'default'
}

function onApprovalsReviewerSelect(value: string): void {
  form.approvalsReviewer = value === 'user' || value === 'auto_review' ? value : 'default'
}

function onReasoningEffortSelect(value: string): void {
  if (value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    form.reasoningEffort = value
    return
  }
  form.reasoningEffort = ''
}

function onModelSelect(value: string): void {
  form.model = value
  if (!isReasoningEffortSupported(models.value, effectiveModelId.value, form.reasoningEffort)) {
    form.reasoningEffort = ''
  }
}

function onProjectToggle(value: string, checked: boolean): void {
  if (checked) {
    if (!form.projectPaths.includes(value)) form.projectPaths = [...form.projectPaths, value]
    return
  }
  form.projectPaths = form.projectPaths.filter((item) => item !== value)
}

function onSkillToggle(value: string, checked: boolean): void {
  if (checked) {
    if (!form.skillNames.includes(value)) form.skillNames = [...form.skillNames, value]
    return
  }
  form.skillNames = form.skillNames.filter((item) => item !== value)
}

function startCreate(): void {
  activeTab.value = 'automations'
  isListVisible.value = false
  resetForm()
}

function startEdit(automation: UiAutomation): void {
  activeTab.value = 'automations'
  isListVisible.value = false
  hydrateForm(automation)
}

function selectRun(id: string): void {
  selectedRunId.value = id
  isListVisible.value = false
}

async function saveAutomation(): Promise<void> {
  saving.value = true
  try {
    const payload = {
      title: form.title,
      prompt: form.prompt,
      projectPaths: form.projectPaths,
      skillNames: form.skillNames,
      enabled: form.enabled,
      runMode: form.runMode,
      schedulePreset: form.schedulePreset,
      cronExpression: form.cronExpression,
      model: form.model,
      reasoningEffort: form.reasoningEffort,
      sandboxMode: form.sandboxMode,
      outputSchema: form.outputSchema,
      resumeThread: form.resumeThread,
      ephemeral: form.ephemeral,
      ignoreUserConfig: form.ignoreUserConfig,
      ignoreRules: form.ignoreRules,
      networkAccess: form.networkAccess,
      webSearchMode: form.webSearchMode,
      approvalPolicy: form.approvalPolicy,
      approvalsReviewer: form.approvalsReviewer,
      autoArchiveEmpty: form.autoArchiveEmpty,
    }
    if (editingId.value) {
      await updateAutomation(editingId.value, payload)
      showToast('Automation updated.')
    } else {
      await createAutomation(payload)
      showToast('Automation created.')
    }
    await refreshAll()
    activeTab.value = 'automations'
    resetForm()
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to save automation', 'error')
  } finally {
    saving.value = false
  }
}

async function triggerRun(id: string): Promise<void> {
  runningAutomationId.value = id
  try {
    await runAutomationNow(id)
    showToast('Automation started.')
    await refreshAll()
    activeTab.value = 'triage'
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to start automation', 'error')
  } finally {
    runningAutomationId.value = ''
  }
}

async function toggleAutomation(automation: UiAutomation): Promise<void> {
  try {
    await setAutomationEnabled(automation.id, !automation.enabled)
    showToast(automation.enabled ? 'Automation paused.' : 'Automation enabled.')
    await refreshAll()
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to toggle automation', 'error')
  }
}

async function removeAutomation(id: string): Promise<void> {
  deletingAutomationId.value = id
  try {
    await deleteAutomation(id)
    showToast('Automation deleted.')
    await refreshAll()
    if (editingId.value === id) resetForm()
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to delete automation', 'error')
  } finally {
    deletingAutomationId.value = ''
  }
}

async function markRunRead(id: string): Promise<void> {
  try {
    await markAutomationRunRead(id)
    await refreshAll()
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to mark run as read', 'error')
  }
}

async function setRunArchived(id: string, archived: boolean): Promise<void> {
  try {
    await setAutomationRunArchived(id, archived)
    await refreshAll()
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Failed to update triage item', 'error')
  }
}

function shortPath(path: string): string {
  const normalized = path.replace(/\/+$/, '')
  const segments = normalized.split('/').filter(Boolean)
  return segments[segments.length - 1] || path
}

function formatDateTime(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatRelative(value: string): string {
  if (!value) return ''
  const diffMs = new Date(value).getTime() - Date.now()
  const totalMinutes = Math.round(diffMs / 60000)
  if (Math.abs(totalMinutes) < 60) return `${totalMinutes}m`
  const totalHours = Math.round(totalMinutes / 60)
  if (Math.abs(totalHours) < 48) return `${totalHours}h`
  const totalDays = Math.round(totalHours / 24)
  return `${totalDays}d`
}

function usageLabel(run: UiAutomationRun): string {
  if (!run.usage) return 'usage pending'
  const total = run.usage.inputTokens + run.usage.outputTokens
  return `${total.toLocaleString()} tokens`
}

function runStatusLabel(run: UiAutomationRun): string {
  if (run.status === 'running') return 'Running'
  if (run.status === 'failed') return 'Failed'
  if (run.status === 'archived') return 'Archived'
  if (run.hasFindings) return 'Findings'
  return 'Completed'
}

function openRunWorkspace(run: UiAutomationRun): void {
  const targetPath = run.worktreeCwd || run.projectPath
  void router.push(buildFilesRouteLocation(targetPath, { cwd: targetPath }))
}

function stopRunPolling(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = null
}

function syncRunPolling(): void {
  if (!shouldPollRuns.value) {
    stopRunPolling()
    return
  }
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (!loading.value) void refreshAll()
  }, 15_000)
}

watch(selectedRun, (run) => {
  if (run && selectedRunId.value !== run.id) {
    selectedRunId.value = run.id
  }
})

onMounted(() => {
  void refreshAll()
})

onBeforeUnmount(() => {
  stopRunPolling()
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<style scoped>
@reference "tailwindcss";

.automations-hub {
  @apply mx-auto flex h-full w-full max-w-7xl flex-col gap-2.5 overflow-y-auto p-2.5 sm:p-3;
}

.automations-hub-header {
  @apply flex flex-wrap items-center justify-between gap-2;
}

.automations-hub-actions {
  @apply flex flex-wrap gap-1.5;
}

.automations-hub-button {
  @apply inline-flex items-center justify-center rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60;
}

.automations-hub-button.is-primary {
  @apply border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800;
}

.automations-hub-toast {
  @apply rounded-md border px-2.5 py-1.5 text-xs font-medium;
}

.automations-hub-toast.is-success {
  @apply border-emerald-200 bg-emerald-50 text-emerald-700;
}

.automations-hub-toast.is-error {
  @apply border-rose-200 bg-rose-50 text-rose-700;
}

.automations-hub-tabs {
  @apply flex flex-wrap gap-1.5;
}

.automations-hub-tab {
  @apply rounded-md border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-600 transition hover:bg-zinc-50;
}

.automations-hub-tab.is-active {
  @apply border-zinc-900 bg-zinc-900 text-white;
}

.automations-hub-split {
  @apply grid min-h-0 flex-1 gap-2.5 xl:grid-cols-[minmax(18rem,0.78fr)_minmax(0,1.35fr)];
}

.automations-hub-split--triage {
  @apply lg:grid-cols-[minmax(18rem,0.62fr)_minmax(0,1.55fr)];
}

.automations-hub-split.is-list-hidden {
  @apply block;
}

.automations-hub-split.is-list-hidden .automations-hub-panel--detail {
  @apply h-full;
}

.automations-hub-panel {
  @apply flex min-h-0 flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-2.5;
}

.automations-hub-panel--list,
.automations-hub-panel--detail {
  @apply overflow-hidden;
}

@media (max-width: 1023px) {
  .automations-hub-split--triage .automations-hub-panel--list {
    max-height: 11rem;
  }

  .automations-hub-split--triage .automations-hub-panel--detail {
    min-height: 28rem;
  }
}

@media (max-width: 767px) {
  .automations-hub {
    height: auto;
    min-height: 100%;
    overflow: visible;
  }

  .automations-hub-split,
  .automations-hub-split--triage {
    display: flex;
    min-height: auto;
    flex-direction: column;
  }

  .automations-hub-panel--detail {
    overflow: visible;
  }

  .automations-hub-inline-actions {
    width: 100%;
    flex-wrap: nowrap;
    overflow-x: auto;
    padding-bottom: 0.125rem;
  }

  .automations-hub-actions {
    margin-left: auto;
  }

  .automations-hub-inline-link,
  .automations-hub-button {
    white-space: nowrap;
  }

  .automations-hub-output {
    min-height: 18rem;
    max-height: none;
  }

  .automations-hub-event-list,
  .automations-hub-chip-row {
    max-height: 8rem;
  }
}

.automations-hub-section-header {
  @apply flex flex-wrap items-start justify-between gap-2;
}

.automations-hub-section-title {
  @apply m-0 text-xs font-semibold text-zinc-900;
}

.automations-hub-section-count {
  @apply rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[10px] text-zinc-500;
}

.automations-hub-pill-row {
  @apply flex flex-wrap gap-1.5;
}

.automations-hub-pill {
  @apply rounded-md border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-500 transition hover:bg-zinc-100;
}

.automations-hub-pill.is-active {
  @apply border-zinc-900 bg-zinc-900 text-white;
}

.automations-hub-empty {
  @apply rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-3 py-6 text-center text-xs text-zinc-500;
}

.automations-hub-run-list,
.automations-hub-automation-list {
  @apply flex min-h-0 flex-col gap-2 overflow-y-auto pr-1;
}

.automations-hub-run-card,
.automations-hub-automation-card {
  @apply flex flex-col gap-1 rounded-md border border-zinc-200 bg-zinc-50 p-2 text-left transition hover:border-zinc-300 hover:bg-white;
}

.automations-hub-run-card {
  @apply min-w-0;
}

.automations-hub-run-card.is-active,
.automations-hub-automation-card.is-selected {
  @apply border-zinc-900 bg-white shadow-sm;
}

.automations-hub-run-card.is-unread {
  @apply border-sky-300;
}

.automations-hub-run-top {
  @apply flex min-w-0 items-start justify-between gap-1.5;
}

.automations-hub-run-title {
  @apply min-w-0 flex-1 truncate text-xs font-semibold text-zinc-900;
}

.automations-hub-run-status {
  @apply shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-medium;
}

.automations-hub-run-status.is-running {
  @apply border-amber-200 bg-amber-50 text-amber-700;
}

.automations-hub-run-status.is-failed {
  @apply border-rose-200 bg-rose-50 text-rose-700;
}

.automations-hub-run-status.is-archived {
  @apply border-zinc-200 bg-zinc-100 text-zinc-500;
}

.automations-hub-run-status.is-completed {
  @apply border-emerald-200 bg-emerald-50 text-emerald-700;
}

.automations-hub-run-meta,
.automations-hub-detail-meta {
  @apply m-0 text-[11px] leading-4 text-zinc-500;
}

.automations-hub-run-meta {
  @apply truncate;
}

.automations-hub-run-summary {
  @apply m-0 text-[11px] leading-4 text-zinc-600 line-clamp-2;
}

.automations-hub-inline-actions {
  @apply flex flex-wrap gap-1.5;
}

.automations-hub-inline-link {
  @apply inline-flex w-fit items-center rounded-md border border-zinc-200 bg-white px-2 py-0.5 text-[11px] font-medium text-zinc-700 transition hover:bg-zinc-50;
}

.automations-hub-inline-link.is-danger {
  @apply text-rose-700;
}

.automations-hub-detail-grid {
  @apply grid gap-3 sm:grid-cols-2;
}

.automations-hub-stat {
  @apply rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2;
}

.automations-hub-stat-label {
  @apply block text-[11px] uppercase tracking-[0.08em] text-zinc-500;
}

.automations-hub-stat-value {
  @apply mt-1 block text-sm font-medium text-zinc-900;
}

.automations-hub-callout {
  @apply m-0 rounded-md border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-xs text-zinc-600;
}

.automations-hub-callout.is-error {
  @apply border-rose-200 bg-rose-50 text-rose-700;
}

.automations-hub-output {
  @apply min-h-[24rem] flex-1 overflow-auto rounded-lg border border-zinc-200 bg-white px-3 py-2.5 text-sm leading-6 text-zinc-800;
}

.automations-hub-structured-output {
  @apply max-h-32 overflow-auto rounded-md border border-zinc-200 bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-5 text-zinc-100;
}

.automations-hub-event-list {
  @apply flex max-h-52 flex-col gap-1.5 overflow-y-auto pr-1;
}

.automations-hub-event {
  @apply rounded-md border border-zinc-200 bg-zinc-50 p-2;
}

.automations-hub-event-top {
  @apply flex flex-wrap items-center justify-between gap-1.5;
}

.automations-hub-event-title {
  @apply text-xs font-semibold text-zinc-900;
}

.automations-hub-event-body {
  @apply mt-1.5 max-h-32 overflow-auto text-xs leading-5 text-zinc-700;
}

.automations-hub-event-body :deep(p) {
  @apply my-2 whitespace-pre-wrap first:mt-0 last:mb-0;
}

.automations-hub-event-body :deep(pre) {
  @apply my-2 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs leading-6 text-zinc-100;
}

.automations-hub-output :deep(h2),
.automations-hub-output :deep(h3) {
  @apply mb-1.5 mt-3 text-sm font-semibold text-zinc-950 first:mt-0;
}

.automations-hub-output :deep(p) {
  @apply my-2 whitespace-pre-wrap;
}

.automations-hub-output :deep(ul),
.automations-hub-output :deep(ol) {
  @apply my-2 pl-5;
}

.automations-hub-output :deep(ul) {
  @apply list-disc;
}

.automations-hub-output :deep(ol) {
  @apply list-decimal;
}

.automations-hub-output :deep(li) {
  @apply my-1 pl-1;
}

.automations-hub-output :deep(code) {
  @apply rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.92em] text-zinc-900;
}

.automations-hub-output :deep(pre) {
  @apply my-3 overflow-auto rounded-lg bg-zinc-950 p-3 text-xs leading-6 text-zinc-100;
}

.automations-hub-output :deep(pre code) {
  @apply rounded-none bg-transparent p-0 text-zinc-100;
}

.automations-hub-output :deep(pre span) {
  @apply mb-2 block text-[10px] uppercase tracking-[0.08em] text-zinc-400;
}

.automations-hub-output :deep(a) {
  @apply font-medium text-sky-700 underline underline-offset-2;
}

.automations-hub-output :deep(hr) {
  @apply my-4 border-zinc-200;
}

.automations-hub-chip-row {
  @apply flex max-h-12 flex-wrap gap-1.5 overflow-y-auto;
}

.automations-hub-chip {
  @apply max-w-full break-all rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] leading-4 text-zinc-600;
}

.automations-hub-form {
  @apply flex min-h-0 flex-col gap-3 overflow-y-auto pr-1;
}

.automations-hub-field {
  @apply flex flex-col gap-1.5;
}

.automations-hub-field-grid {
  @apply grid gap-3 md:grid-cols-2;
}

.automations-hub-label {
  @apply text-xs font-medium uppercase tracking-[0.08em] text-zinc-500;
}

.automations-hub-input,
.automations-hub-textarea {
  @apply w-full rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-900 outline-none transition focus:border-zinc-300 focus:bg-white;
}

.automations-hub-textarea {
  @apply resize-y leading-6;
}

.automations-hub-textarea--compact {
  @apply font-mono text-xs leading-5;
}

.automations-hub-picker,
.automations-hub-dropdown {
  @apply rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2;
}

.automations-hub-switch {
  @apply flex items-start gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700;
}

.automations-hub-switch-grid {
  @apply grid gap-2 md:grid-cols-2;
}

.automations-hub-switch input {
  @apply mt-0.5;
}
</style>
