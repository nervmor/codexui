import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CronExpressionParser } from 'cron-parser'
import { isCodexuiDebugMode, readCodexuiRunMode, type CodexuiRunMode } from './runtimeMode.js'

type RpcInvoker = {
  rpc: (method: string, params: unknown) => Promise<unknown>
}

type ReadJsonBody = (req: IncomingMessage) => Promise<unknown>

type AutomationSchedulePreset = 'hourly' | 'daily' | 'weekly' | 'custom'
type AutomationRunMode = 'local' | 'worktree'
type AutomationSandboxMode = 'default' | 'read-only' | 'workspace-write' | 'danger-full-access'
type AutomationWebSearchMode = 'default' | 'disabled' | 'live'
type AutomationApprovalPolicy = 'default' | 'never' | 'on-request' | 'on-failure' | 'untrusted'
type AutomationApprovalsReviewer = 'default' | 'user' | 'auto_review'
type AutomationStatus = 'idle' | 'running' | 'succeeded' | 'failed'
type AutomationRunStatus = 'running' | 'completed' | 'failed' | 'archived'

type AutomationUsage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

type AutomationRunItem = {
  id: string
  type: string
  title: string
  status: string
  body: string
}

type AutomationRecord = {
  id: string
  title: string
  prompt: string
  projectPaths: string[]
  skillNames: string[]
  enabled: boolean
  runMode: AutomationRunMode
  schedulePreset: AutomationSchedulePreset
  cronExpression: string
  model: string
  reasoningEffort: string
  sandboxMode: AutomationSandboxMode
  outputSchema: string
  resumeThread: boolean
  ephemeral: boolean
  ignoreUserConfig: boolean
  ignoreRules: boolean
  networkAccess: boolean
  webSearchMode: AutomationWebSearchMode
  approvalPolicy: AutomationApprovalPolicy
  approvalsReviewer: AutomationApprovalsReviewer
  autoArchiveEmpty: boolean
  createdAtIso: string
  updatedAtIso: string
  nextRunAtIso: string | null
  lastRunAtIso: string | null
  lastSuccessAtIso: string | null
  lastStatus: AutomationStatus
  lastError: string
}

type AutomationRunRecord = {
  id: string
  automationId: string
  automationTitle: string
  projectPath: string
  cwd: string
  effectiveRunMode: AutomationRunMode
  worktreeCwd: string
  status: AutomationRunStatus
  unread: boolean
  archived: boolean
  startedAtIso: string
  completedAtIso: string | null
  summary: string
  finalMessage: string
  error: string
  outputPath: string
  eventLogPath: string
  threadId: string
  model: string
  reasoningEffort: string
  sandboxMode: string
  webSearchMode: AutomationWebSearchMode
  approvalPolicy: AutomationApprovalPolicy
  approvalsReviewer: AutomationApprovalsReviewer
  resumedThreadId: string
  usage: AutomationUsage | null
  items: AutomationRunItem[]
  structuredResult: unknown | null
  hasFindings: boolean
}

type AutomationStore = {
  automations: AutomationRecord[]
  runs: AutomationRunRecord[]
}

type AutomationDefaults = {
  model: string
  reasoningEffort: string
  sandboxMode: string
}

type AutomationRuntimeState = {
  runMode: CodexuiRunMode
  readOnly: boolean
}

const AUTOMATION_STORE_VERSION = 1
const MAX_AUTOMATION_RUNS = 250
const SCHEDULER_INTERVAL_MS = 30_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  for (const item of value) {
    const candidate = readString(item)
    if (candidate && !normalized.includes(candidate)) {
      normalized.push(candidate)
    }
  }
  return normalized
}

function getCodexHomeDir(): string {
  const configured = process.env.CODEX_HOME?.trim()
  return configured || join(homedir(), '.codex')
}

function getAutomationRootDir(): string {
  return join(getCodexHomeDir(), 'codexui-automations')
}

function getAutomationStorePath(): string {
  return join(getAutomationRootDir(), 'store.json')
}

function getAutomationRunsDir(): string {
  return join(getAutomationRootDir(), 'runs')
}

function nowIso(): string {
  return new Date().toISOString()
}

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`
}

function normalizeSchedulePreset(value: unknown): AutomationSchedulePreset {
  return value === 'hourly' || value === 'daily' || value === 'weekly' || value === 'custom'
    ? value
    : 'custom'
}

function normalizeRunMode(value: unknown): AutomationRunMode {
  return value === 'worktree' ? 'worktree' : 'local'
}

function normalizeSandboxMode(value: unknown): AutomationSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access' || value === 'default'
    ? value
    : 'default'
}

function normalizeWebSearchMode(value: unknown): AutomationWebSearchMode {
  return value === 'disabled' || value === 'live' || value === 'default' ? value : 'default'
}

function normalizeApprovalPolicy(value: unknown): AutomationApprovalPolicy {
  return value === 'never' || value === 'on-request' || value === 'on-failure' || value === 'untrusted' || value === 'default'
    ? value
    : 'default'
}

function normalizeApprovalsReviewer(value: unknown): AutomationApprovalsReviewer {
  return value === 'user' || value === 'auto_review' || value === 'default' ? value : 'default'
}

function normalizeAutomationStatus(value: unknown): AutomationStatus {
  return value === 'running' || value === 'succeeded' || value === 'failed' ? value : 'idle'
}

function normalizeAutomationRunStatus(value: unknown): AutomationRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed' || value === 'archived'
    ? value
    : 'completed'
}

function normalizeAutomationRecord(value: unknown): AutomationRecord | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const title = readString(record.title)
  const prompt = readString(record.prompt)
  if (!id || !title || !prompt) return null

  return {
    id,
    title,
    prompt,
    projectPaths: readStringArray(record.projectPaths),
    skillNames: readStringArray(record.skillNames),
    enabled: readBoolean(record.enabled, true),
    runMode: normalizeRunMode(record.runMode),
    schedulePreset: normalizeSchedulePreset(record.schedulePreset),
    cronExpression: readString(record.cronExpression),
    model: readString(record.model),
    reasoningEffort: readString(record.reasoningEffort),
    sandboxMode: normalizeSandboxMode(record.sandboxMode),
    outputSchema: typeof record.outputSchema === 'string' ? record.outputSchema : '',
    resumeThread: readBoolean(record.resumeThread, false),
    ephemeral: readBoolean(record.ephemeral, false),
    ignoreUserConfig: readBoolean(record.ignoreUserConfig, false),
    ignoreRules: readBoolean(record.ignoreRules, false),
    networkAccess: readBoolean(record.networkAccess, false),
    webSearchMode: normalizeWebSearchMode(record.webSearchMode),
    approvalPolicy: normalizeApprovalPolicy(record.approvalPolicy),
    approvalsReviewer: normalizeApprovalsReviewer(record.approvalsReviewer),
    autoArchiveEmpty: readBoolean(record.autoArchiveEmpty, true),
    createdAtIso: readString(record.createdAtIso) || nowIso(),
    updatedAtIso: readString(record.updatedAtIso) || nowIso(),
    nextRunAtIso: readString(record.nextRunAtIso) || null,
    lastRunAtIso: readString(record.lastRunAtIso) || null,
    lastSuccessAtIso: readString(record.lastSuccessAtIso) || null,
    lastStatus: normalizeAutomationStatus(record.lastStatus),
    lastError: readString(record.lastError),
  }
}

function normalizeAutomationRunRecord(value: unknown): AutomationRunRecord | null {
  const record = asRecord(value)
  if (!record) return null
  const id = readString(record.id)
  const automationId = readString(record.automationId)
  const automationTitle = readString(record.automationTitle)
  const projectPath = readString(record.projectPath)
  const cwd = readString(record.cwd)
  if (!id || !automationId || !automationTitle || !projectPath || !cwd) return null

  return {
    id,
    automationId,
    automationTitle,
    projectPath,
    cwd,
    effectiveRunMode: normalizeRunMode(record.effectiveRunMode),
    worktreeCwd: readString(record.worktreeCwd),
    status: normalizeAutomationRunStatus(record.status),
    unread: readBoolean(record.unread, false),
    archived: readBoolean(record.archived, false),
    startedAtIso: readString(record.startedAtIso) || nowIso(),
    completedAtIso: readString(record.completedAtIso) || null,
    summary: readString(record.summary),
    finalMessage: typeof record.finalMessage === 'string' ? record.finalMessage : '',
    error: readString(record.error),
    outputPath: readString(record.outputPath),
    eventLogPath: readString(record.eventLogPath),
    threadId: readString(record.threadId),
    model: readString(record.model),
    reasoningEffort: readString(record.reasoningEffort),
    sandboxMode: readString(record.sandboxMode),
    webSearchMode: normalizeWebSearchMode(record.webSearchMode),
    approvalPolicy: normalizeApprovalPolicy(record.approvalPolicy),
    approvalsReviewer: normalizeApprovalsReviewer(record.approvalsReviewer),
    resumedThreadId: readString(record.resumedThreadId),
    usage: normalizeUsage(record.usage),
    items: normalizeRunItems(record.items),
    structuredResult: normalizeStructuredResult(record.structuredResult),
    hasFindings: readBoolean(record.hasFindings, false),
  }
}

function normalizeUsage(value: unknown): AutomationUsage | null {
  const record = asRecord(value)
  if (!record) return null
  return {
    inputTokens: readFiniteNumber(record.inputTokens),
    cachedInputTokens: readFiniteNumber(record.cachedInputTokens),
    outputTokens: readFiniteNumber(record.outputTokens),
    reasoningOutputTokens: readFiniteNumber(record.reasoningOutputTokens),
  }
}

function readFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeRunItems(value: unknown): AutomationRunItem[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      const record = asRecord(entry)
      if (!record) return null
      const id = readString(record.id)
      const type = readString(record.type)
      const title = readString(record.title)
      if (!id || !type || !title) return null
      return {
        id,
        type,
        title,
        status: readString(record.status),
        body: typeof record.body === 'string' ? record.body : '',
      }
    })
    .filter((entry): entry is AutomationRunItem => entry !== null)
}

function normalizeStructuredResult(value: unknown): unknown | null {
  return value === undefined ? null : value
}

function normalizeStore(value: unknown): AutomationStore {
  const record = asRecord(value)
  const automations = Array.isArray(record?.automations)
    ? record.automations.map((item) => normalizeAutomationRecord(item)).filter((item): item is AutomationRecord => item !== null)
    : []
  const runs = Array.isArray(record?.runs)
    ? record.runs.map((item) => normalizeAutomationRunRecord(item)).filter((item): item is AutomationRunRecord => item !== null)
    : []
  return { automations, runs: runs.slice(0, MAX_AUTOMATION_RUNS) }
}

function schedulePresetToCron(preset: AutomationSchedulePreset, customCron: string): string {
  if (preset === 'hourly') return '0 * * * *'
  if (preset === 'daily') return '0 9 * * *'
  if (preset === 'weekly') return '0 9 * * 1'
  return customCron.trim()
}

function normalizeSkillToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

function buildPromptWithSkills(prompt: string, skillNames: string[]): string {
  const tokens = skillNames
    .map((name) => normalizeSkillToken(name))
    .filter(Boolean)
    .map((name) => `$${name}`)
  if (tokens.length === 0) return prompt.trim()
  return `${tokens.join(' ')}\n\n${prompt.trim()}`
}

function computeNextRunAtIso(cronExpression: string, baseDate = new Date()): string | null {
  if (!cronExpression.trim()) return null
  try {
    const expression = CronExpressionParser.parse(cronExpression, { currentDate: baseDate })
    return expression.next().toDate().toISOString()
  } catch {
    return null
  }
}

function trimRunSummary(value: string): string {
  const firstLine = value.replace(/\r\n/g, '\n').split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  if (firstLine.length <= 140) return firstLine
  return `${firstLine.slice(0, 137)}...`
}

function detectFindings(finalMessage: string, structuredResult: unknown | null): boolean {
  const structuredStatus = readStructuredStatus(structuredResult)
  if (structuredStatus) {
    return structuredStatus === 'findings' || structuredStatus === 'action_required' || structuredStatus === 'failed'
  }

  const normalized = finalMessage.trim().toLowerCase()
  if (!normalized) return false
  const neutralPatterns = [
    'no findings',
    'no issues found',
    'nothing to report',
    'no action needed',
    'all clear',
    'no changes needed',
    'no problems found',
    'looks good',
  ]
  return !neutralPatterns.some((pattern) => normalized.includes(pattern))
}

function readStructuredStatus(value: unknown | null): string {
  const record = asRecord(value)
  if (!record) return ''
  const status = readString(record.status).toLowerCase()
  if (status) return status
  const hasFindings = record.hasFindings ?? record.has_findings
  if (typeof hasFindings === 'boolean') return hasFindings ? 'findings' : 'clear'
  const findings = record.findings
  if (Array.isArray(findings)) return findings.length > 0 ? 'findings' : 'clear'
  return ''
}

function parseStructuredResult(finalMessage: string): unknown | null {
  const trimmed = finalMessage.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

function structuredSummary(value: unknown | null): string {
  const record = asRecord(value)
  if (!record) return ''
  return readString(record.summary) || readString(record.title) || readString(record.message)
}

function usageFromEvent(value: unknown): AutomationUsage | null {
  const record = asRecord(value)
  const usage = asRecord(record?.usage)
  if (!usage) return null
  return {
    inputTokens: readFiniteNumber(usage.input_tokens),
    cachedInputTokens: readFiniteNumber(usage.cached_input_tokens),
    outputTokens: readFiniteNumber(usage.output_tokens),
    reasoningOutputTokens: readFiniteNumber(usage.reasoning_output_tokens),
  }
}

function summarizeJsonValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function formatRunItem(rawItem: unknown, eventType: string): AutomationRunItem | null {
  const item = asRecord(rawItem)
  if (!item) return null
  const id = readString(item.id) || createId('item')
  const type = readString(item.type) || 'unknown'
  const status = readString(item.status) || (eventType === 'item.completed' ? 'completed' : eventType === 'item.updated' ? 'updated' : 'in_progress')

  if (type === 'agent_message') {
    return { id, type, title: 'Agent message', status, body: typeof item.text === 'string' ? item.text : '' }
  }
  if (type === 'reasoning') {
    return { id, type, title: 'Reasoning', status, body: typeof item.text === 'string' ? item.text : '' }
  }
  if (type === 'command_execution') {
    const command = readString(item.command)
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : ''
    const exitCode = typeof item.exit_code === 'number' ? `exit ${String(item.exit_code)}` : ''
    return { id, type, title: command || 'Command', status: readString(item.status) || status, body: [exitCode, output].filter(Boolean).join('\n') }
  }
  if (type === 'file_change') {
    const changes = Array.isArray(item.changes)
      ? item.changes.map((change) => {
        const record = asRecord(change)
        return [readString(record?.kind), readString(record?.path)].filter(Boolean).join(' ')
      }).filter(Boolean)
      : []
    return { id, type, title: 'File changes', status: readString(item.status) || status, body: changes.join('\n') }
  }
  if (type === 'mcp_tool_call') {
    const title = [readString(item.server), readString(item.tool)].filter(Boolean).join(' / ') || 'MCP tool'
    const body = item.error ? summarizeJsonValue(item.error) : summarizeJsonValue(item.result || item.arguments)
    return { id, type, title, status: readString(item.status) || status, body }
  }
  if (type === 'collab_tool_call') {
    return { id, type, title: readString(item.tool) || 'Collab tool', status: readString(item.status) || status, body: summarizeJsonValue(item.agents_states || item.prompt) }
  }
  if (type === 'web_search') {
    return { id, type, title: 'Web search', status, body: [readString(item.query), summarizeJsonValue(item.action)].filter(Boolean).join('\n') }
  }
  if (type === 'todo_list') {
    const todos = Array.isArray(item.items)
      ? item.items.map((todo) => {
        const record = asRecord(todo)
        const marker = record?.completed === true ? '[x]' : '[ ]'
        return `${marker} ${readString(record?.text)}`
      }).filter((todo) => todo.trim() !== '[ ]' && todo.trim() !== '[x]')
      : []
    return { id, type, title: 'Todo list', status, body: todos.join('\n') }
  }
  if (type === 'error') {
    return { id, type, title: 'Error', status, body: readString(item.message) }
  }
  return { id, type, title: type.replace(/_/g, ' '), status, body: summarizeJsonValue(item) }
}

function collectExecEvent(event: unknown, state: {
  threadId: string
  usage: AutomationUsage | null
  itemsById: Map<string, AutomationRunItem>
  finalMessage: string
  turnFailure: string
}): void {
  const record = asRecord(event)
  if (!record) return
  const type = readString(record.type)
  if (type === 'thread.started' && !state.threadId) {
    state.threadId = readString(record.thread_id)
    return
  }
  if (type === 'turn.completed') {
    state.usage = usageFromEvent(record)
    return
  }
  if (type === 'turn.failed') {
    const error = asRecord(record.error)
    state.turnFailure = readString(error?.message) || readString(record.message) || 'Automation turn failed'
    return
  }
  if (type === 'error') {
    state.turnFailure = readString(record.message) || 'Automation event stream failed'
    return
  }
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const runItem = formatRunItem(record.item, type)
    if (!runItem) return
    state.itemsById.set(runItem.id, runItem)
    if (type === 'item.completed' && runItem.type === 'agent_message') {
      state.finalMessage = runItem.body
    }
  }
}

async function readStore(): Promise<AutomationStore> {
  try {
    const raw = await readFile(getAutomationStorePath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return normalizeStore(parsed)
  } catch {
    return { automations: [], runs: [] }
  }
}

async function writeStore(store: AutomationStore): Promise<void> {
  await mkdir(getAutomationRootDir(), { recursive: true })
  const payload = {
    version: AUTOMATION_STORE_VERSION,
    automations: store.automations,
    runs: store.runs.slice(0, MAX_AUTOMATION_RUNS),
  }
  await writeFile(getAutomationStorePath(), JSON.stringify(payload, null, 2), 'utf8')
}

async function runCommandCapture(command: string, args: string[], cwd: string): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim())
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `Command failed with code ${String(code ?? -1)}`))
    })
  })
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

async function resolveWorktreeCwd(projectPath: string, automationId: string): Promise<{ cwd: string; effectiveRunMode: AutomationRunMode }> {
  try {
    const gitRoot = await runCommandCapture('git', ['rev-parse', '--show-toplevel'], projectPath)
    await runCommandCapture('git', ['rev-parse', '--verify', 'HEAD'], gitRoot)

    const repoName = basename(gitRoot) || 'repo'
    const worktreesRoot = join(getCodexHomeDir(), 'worktrees')
    await mkdir(worktreesRoot, { recursive: true })

    const suffix = createId(automationId.slice(-6)).replace(/^.+?_/, '')
    const worktreeParent = join(worktreesRoot, suffix)
    const worktreeCwd = join(worktreeParent, repoName)
    const branch = `codex/automation-${automationId.slice(0, 6)}-${suffix.slice(-6)}`

    await mkdir(worktreeParent, { recursive: true })
    await runCommandCapture('git', ['worktree', 'add', '-b', branch, worktreeCwd, 'HEAD'], gitRoot)
    return { cwd: worktreeCwd, effectiveRunMode: 'worktree' }
  } catch {
    return { cwd: projectPath, effectiveRunMode: 'local' }
  }
}

function readPathId(pathname: string, prefix: string, suffix = ''): string {
  if (!pathname.startsWith(prefix)) return ''
  const remainder = pathname.slice(prefix.length)
  if (suffix && !remainder.endsWith(suffix)) return ''
  const value = suffix ? remainder.slice(0, -suffix.length) : remainder
  return decodeURIComponent(value).trim().replace(/^\/+|\/+$/g, '')
}

class AutomationManager {
  private store: AutomationStore = { automations: [], runs: [] }
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private savePromise: Promise<void> = Promise.resolve()
  private schedulerTimer: NodeJS.Timeout | null = null
  private tickInFlight = false
  private readonly runningAutomationIds = new Set<string>()

  constructor(
    private readonly appServer: RpcInvoker,
    private readonly runtime: AutomationRuntimeState,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (!this.loadPromise) {
      this.loadPromise = readStore()
        .then((store) => {
          this.store = store
          this.loaded = true
          if (!this.runtime.readOnly && !this.schedulerTimer) {
            this.schedulerTimer = setInterval(() => {
              void this.tick()
            }, SCHEDULER_INTERVAL_MS)
            this.schedulerTimer.unref()
          }
        })
        .finally(() => {
          this.loadPromise = null
        })
    }
    await this.loadPromise
  }

  private async persist(): Promise<void> {
    this.savePromise = this.savePromise.then(async () => {
      await writeStore(this.store)
    })
    await this.savePromise
  }

  private async getDefaults(): Promise<AutomationDefaults> {
    try {
      const payload = asRecord(await this.appServer.rpc('config/read', {}))
      const config = asRecord(payload?.config)
      return {
        model: readString(config?.model),
        reasoningEffort: readString(config?.model_reasoning_effort),
        sandboxMode: readString(config?.sandbox_mode) || 'workspace-write',
      }
    } catch {
      return {
        model: '',
        reasoningEffort: '',
        sandboxMode: 'workspace-write',
      }
    }
  }

  private sortState(): void {
    this.store.automations.sort((first, second) => first.title.localeCompare(second.title))
    this.store.runs.sort((first, second) => second.startedAtIso.localeCompare(first.startedAtIso))
    if (this.store.runs.length > MAX_AUTOMATION_RUNS) {
      this.store.runs = this.store.runs.slice(0, MAX_AUTOMATION_RUNS)
    }
  }

  private buildRunPaths(runId: string): { runDir: string; outputPath: string; eventLogPath: string; outputSchemaPath: string } {
    const runDir = join(getAutomationRunsDir(), runId)
    return {
      runDir,
      outputPath: join(runDir, 'last-message.txt'),
      eventLogPath: join(runDir, 'events.jsonl'),
      outputSchemaPath: join(runDir, 'output-schema.json'),
    }
  }

  private findResumeThreadId(automationId: string, projectPath: string): string {
    const previousRun = this.store.runs.find((run) => (
      run.automationId === automationId
      && run.projectPath === projectPath
      && run.threadId
      && run.status !== 'failed'
    ))
    return previousRun?.threadId ?? ''
  }

  private async createRunRecord(
    automation: AutomationRecord,
    projectPath: string,
    defaults: AutomationDefaults,
    resumedThreadId: string,
  ): Promise<AutomationRunRecord> {
    const runId = createId('run')
    const { runDir, outputPath, eventLogPath } = this.buildRunPaths(runId)
    await mkdir(runDir, { recursive: true })

    let cwd = projectPath
    let effectiveRunMode: AutomationRunMode = 'local'
    if (automation.runMode === 'worktree') {
      const resolved = await resolveWorktreeCwd(projectPath, automation.id)
      cwd = resolved.cwd
      effectiveRunMode = resolved.effectiveRunMode
    }

    return {
      id: runId,
      automationId: automation.id,
      automationTitle: automation.title,
      projectPath,
      cwd,
      effectiveRunMode,
      worktreeCwd: effectiveRunMode === 'worktree' ? cwd : '',
      status: 'running',
      unread: false,
      archived: false,
      startedAtIso: nowIso(),
      completedAtIso: null,
      summary: 'Running automation',
      finalMessage: '',
      error: '',
      outputPath,
      eventLogPath,
      threadId: '',
      model: automation.model || defaults.model,
      reasoningEffort: automation.reasoningEffort || defaults.reasoningEffort,
      sandboxMode: automation.sandboxMode === 'default'
        ? (defaults.sandboxMode || 'workspace-write')
        : automation.sandboxMode,
      webSearchMode: automation.webSearchMode,
      approvalPolicy: automation.approvalPolicy,
      approvalsReviewer: automation.approvalsReviewer,
      resumedThreadId,
      usage: null,
      items: [],
      structuredResult: null,
      hasFindings: false,
    }
  }

  private updateAutomationAfterRun(automationId: string, updates: Partial<AutomationRecord>): void {
    this.store.automations = this.store.automations.map((automation) => (
      automation.id === automationId ? { ...automation, ...updates, updatedAtIso: nowIso() } : automation
    ))
  }

  private async executeRun(automation: AutomationRecord, runRecord: AutomationRunRecord): Promise<void> {
    const prompt = buildPromptWithSkills(automation.prompt, automation.skillNames)
    const { outputSchemaPath } = this.buildRunPaths(runRecord.id)
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', runRecord.cwd, '-o', runRecord.outputPath]

    if (runRecord.model) {
      args.push('--model', runRecord.model)
    }
    if (runRecord.sandboxMode) {
      args.push('--sandbox', runRecord.sandboxMode)
    }
    if (runRecord.reasoningEffort) {
      args.push('-c', `model_reasoning_effort="${runRecord.reasoningEffort}"`)
    }
    if (automation.outputSchema.trim()) {
      await writeFile(outputSchemaPath, automation.outputSchema.trim(), 'utf8')
      args.push('--output-schema', outputSchemaPath)
    }
    if (automation.ephemeral) {
      args.push('--ephemeral')
    }
    if (automation.ignoreUserConfig) {
      args.push('--ignore-user-config')
    }
    if (automation.ignoreRules) {
      args.push('--ignore-rules')
    }
    if (automation.networkAccess) {
      args.push('-c', 'sandbox_workspace_write.network_access=true')
    }
    if (automation.webSearchMode !== 'default') {
      args.push('-c', `web_search="${automation.webSearchMode}"`)
    }
    if (automation.approvalPolicy !== 'default') {
      args.push('-c', `approval_policy="${automation.approvalPolicy}"`)
    }
    if (automation.approvalsReviewer !== 'default') {
      args.push('-c', `approvals_reviewer="${automation.approvalsReviewer}"`)
    }
    if (runRecord.resumedThreadId) {
      args.push('resume', runRecord.resumedThreadId, '-')
    } else {
      args.push('-')
    }

    const eventStream = createWriteStream(runRecord.eventLogPath, { flags: 'w' })
    let stdoutBuffer = ''
    let stderrBuffer = ''
    const eventState = {
      threadId: runRecord.resumedThreadId,
      usage: null as AutomationUsage | null,
      itemsById: new Map<string, AutomationRunItem>(),
      finalMessage: '',
      turnFailure: '',
    }

    const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
      const proc = spawn('codex', args, {
        cwd: runRecord.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      proc.stdin.end(prompt)
      proc.on('error', reject)

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        stdoutBuffer += text
        eventStream.write(text)

        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            collectExecEvent(JSON.parse(line) as unknown, eventState)
          } catch {
            // Keep the event log verbatim even if parsing fails.
          }
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString()
      })

      proc.on('close', (code) => {
        if (stdoutBuffer.trim()) {
          try {
            collectExecEvent(JSON.parse(stdoutBuffer) as unknown, eventState)
          } catch {
            // Keep the event log verbatim even if parsing fails.
          }
        }
        eventStream.end()
        resolvePromise(code)
      })
    })

    let finalMessage = ''
    try {
      finalMessage = await readFile(runRecord.outputPath, 'utf8')
    } catch {
      finalMessage = ''
    }
    finalMessage = eventState.finalMessage || finalMessage
    const structuredResult = parseStructuredResult(finalMessage)

    const runFailed = exitCode !== 0 || Boolean(eventState.turnFailure)
    const errorText = !runFailed
      ? ''
      : eventState.turnFailure || trimRunSummary(stderrBuffer.trim()) || 'Automation run failed'
    const hasFindings = !runFailed && detectFindings(finalMessage, structuredResult)
    const archived = !runFailed && automation.autoArchiveEmpty && !hasFindings
    const summary = !runFailed
      ? structuredSummary(structuredResult) || trimRunSummary(finalMessage) || (hasFindings ? 'Automation finished with findings' : 'Automation finished without notable findings')
      : errorText

    const completedRun: AutomationRunRecord = {
      ...runRecord,
      threadId: eventState.threadId,
      completedAtIso: nowIso(),
      finalMessage,
      error: errorText,
      usage: eventState.usage,
      items: [...eventState.itemsById.values()],
      structuredResult,
      hasFindings,
      unread: runFailed ? true : hasFindings,
      archived,
      status: archived ? 'archived' : runFailed ? 'failed' : 'completed',
      summary,
    }

    this.store.runs = this.store.runs.map((run) => run.id === runRecord.id ? completedRun : run)
    this.updateAutomationAfterRun(automation.id, {
      lastRunAtIso: completedRun.startedAtIso,
      lastSuccessAtIso: runFailed ? automation.lastSuccessAtIso : completedRun.completedAtIso,
      lastStatus: runFailed ? 'failed' : 'succeeded',
      lastError: errorText,
    })
    this.sortState()
    await this.persist()
  }

  private validateInput(input: unknown): {
    title: string
    prompt: string
    projectPaths: string[]
    skillNames: string[]
    enabled: boolean
    runMode: AutomationRunMode
    schedulePreset: AutomationSchedulePreset
    cronExpression: string
    model: string
    reasoningEffort: string
    sandboxMode: AutomationSandboxMode
    outputSchema: string
    resumeThread: boolean
    ephemeral: boolean
    ignoreUserConfig: boolean
    ignoreRules: boolean
    networkAccess: boolean
    webSearchMode: AutomationWebSearchMode
    approvalPolicy: AutomationApprovalPolicy
    approvalsReviewer: AutomationApprovalsReviewer
    autoArchiveEmpty: boolean
  } {
    const record = asRecord(input)
    if (!record) {
      throw new Error('Expected request body object')
    }

    const title = readString(record.title)
    const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : ''
    const projectPaths = readStringArray(record.projectPaths).map((path) => isAbsolute(path) ? path : resolve(path))
    const schedulePreset = normalizeSchedulePreset(record.schedulePreset)
    const cronExpression = schedulePresetToCron(schedulePreset, readString(record.cronExpression))

    if (!title) throw new Error('Title is required')
    if (!prompt) throw new Error('Prompt is required')
    if (projectPaths.length === 0) throw new Error('Select at least one project')
    if (!cronExpression) throw new Error('Schedule is required')
    if (!computeNextRunAtIso(cronExpression)) throw new Error('Invalid cron expression')
    const outputSchema = typeof record.outputSchema === 'string' ? record.outputSchema.trim() : ''
    if (outputSchema) {
      try {
        JSON.parse(outputSchema) as unknown
      } catch {
        throw new Error('Output schema must be valid JSON')
      }
    }

    return {
      title,
      prompt,
      projectPaths,
      skillNames: readStringArray(record.skillNames),
      enabled: readBoolean(record.enabled, true),
      runMode: normalizeRunMode(record.runMode),
      schedulePreset,
      cronExpression,
      model: readString(record.model),
      reasoningEffort: readString(record.reasoningEffort),
      sandboxMode: normalizeSandboxMode(record.sandboxMode),
      outputSchema,
      resumeThread: readBoolean(record.resumeThread, false),
      ephemeral: readBoolean(record.ephemeral, false),
      ignoreUserConfig: readBoolean(record.ignoreUserConfig, false),
      ignoreRules: readBoolean(record.ignoreRules, false),
      networkAccess: readBoolean(record.networkAccess, false),
      webSearchMode: normalizeWebSearchMode(record.webSearchMode),
      approvalPolicy: normalizeApprovalPolicy(record.approvalPolicy),
      approvalsReviewer: normalizeApprovalsReviewer(record.approvalsReviewer),
      autoArchiveEmpty: readBoolean(record.autoArchiveEmpty, true),
    }
  }

  async getState(): Promise<{ automations: AutomationRecord[]; runs: AutomationRunRecord[]; defaults: AutomationDefaults; runtime: AutomationRuntimeState }> {
    await this.ensureLoaded()
    this.sortState()
    return {
      automations: this.store.automations,
      runs: this.store.runs,
      defaults: await this.getDefaults(),
      runtime: this.runtime,
    }
  }

  private assertWritable(): void {
    if (!this.runtime.readOnly) return
    throw new Error('Automations are read-only when CODEXUI_RUN_MODE=debug')
  }

  async createAutomation(input: unknown): Promise<AutomationRecord> {
    await this.ensureLoaded()
    this.assertWritable()
    const normalized = this.validateInput(input)
    for (const path of normalized.projectPaths) {
      if (!(await directoryExists(path))) {
        throw new Error(`Project does not exist: ${path}`)
      }
    }

    const automation: AutomationRecord = {
      id: createId('automation'),
      createdAtIso: nowIso(),
      updatedAtIso: nowIso(),
      nextRunAtIso: computeNextRunAtIso(normalized.cronExpression),
      lastRunAtIso: null,
      lastSuccessAtIso: null,
      lastStatus: 'idle',
      lastError: '',
      ...normalized,
    }

    this.store.automations.push(automation)
    this.sortState()
    await this.persist()
    return automation
  }

  async updateAutomation(id: string, input: unknown): Promise<AutomationRecord> {
    await this.ensureLoaded()
    this.assertWritable()
    const normalizedId = id.trim()
    const existing = this.store.automations.find((automation) => automation.id === normalizedId)
    if (!existing) {
      throw new Error('Automation not found')
    }

    const normalized = this.validateInput(input)
    for (const path of normalized.projectPaths) {
      if (!(await directoryExists(path))) {
        throw new Error(`Project does not exist: ${path}`)
      }
    }

    const updated: AutomationRecord = {
      ...existing,
      ...normalized,
      updatedAtIso: nowIso(),
      nextRunAtIso: computeNextRunAtIso(normalized.cronExpression),
    }

    this.store.automations = this.store.automations.map((automation) => automation.id === normalizedId ? updated : automation)
    this.sortState()
    await this.persist()
    return updated
  }

  async deleteAutomation(id: string): Promise<void> {
    await this.ensureLoaded()
    this.assertWritable()
    const normalizedId = id.trim()
    this.store.automations = this.store.automations.filter((automation) => automation.id !== normalizedId)
    this.store.runs = this.store.runs.filter((run) => run.automationId !== normalizedId)
    await this.persist()
  }

  async setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationRecord> {
    await this.ensureLoaded()
    this.assertWritable()
    const normalizedId = id.trim()
    let updated: AutomationRecord | null = null
    this.store.automations = this.store.automations.map((automation) => {
      if (automation.id !== normalizedId) return automation
      updated = {
        ...automation,
        enabled,
        updatedAtIso: nowIso(),
        nextRunAtIso: enabled ? computeNextRunAtIso(automation.cronExpression) : automation.nextRunAtIso,
      }
      return updated
    })
    if (!updated) throw new Error('Automation not found')
    await this.persist()
    return updated
  }

  async setRunState(id: string, updates: { unread?: boolean; archived?: boolean }): Promise<AutomationRunRecord> {
    await this.ensureLoaded()
    this.assertWritable()
    const normalizedId = id.trim()
    let updated: AutomationRunRecord | null = null
    this.store.runs = this.store.runs.map((run) => {
      if (run.id !== normalizedId) return run
      updated = {
        ...run,
        unread: updates.unread ?? run.unread,
        archived: updates.archived ?? run.archived,
        status: (updates.archived ?? run.archived) && run.status !== 'running' ? 'archived' : run.status,
      }
      return updated
    })
    if (!updated) throw new Error('Run not found')
    await this.persist()
    return updated
  }

  async runAutomationNow(id: string): Promise<void> {
    await this.ensureLoaded()
    this.assertWritable()
    const automation = this.store.automations.find((item) => item.id === id.trim())
    if (!automation) throw new Error('Automation not found')
    void this.runAutomation(automation)
  }

  private async runAutomation(automation: AutomationRecord): Promise<void> {
    if (this.runningAutomationIds.has(automation.id)) {
      return
    }

    this.runningAutomationIds.add(automation.id)
    try {
      const defaults = await this.getDefaults()
      this.updateAutomationAfterRun(automation.id, {
        lastStatus: 'running',
        lastError: '',
      })
      await this.persist()

      for (const projectPath of automation.projectPaths) {
        const resumedThreadId = automation.resumeThread ? this.findResumeThreadId(automation.id, projectPath) : ''
        const runRecord = await this.createRunRecord(automation, projectPath, defaults, resumedThreadId)
        this.store.runs.unshift(runRecord)
        this.sortState()
        await this.persist()
        await this.executeRun(automation, runRecord)
      }
    } finally {
      this.runningAutomationIds.delete(automation.id)
    }
  }

  async tick(): Promise<void> {
    await this.ensureLoaded()
    if (this.runtime.readOnly) return
    if (this.tickInFlight) return
    this.tickInFlight = true
    try {
      const now = new Date()
      const due = this.store.automations.filter((automation) => (
        automation.enabled
        && automation.nextRunAtIso
        && new Date(automation.nextRunAtIso).getTime() <= now.getTime()
      ))

      for (const automation of due) {
        const nextRunAtIso = computeNextRunAtIso(automation.cronExpression, now)
        this.updateAutomationAfterRun(automation.id, { nextRunAtIso })
        await this.persist()
        void this.runAutomation(automation)
      }
    } finally {
      this.tickInFlight = false
    }
  }
}

const AUTOMATION_MANAGER_KEY = '__codexuiAutomationManager__'

function getAutomationManager(appServer: RpcInvoker): AutomationManager {
  const scope = globalThis as typeof globalThis & { [AUTOMATION_MANAGER_KEY]?: AutomationManager }
  if (!scope[AUTOMATION_MANAGER_KEY]) {
    scope[AUTOMATION_MANAGER_KEY] = new AutomationManager(appServer, {
      runMode: readCodexuiRunMode(),
      readOnly: isCodexuiDebugMode(),
    })
  }
  return scope[AUTOMATION_MANAGER_KEY]
}

export async function handleAutomationRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: { appServer: RpcInvoker; readJsonBody: ReadJsonBody },
): Promise<boolean> {
  if (!url.pathname.startsWith('/codex-api/automations')) {
    return false
  }

  const manager = getAutomationManager(options.appServer)
  void manager.tick()

  try {
    if (req.method === 'GET' && url.pathname === '/codex-api/automations/state') {
      setJson(res, 200, { data: await manager.getState() })
      return true
    }

    if (req.method === 'POST' && url.pathname === '/codex-api/automations') {
      const payload = await options.readJsonBody(req)
      setJson(res, 200, { data: await manager.createAutomation(payload) })
      return true
    }

    const updateId = readPathId(url.pathname, '/codex-api/automations/')
    if (req.method === 'PUT' && updateId && !updateId.includes('/')) {
      const payload = await options.readJsonBody(req)
      setJson(res, 200, { data: await manager.updateAutomation(updateId, payload) })
      return true
    }

    if (req.method === 'DELETE' && updateId && !updateId.includes('/')) {
      await manager.deleteAutomation(updateId)
      setJson(res, 200, { ok: true })
      return true
    }

    const toggleId = readPathId(url.pathname, '/codex-api/automations/', '/toggle')
    if (req.method === 'POST' && toggleId) {
      const payload = asRecord(await options.readJsonBody(req))
      setJson(res, 200, { data: await manager.setAutomationEnabled(toggleId, readBoolean(payload?.enabled, true)) })
      return true
    }

    const runId = readPathId(url.pathname, '/codex-api/automations/', '/run')
    if (req.method === 'POST' && runId) {
      await manager.runAutomationNow(runId)
      setJson(res, 200, { ok: true })
      return true
    }

    const readRunId = readPathId(url.pathname, '/codex-api/automations/runs/', '/read')
    if (req.method === 'POST' && readRunId) {
      setJson(res, 200, { data: await manager.setRunState(readRunId, { unread: false }) })
      return true
    }

    const archiveRunId = readPathId(url.pathname, '/codex-api/automations/runs/', '/archive')
    if (req.method === 'POST' && archiveRunId) {
      const payload = asRecord(await options.readJsonBody(req))
      const archived = readBoolean(payload?.archived, true)
      setJson(res, 200, {
        data: await manager.setRunState(archiveRunId, {
          archived,
          unread: archived ? false : undefined,
        }),
      })
      return true
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Automation request failed'
    setJson(res, 400, { error: message })
    return true
  }

  if (existsSync(getAutomationStorePath())) {
    setJson(res, 404, { error: 'Automation route not found' })
    return true
  }

  setJson(res, 404, { error: 'Automation route not found' })
  return true
}
