<template>
  <Teleport to="body">
    <div v-if="visible" class="plugin-detail-overlay" @click.self="$emit('close')">
      <div class="plugin-detail-panel">
        <div class="plugin-detail-header">
          <div class="plugin-detail-title-wrap">
            <div
              class="plugin-detail-avatar"
              :style="avatarStyle"
            >
              {{ avatarText }}
            </div>
            <div class="plugin-detail-title-copy">
              <div class="plugin-detail-title-row">
                <h3 class="plugin-detail-title">{{ plugin.displayName }}</h3>
                <span v-if="plugin.installed && !plugin.enabled" class="plugin-detail-badge-muted">Disabled</span>
                <span v-else-if="plugin.installed" class="plugin-detail-badge">Installed</span>
              </div>
              <p class="plugin-detail-meta">
                {{ plugin.marketplaceName }}<span v-if="plugin.category"> · {{ plugin.category }}</span>
              </p>
            </div>
          </div>
          <button class="plugin-detail-close" type="button" aria-label="Close" @click="$emit('close')">×</button>
        </div>

        <div class="plugin-detail-body">
          <p v-if="summaryText" class="plugin-detail-description">{{ summaryText }}</p>

          <div v-if="plugin.capabilities.length > 0" class="plugin-detail-chip-row">
            <span v-for="capability in plugin.capabilities" :key="capability" class="plugin-detail-chip">{{ capability }}</span>
          </div>

          <div v-if="detailLoading" class="plugin-detail-loading">Loading plugin details…</div>
          <div v-else-if="detail" class="plugin-detail-sections">
            <section v-if="detail.skills.length > 0" class="plugin-detail-section">
              <h4 class="plugin-detail-section-title">Bundled Skills</h4>
              <div class="plugin-detail-list">
                <article v-for="skill in detail.skills" :key="skill.path || skill.name" class="plugin-detail-list-item">
                  <div>
                    <strong>{{ skill.displayName }}</strong>
                    <p v-if="skill.shortDescription || skill.description" class="plugin-detail-item-copy">
                      {{ skill.shortDescription || skill.description }}
                    </p>
                  </div>
                  <span class="plugin-detail-item-state" :class="{ 'is-disabled': !skill.enabled }">
                    {{ skill.enabled ? 'Enabled' : 'Disabled' }}
                  </span>
                </article>
              </div>
            </section>

            <section v-if="detail.apps.length > 0" class="plugin-detail-section">
              <h4 class="plugin-detail-section-title">Apps</h4>
              <div class="plugin-detail-list">
                <article v-for="app in detail.apps" :key="app.id" class="plugin-detail-list-item">
                  <div>
                    <strong>{{ app.name }}</strong>
                    <p v-if="app.description" class="plugin-detail-item-copy">{{ app.description }}</p>
                  </div>
                  <button
                    v-if="app.installUrl"
                    class="plugin-detail-link"
                    type="button"
                    @click="$emit('open-app', app.installUrl)"
                  >
                    {{ app.needsAuth ? 'Connect' : 'Open' }}
                  </button>
                </article>
              </div>
            </section>

            <section v-if="detail.mcpServers.length > 0" class="plugin-detail-section">
              <h4 class="plugin-detail-section-title">MCP Servers</h4>
              <div class="plugin-detail-chip-row">
                <span v-for="server in detail.mcpServers" :key="server" class="plugin-detail-chip">{{ server }}</span>
              </div>
            </section>
          </div>

          <section v-if="postInstallApps.length > 0" class="plugin-detail-section plugin-detail-callout">
            <h4 class="plugin-detail-section-title">Finish Setup</h4>
            <p class="plugin-detail-item-copy">This plugin still needs connector authorization.</p>
            <div class="plugin-detail-list">
              <article v-for="app in postInstallApps" :key="app.id" class="plugin-detail-list-item">
                <div>
                  <strong>{{ app.name }}</strong>
                  <p v-if="app.description" class="plugin-detail-item-copy">{{ app.description }}</p>
                </div>
                <button
                  v-if="app.installUrl"
                  class="plugin-detail-link"
                  type="button"
                  @click="$emit('open-app', app.installUrl)"
                >
                  Connect
                </button>
              </article>
            </div>
          </section>

          <div class="plugin-detail-links">
            <a v-if="plugin.websiteUrl" class="plugin-detail-anchor" :href="plugin.websiteUrl" target="_blank" rel="noreferrer">Website</a>
            <a v-if="plugin.privacyPolicyUrl" class="plugin-detail-anchor" :href="plugin.privacyPolicyUrl" target="_blank" rel="noreferrer">Privacy</a>
            <a v-if="plugin.termsOfServiceUrl" class="plugin-detail-anchor" :href="plugin.termsOfServiceUrl" target="_blank" rel="noreferrer">Terms</a>
          </div>
        </div>

        <div class="plugin-detail-footer">
          <button
            v-if="plugin.installed"
            class="plugin-detail-button plugin-detail-button-danger"
            type="button"
            :disabled="busy"
            @click="$emit('uninstall')"
          >
            {{ isUninstalling ? 'Uninstalling…' : 'Uninstall' }}
          </button>
          <button
            v-else
            class="plugin-detail-button plugin-detail-button-primary"
            type="button"
            :disabled="busy || plugin.installPolicy === 'NOT_AVAILABLE'"
            @click="$emit('install')"
          >
            {{ isInstalling ? 'Installing…' : plugin.installPolicy === 'NOT_AVAILABLE' ? 'Unavailable' : 'Install' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { UiPluginApp, UiPluginDetail, UiPluginSummary } from '../../api/codexGateway'

const props = defineProps<{
  visible: boolean
  plugin: UiPluginSummary
  detail: UiPluginDetail | null
  detailLoading?: boolean
  isInstalling?: boolean
  isUninstalling?: boolean
  postInstallApps?: UiPluginApp[]
}>()

defineEmits<{
  close: []
  install: []
  uninstall: []
  'open-app': [installUrl: string]
}>()

const busy = computed(() => props.isInstalling === true || props.isUninstalling === true)
const avatarText = computed(() => props.plugin.displayName.slice(0, 1).toUpperCase())
const avatarStyle = computed(() => {
  if (!props.plugin.brandColor) return undefined
  return { backgroundColor: props.plugin.brandColor }
})
const summaryText = computed(() => props.detail?.description || props.plugin.longDescription || props.plugin.shortDescription)
const postInstallApps = computed(() => props.postInstallApps ?? [])
</script>

<style scoped>
@reference "tailwindcss";

.plugin-detail-overlay {
  @apply fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center;
}

.plugin-detail-panel {
  @apply flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-xl sm:max-h-[85vh] sm:rounded-3xl;
}

.plugin-detail-header {
  @apply flex items-start justify-between gap-4 border-b border-zinc-100 px-4 py-4 sm:px-5;
}

.plugin-detail-title-wrap {
  @apply flex min-w-0 items-center gap-3;
}

.plugin-detail-avatar {
  @apply flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-zinc-900 text-sm font-semibold text-white;
}

.plugin-detail-title-copy {
  @apply min-w-0;
}

.plugin-detail-title-row {
  @apply flex items-center gap-2;
}

.plugin-detail-title {
  @apply m-0 truncate text-lg font-semibold text-zinc-900;
}

.plugin-detail-meta {
  @apply m-0 text-xs text-zinc-500;
}

.plugin-detail-badge {
  @apply rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700;
}

.plugin-detail-badge-muted {
  @apply rounded-full border border-zinc-200 bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500;
}

.plugin-detail-close {
  @apply inline-flex h-8 w-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-lg text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-800;
}

.plugin-detail-body {
  @apply flex-1 overflow-y-auto px-4 py-4 sm:px-5;
}

.plugin-detail-description {
  @apply m-0 text-sm leading-6 text-zinc-700;
}

.plugin-detail-loading {
  @apply mt-4 text-sm text-zinc-400;
}

.plugin-detail-sections {
  @apply mt-4 flex flex-col gap-4;
}

.plugin-detail-section {
  @apply flex flex-col gap-2;
}

.plugin-detail-section-title {
  @apply m-0 text-sm font-semibold text-zinc-900;
}

.plugin-detail-list {
  @apply flex flex-col gap-2;
}

.plugin-detail-list-item {
  @apply flex items-start justify-between gap-3 rounded-2xl border border-zinc-200 bg-zinc-50 px-3 py-3;
}

.plugin-detail-item-copy {
  @apply mt-1 text-xs leading-5 text-zinc-600;
}

.plugin-detail-item-state {
  @apply rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700;
}

.plugin-detail-item-state.is-disabled {
  @apply border-zinc-200 bg-zinc-100 text-zinc-500;
}

.plugin-detail-chip-row {
  @apply mt-3 flex flex-wrap gap-2;
}

.plugin-detail-chip {
  @apply rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs text-zinc-600;
}

.plugin-detail-link,
.plugin-detail-anchor {
  @apply inline-flex items-center rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs font-medium text-zinc-700 transition hover:bg-zinc-50;
}

.plugin-detail-links {
  @apply mt-4 flex flex-wrap gap-2;
}

.plugin-detail-callout {
  @apply mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-3;
}

.plugin-detail-footer {
  @apply flex justify-end gap-2 border-t border-zinc-100 px-4 py-4 sm:px-5;
}

.plugin-detail-button {
  @apply inline-flex items-center rounded-full px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60;
}

.plugin-detail-button-primary {
  @apply bg-zinc-900 text-white hover:bg-zinc-800;
}

.plugin-detail-button-danger {
  @apply border border-rose-200 bg-white text-rose-700 hover:bg-rose-50;
}
</style>
