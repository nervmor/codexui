import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, mkdir, stat, lstat, readlink, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'

type AppServerLike = {
  rpc(method: string, params: unknown): Promise<unknown>
}

type ReadJsonBody = (req: IncomingMessage) => Promise<unknown>

type SkillRouteContext = {
  appServer: AppServerLike
  readJsonBody: ReadJsonBody
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message.trim().length > 0) {
    return payload.message
  }
  const record = asRecord(payload)
  if (!record) return fallback
  const error = record.error
  if (typeof error === 'string' && error.length > 0) return error
  const nestedError = asRecord(error)
  if (nestedError && typeof nestedError.message === 'string' && nestedError.message.length > 0) {
    return nestedError.message
  }
  return fallback
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

function getSkillsInstallDir(): string {
  return join(getCodexHomeDir(), 'skills')
}

async function runCommand(command: string, args: string[], options: { cwd?: string } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
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
        resolve()
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

async function runCommandWithOutput(command: string, args: string[], options: { cwd?: string } = {}): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
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
        resolve(stdout.trim())
        return
      }
      const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = details.length > 0 ? `: ${details}` : ''
      reject(new Error(`Command failed (${command} ${args.join(' ')})${suffix}`))
    })
  })
}

async function detectUserSkillsDir(appServer: AppServerLike): Promise<string> {
  try {
    const result = (await appServer.rpc('skills/list', {})) as {
      data?: Array<{ skills?: Array<{ scope?: string; path?: string }> }>
    }
    for (const entry of result.data ?? []) {
      for (const skill of entry.skills ?? []) {
        if (skill.scope !== 'user' || !skill.path) continue
        const parts = skill.path.split('/').filter(Boolean)
        if (parts.length < 2) continue
        return `/${parts.slice(0, -2).join('/')}`
      }
    }
  } catch {}
  return getSkillsInstallDir()
}

async function ensureInstalledSkillIsValid(appServer: AppServerLike, skillPath: string): Promise<void> {
  const result = (await appServer.rpc('skills/list', { forceReload: true })) as {
    data?: Array<{ errors?: Array<{ path?: string; message?: string }> }>
  }
  const normalized = skillPath.endsWith('/SKILL.md') ? skillPath : `${skillPath}/SKILL.md`
  for (const entry of result.data ?? []) {
    for (const error of entry.errors ?? []) {
      if (error.path === normalized) {
        throw new Error(error.message || 'Installed skill is invalid')
      }
    }
  }
}

type SkillHubEntry = {
  name: string
  owner: string
  description: string
  displayName: string
  publishedAt: number
  avatarUrl: string
  url: string
  installed: boolean
  path?: string
  scope?: string
  projectName?: string
  enabled?: boolean
}

type InstalledSkillInfo = {
  name: string
  path: string
  enabled: boolean
  scope?: string
  projectName?: string
}
type SyncedSkill = { owner?: string; name: string; enabled: boolean }

type SkillsSyncState = {
  githubToken?: string
  githubUsername?: string
  repoOwner?: string
  repoName?: string
  installedOwners?: Record<string, string>
}

type GithubDeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

type GithubTokenResponse = { access_token?: string; error?: string }

const GITHUB_DEVICE_CLIENT_ID = 'Iv1.b507a08c87ecfe98'
const DEFAULT_SKILLS_SYNC_REPO_NAME = 'codexskills'
const SKILLS_SYNC_MANIFEST_PATH = 'installed-skills.json'
const SYNC_UPSTREAM_SKILLS_OWNER = 'OpenClawAndroid'
const SYNC_UPSTREAM_SKILLS_REPO = 'skills'
let startupSkillsSyncInitialized = false

type StartupSyncStatus = {
  inProgress: boolean
  mode: 'unauthenticated-bootstrap' | 'authenticated-fork-sync' | 'idle'
  branch: string
  lastAction: string
  lastRunAtIso: string
  lastSuccessAtIso: string
  lastError: string
}

const startupSyncStatus: StartupSyncStatus = {
  inProgress: false,
  mode: 'idle',
  branch: getPreferredSyncBranch(),
  lastAction: 'not-started',
  lastRunAtIso: '',
  lastSuccessAtIso: '',
  lastError: '',
}

async function scanInstalledSkillsFromDisk(): Promise<Map<string, InstalledSkillInfo>> {
  const map = new Map<string, InstalledSkillInfo>()
  const skillsDir = getSkillsInstallDir()
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const skillMd = join(skillsDir, entry.name, 'SKILL.md')
      try {
        await stat(skillMd)
        map.set(entry.name, { name: entry.name, path: skillMd, enabled: true, scope: 'user' })
      } catch {}
    }
  } catch {}
  return map
}

function getProjectNameFromCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? cwd
}

async function listInstalledSkills(appServer: AppServerLike): Promise<InstalledSkillInfo[]> {
  const installed: InstalledSkillInfo[] = []
  const seen = new Set<string>()

  try {
    const result = (await appServer.rpc('skills/list', {})) as {
      data?: Array<{
        cwd?: string
        skills?: Array<{
          name?: string
          path?: string
          enabled?: boolean
          scope?: string
        }>
      }>
    }

    for (const entry of result.data ?? []) {
      const projectName = entry.cwd ? getProjectNameFromCwd(entry.cwd) : ''
      for (const skill of entry.skills ?? []) {
        if (!skill.name) continue
        const dedupeKey = skill.path || `${skill.scope ?? ''}:${entry.cwd ?? ''}:${skill.name}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        installed.push({
          name: skill.name,
          path: skill.path ?? '',
          enabled: skill.enabled !== false,
          scope: skill.scope ?? 'user',
          projectName: skill.scope === 'repo' && projectName ? projectName : undefined,
        })
      }
    }
  } catch {}

  return installed
}

function getSkillDirFromPath(skillPath: string): string {
  return skillPath.replace(/[\\/]SKILL\.md$/, '')
}

function getSkillReadmePath(skillPath: string): string {
  return /[\\/]SKILL\.md$/.test(skillPath) ? skillPath : join(skillPath, 'SKILL.md')
}

function readFrontmatterString(frontmatter: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'mi').exec(frontmatter)
  return match?.[1]?.trim() ?? ''
}

async function buildLocalSkillHubEntry(info: InstalledSkillInfo): Promise<SkillHubEntry> {
  let displayName = ''
  let description = ''
  try {
    const raw = await readFile(getSkillReadmePath(info.path), 'utf8')
    const frontmatter = /^---\s*([\s\S]*?)\s*---/.exec(raw)?.[1] ?? ''
    displayName = readFrontmatterString(frontmatter, 'displayName') || readFrontmatterString(frontmatter, 'name')
    description = readFrontmatterString(frontmatter, 'description')
  } catch {}

  return {
    name: info.name,
    owner: info.scope === 'repo' ? 'project' : 'local',
    description,
    displayName,
    publishedAt: 0,
    avatarUrl: '',
    url: '',
    installed: true,
    path: info.path,
    scope: info.scope,
    projectName: info.projectName,
    enabled: info.enabled,
  }
}

function getSkillsSyncStatePath(): string {
  return join(getCodexHomeDir(), 'skills-sync.json')
}

async function readSkillsSyncState(): Promise<SkillsSyncState> {
  try {
    const raw = await readFile(getSkillsSyncStatePath(), 'utf8')
    const parsed = JSON.parse(raw) as SkillsSyncState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeSkillsSyncState(state: SkillsSyncState): Promise<void> {
  await writeFile(getSkillsSyncStatePath(), JSON.stringify(state), 'utf8')
}

async function getGithubJson<T>(url: string, token: string, method = 'GET', body?: unknown): Promise<T> {
  const resp = await fetch(url, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codex-web-local',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`GitHub API ${method} ${url} failed (${resp.status}): ${text}`)
  }
  return await resp.json() as T
}

async function startGithubDeviceLogin(): Promise<GithubDeviceCodeResponse> {
  const resp = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'codex-web-local',
    },
    body: new URLSearchParams({
      client_id: GITHUB_DEVICE_CLIENT_ID,
      scope: 'repo read:user',
    }),
  })
  if (!resp.ok) {
    throw new Error(`GitHub device flow init failed (${resp.status})`)
  }
  return await resp.json() as GithubDeviceCodeResponse
}

async function completeGithubDeviceLogin(deviceCode: string): Promise<{ token: string | null; error: string | null }> {
  const resp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'codex-web-local',
    },
    body: new URLSearchParams({
      client_id: GITHUB_DEVICE_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  })
  if (!resp.ok) {
    throw new Error(`GitHub token exchange failed (${resp.status})`)
  }
  const payload = await resp.json() as GithubTokenResponse
  if (!payload.access_token) return { token: null, error: payload.error || 'unknown_error' }
  return { token: payload.access_token, error: null }
}

function isAndroidLikeRuntime(): boolean {
  if (process.platform === 'android') return true
  if (existsSync('/data/data/com.termux')) return true
  if (process.env.TERMUX_VERSION) return true
  const prefix = process.env.PREFIX?.toLowerCase() ?? ''
  if (prefix.includes('/com.termux/')) return true
  const proot = process.env.PROOT_TMP_DIR?.toLowerCase() ?? ''
  return proot.length > 0
}

function getPreferredSyncBranch(): string {
  return isAndroidLikeRuntime() ? 'android' : 'main'
}

function isUpstreamSkillsRepo(repoOwner: string, repoName: string): boolean {
  return repoOwner.toLowerCase() === SYNC_UPSTREAM_SKILLS_OWNER.toLowerCase()
    && repoName.toLowerCase() === SYNC_UPSTREAM_SKILLS_REPO.toLowerCase()
}

async function resolveGithubUsername(token: string): Promise<string> {
  const user = await getGithubJson<{ login: string }>('https://api.github.com/user', token)
  return user.login
}

async function ensurePrivateForkFromUpstream(token: string, username: string, repoName: string): Promise<void> {
  const repoUrl = `https://api.github.com/repos/${username}/${repoName}`
  let created = false
  const existing = await fetch(repoUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codex-web-local',
    },
  })
  if (existing.ok) {
    const details = await existing.json() as { private?: boolean }
    if (details.private === true) return
    await getGithubJson(repoUrl, token, 'PATCH', { private: true })
    return
  }
  if (existing.status !== 404) {
    throw new Error(`Failed to check personal repo existence (${existing.status})`)
  }

  await getGithubJson(
    'https://api.github.com/user/repos',
    token,
    'POST',
    { name: repoName, private: true, auto_init: false, description: 'Codex skills private mirror sync' },
  )
  created = true

  let ready = false
  for (let i = 0; i < 20; i++) {
    const check = await fetch(repoUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'codex-web-local',
      },
    })
    if (check.ok) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!ready) throw new Error('Private mirror repo was created but is not available yet')
  if (!created) return

  const tmp = await mkdtemp(join(tmpdir(), 'codex-skills-seed-'))
  try {
    const branch = getPreferredSyncBranch()
    await runCommand('git', ['init'], { cwd: tmp })
    await runCommand('git', ['config', 'user.email', 'skills-sync@local'], { cwd: tmp })
    await runCommand('git', ['config', 'user.name', 'Skills Sync'], { cwd: tmp })
    await writeFile(join(tmp, 'README.md'), '# Codex skills sync\n', 'utf8')
    await runCommand('git', ['add', 'README.md'], { cwd: tmp })
    await runCommand('git', ['commit', '-m', 'Initialize skills sync repository'], { cwd: tmp })
    await runCommand('git', ['branch', '-M', branch], { cwd: tmp })
    const privateRemote = toGitHubTokenRemote(username, repoName, token)
    await runCommand('git', ['remote', 'add', 'origin', privateRemote], { cwd: tmp })
    await runCommand('git', ['push', '-u', 'origin', `HEAD:${branch}`], { cwd: tmp })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

async function readRemoteSkillsManifest(token: string, repoOwner: string, repoName: string): Promise<SyncedSkill[]> {
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${SKILLS_SYNC_MANIFEST_PATH}`
  const resp = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codex-web-local',
    },
  })
  if (resp.status === 404) return []
  if (!resp.ok) throw new Error(`Failed to read remote manifest (${resp.status})`)
  const payload = await resp.json() as { content?: string }
  const content = payload.content ? Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8') : '[]'
  const parsed = JSON.parse(content) as unknown
  if (!Array.isArray(parsed)) return []
  const skills: SyncedSkill[] = []
  for (const row of parsed) {
    const item = asRecord(row)
    const owner = typeof item?.owner === 'string' ? item.owner : ''
    const name = typeof item?.name === 'string' ? item.name : ''
    if (!name) continue
    skills.push({ ...(owner ? { owner } : {}), name, enabled: item?.enabled !== false })
  }
  return skills
}

async function writeRemoteSkillsManifest(token: string, repoOwner: string, repoName: string, skills: SyncedSkill[]): Promise<void> {
  const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${SKILLS_SYNC_MANIFEST_PATH}`
  let sha = ''
  const existing = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codex-web-local',
    },
  })
  if (existing.ok) {
    const payload = await existing.json() as { sha?: string }
    sha = payload.sha ?? ''
  }
  const content = Buffer.from(JSON.stringify(skills, null, 2), 'utf8').toString('base64')
  await getGithubJson(url, token, 'PUT', {
    message: 'Update synced skills manifest',
    content,
    ...(sha ? { sha } : {}),
  })
}

function toGitHubTokenRemote(repoOwner: string, repoName: string, token: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${repoOwner}/${repoName}.git`
}

async function ensureSkillsWorkingTreeRepo(repoUrl: string, branch: string): Promise<string> {
  const localDir = getSkillsInstallDir()
  await mkdir(localDir, { recursive: true })
  const gitDir = join(localDir, '.git')
  let hasGitDir = false
  try { hasGitDir = (await stat(gitDir)).isDirectory() } catch { hasGitDir = false }

  if (!hasGitDir) {
    await runCommand('git', ['init'], { cwd: localDir })
    await runCommand('git', ['config', 'user.email', 'skills-sync@local'], { cwd: localDir })
    await runCommand('git', ['config', 'user.name', 'Skills Sync'], { cwd: localDir })
    await runCommand('git', ['add', '-A'], { cwd: localDir })
    try { await runCommand('git', ['commit', '-m', 'Local skills snapshot before sync'], { cwd: localDir }) } catch {}
    await runCommand('git', ['branch', '-M', branch], { cwd: localDir })
    try { await runCommand('git', ['remote', 'add', 'origin', repoUrl], { cwd: localDir }) } catch {
      await runCommand('git', ['remote', 'set-url', 'origin', repoUrl], { cwd: localDir })
    }
    await runCommand('git', ['fetch', 'origin'], { cwd: localDir })
    try {
      await runCommand('git', ['merge', '--allow-unrelated-histories', '--no-edit', `origin/${branch}`], { cwd: localDir })
    } catch {}
    return localDir
  }

  await runCommand('git', ['remote', 'set-url', 'origin', repoUrl], { cwd: localDir })
  await runCommand('git', ['fetch', 'origin'], { cwd: localDir })
  await resolveMergeConflictsByNewerCommit(localDir, branch)
  try {
    await runCommand('git', ['checkout', branch], { cwd: localDir })
  } catch {
    await resolveMergeConflictsByNewerCommit(localDir, branch)
    await runCommand('git', ['checkout', '-B', branch], { cwd: localDir })
  }
  await resolveMergeConflictsByNewerCommit(localDir, branch)
  const localMtimesBeforePull = await snapshotFileMtimes(localDir)
  try { await runCommand('git', ['stash', 'push', '--include-untracked', '-m', 'codex-skills-autostash'], { cwd: localDir }) } catch {}
  let pulledMtimes = new Map<string, number>()
  try {
    await runCommand('git', ['pull', '--no-rebase', 'origin', branch], { cwd: localDir })
    pulledMtimes = await snapshotFileMtimes(localDir)
  } catch {
    await resolveMergeConflictsByNewerCommit(localDir, branch)
    pulledMtimes = await snapshotFileMtimes(localDir)
  }
  try {
    await runCommand('git', ['stash', 'pop'], { cwd: localDir })
  } catch {
    await resolveStashPopConflictsByFileTime(localDir, localMtimesBeforePull, pulledMtimes)
  }
  return localDir
}

async function resolveMergeConflictsByNewerCommit(repoDir: string, branch: string): Promise<void> {
  const unmerged = (await runCommandWithOutput('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoDir }))
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
  if (unmerged.length === 0) return
  for (const path of unmerged) {
    const oursTime = await getCommitTime(repoDir, 'HEAD', path)
    const theirsTime = await getCommitTime(repoDir, `origin/${branch}`, path)
    if (theirsTime > oursTime) {
      await runCommand('git', ['checkout', '--theirs', '--', path], { cwd: repoDir })
    } else {
      await runCommand('git', ['checkout', '--ours', '--', path], { cwd: repoDir })
    }
    await runCommand('git', ['add', '--', path], { cwd: repoDir })
  }
  const mergeHead = (await runCommandWithOutput('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repoDir })).trim()
  if (mergeHead) {
    await runCommand('git', ['commit', '-m', 'Auto-resolve skills merge by newer file'], { cwd: repoDir })
  }
}

async function getCommitTime(repoDir: string, ref: string, path: string): Promise<number> {
  try {
    const output = (await runCommandWithOutput('git', ['log', '-1', '--format=%ct', ref, '--', path], { cwd: repoDir })).trim()
    return output ? Number.parseInt(output, 10) : 0
  } catch {
    return 0
  }
}

async function resolveStashPopConflictsByFileTime(
  repoDir: string,
  localMtimesBeforePull: Map<string, number>,
  pulledMtimes: Map<string, number>,
): Promise<void> {
  const unmerged = (await runCommandWithOutput('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: repoDir }))
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean)
  if (unmerged.length === 0) return
  for (const path of unmerged) {
    const localMtime = localMtimesBeforePull.get(path) ?? 0
    const pulledMtime = pulledMtimes.get(path) ?? 0
    const side = localMtime >= pulledMtime ? '--theirs' : '--ours'
    await runCommand('git', ['checkout', side, '--', path], { cwd: repoDir })
    await runCommand('git', ['add', '--', path], { cwd: repoDir })
  }
  const mergeHead = (await runCommandWithOutput('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: repoDir })).trim()
  if (mergeHead) {
    await runCommand('git', ['commit', '-m', 'Auto-resolve stash-pop conflicts by file time'], { cwd: repoDir })
  }
}

async function snapshotFileMtimes(dir: string): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>()
  await walkFileMtimes(dir, dir, mtimes)
  return mtimes
}

async function walkFileMtimes(rootDir: string, currentDir: string, out: Map<string, number>): Promise<void> {
  let entries: Array<{ name: string | Buffer; isDirectory: () => boolean; isFile: () => boolean }>
  try {
    entries = (await readdir(currentDir, { withFileTypes: true })) as Array<{ name: string | Buffer; isDirectory: () => boolean; isFile: () => boolean }>
  } catch {
    return
  }
  for (const entry of entries) {
    const entryName = String(entry.name)
    if (entryName === '.git') continue
    const absolutePath = join(currentDir, entryName)
    const relativePath = absolutePath.slice(rootDir.length + 1)
    if (entry.isDirectory()) {
      await walkFileMtimes(rootDir, absolutePath, out)
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = await stat(absolutePath)
      out.set(relativePath, info.mtimeMs)
    } catch {}
  }
}

async function syncInstalledSkillsFolderToRepo(
  token: string,
  repoOwner: string,
  repoName: string,
  _installedMap: Map<string, InstalledSkillInfo>,
): Promise<void> {
  const remoteUrl = toGitHubTokenRemote(repoOwner, repoName, token)
  const branch = getPreferredSyncBranch()
  const repoDir = await ensureSkillsWorkingTreeRepo(remoteUrl, branch)
  void _installedMap
  await runCommand('git', ['config', 'user.email', 'skills-sync@local'], { cwd: repoDir })
  await runCommand('git', ['config', 'user.name', 'Skills Sync'], { cwd: repoDir })
  await runCommand('git', ['add', '.'], { cwd: repoDir })
  const status = (await runCommandWithOutput('git', ['status', '--porcelain'], { cwd: repoDir })).trim()
  if (!status) return
  await runCommand('git', ['commit', '-m', 'Sync installed skills folder and manifest'], { cwd: repoDir })
  await runCommand('git', ['push', 'origin', `HEAD:${branch}`], { cwd: repoDir })
}

async function pullInstalledSkillsFolderFromRepo(token: string, repoOwner: string, repoName: string): Promise<void> {
  const remoteUrl = toGitHubTokenRemote(repoOwner, repoName, token)
  const branch = getPreferredSyncBranch()
  await ensureSkillsWorkingTreeRepo(remoteUrl, branch)
}

async function collectLocalSyncedSkills(appServer: AppServerLike): Promise<SyncedSkill[]> {
  const state = await readSkillsSyncState()
  const owners = { ...(state.installedOwners ?? {}) }

  const skills = (await appServer.rpc('skills/list', {})) as { data?: Array<{ skills?: Array<{ name?: string; enabled?: boolean }> }> }
  const seen = new Set<string>()
  const synced: SyncedSkill[] = []
  for (const entry of skills.data ?? []) {
    for (const skill of entry.skills ?? []) {
      const name = typeof skill.name === 'string' ? skill.name : ''
      if (!name || seen.has(name)) continue
      seen.add(name)
      const owner = owners[name] ?? ''
      synced.push({ ...(owner ? { owner } : {}), name, enabled: skill.enabled !== false })
    }
  }
  synced.sort((a, b) => `${a.owner ?? ''}/${a.name}`.localeCompare(`${b.owner ?? ''}/${b.name}`))
  return synced
}

async function autoPushSyncedSkills(appServer: AppServerLike): Promise<void> {
  const state = await readSkillsSyncState()
  if (!state.githubToken || !state.repoOwner || !state.repoName) return
  if (isUpstreamSkillsRepo(state.repoOwner, state.repoName)) {
    throw new Error('Refusing to push to upstream skills repository')
  }
  const local = await collectLocalSyncedSkills(appServer)
  const installedMap = await scanInstalledSkillsFromDisk()
  await writeRemoteSkillsManifest(state.githubToken, state.repoOwner, state.repoName, local)
  await syncInstalledSkillsFolderToRepo(state.githubToken, state.repoOwner, state.repoName, installedMap)
}

async function ensureCodexAgentsSymlinkToSkillsAgents(): Promise<void> {
  const codexHomeDir = getCodexHomeDir()
  const skillsAgentsPath = join(codexHomeDir, 'skills', 'AGENTS.md')
  const codexAgentsPath = join(codexHomeDir, 'AGENTS.md')
  await mkdir(join(codexHomeDir, 'skills'), { recursive: true })
  let copiedFromCodex = false
  try {
    const codexAgentsStat = await lstat(codexAgentsPath)
    if (codexAgentsStat.isFile() || codexAgentsStat.isSymbolicLink()) {
      const content = await readFile(codexAgentsPath, 'utf8')
      await writeFile(skillsAgentsPath, content, 'utf8')
      copiedFromCodex = true
    } else {
      await rm(codexAgentsPath, { force: true, recursive: true })
    }
  } catch {}
  if (!copiedFromCodex) {
    try {
      const skillsAgentsStat = await stat(skillsAgentsPath)
      if (!skillsAgentsStat.isFile()) {
        await rm(skillsAgentsPath, { force: true, recursive: true })
        await writeFile(skillsAgentsPath, '', 'utf8')
      }
    } catch {
      await writeFile(skillsAgentsPath, '', 'utf8')
    }
  }
  const relativeTarget = join('skills', 'AGENTS.md')
  try {
    const current = await lstat(codexAgentsPath)
    if (current.isSymbolicLink()) {
      const existingTarget = await readlink(codexAgentsPath)
      if (existingTarget === relativeTarget) return
    }
    await rm(codexAgentsPath, { force: true, recursive: true })
  } catch {}
  await symlink(relativeTarget, codexAgentsPath)
}

export async function initializeSkillsSyncOnStartup(appServer: AppServerLike): Promise<void> {
  if (startupSkillsSyncInitialized) return
  startupSkillsSyncInitialized = true
  startupSyncStatus.inProgress = true
  startupSyncStatus.lastRunAtIso = new Date().toISOString()
  startupSyncStatus.lastError = ''
  startupSyncStatus.branch = getPreferredSyncBranch()
  try {
    const state = await readSkillsSyncState()
    if (!state.githubToken) {
      await ensureCodexAgentsSymlinkToSkillsAgents()
      startupSyncStatus.mode = 'idle'
      startupSyncStatus.lastAction = 'skip-upstream-local-only'
      try { await appServer.rpc('skills/list', { forceReload: true }) } catch {}
      startupSyncStatus.lastSuccessAtIso = new Date().toISOString()
      return
    }
    startupSyncStatus.mode = 'authenticated-fork-sync'
    startupSyncStatus.lastAction = 'ensure-private-fork'
    const username = state.githubUsername || await resolveGithubUsername(state.githubToken)
    const repoName = DEFAULT_SKILLS_SYNC_REPO_NAME
    await ensurePrivateForkFromUpstream(state.githubToken, username, repoName)
    await writeSkillsSyncState({ ...state, githubUsername: username, repoOwner: username, repoName })
    startupSyncStatus.lastAction = 'pull-private-fork'
    await pullInstalledSkillsFolderFromRepo(state.githubToken, username, repoName)
    try { await appServer.rpc('skills/list', { forceReload: true }) } catch {}
    startupSyncStatus.lastAction = 'push-private-fork'
    await autoPushSyncedSkills(appServer)
    startupSyncStatus.lastSuccessAtIso = new Date().toISOString()
    startupSyncStatus.lastAction = 'startup-sync-complete'
  } catch (error) {
    startupSyncStatus.lastError = getErrorMessage(error, 'startup-sync-failed')
    startupSyncStatus.lastAction = 'startup-sync-failed'
  } finally {
    startupSyncStatus.inProgress = false
  }
}

async function finalizeGithubLoginAndSync(token: string, username: string, appServer: AppServerLike): Promise<void> {
  const repoName = DEFAULT_SKILLS_SYNC_REPO_NAME
  await ensurePrivateForkFromUpstream(token, username, repoName)
  const current = await readSkillsSyncState()
  await writeSkillsSyncState({ ...current, githubToken: token, githubUsername: username, repoOwner: username, repoName })
  await pullInstalledSkillsFolderFromRepo(token, username, repoName)
  try { await appServer.rpc('skills/list', { forceReload: true }) } catch {}
  await autoPushSyncedSkills(appServer)
}

export async function handleSkillsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  context: SkillRouteContext,
): Promise<boolean> {
  const { appServer, readJsonBody } = context
  if (req.method === 'GET' && url.pathname === '/codex-api/skills-hub') {
    try {
      const q = url.searchParams.get('q') || ''
      const installedFromAppServer = await listInstalledSkills(appServer)
      const diskInstalledMap = await scanInstalledSkillsFromDisk()
      const installed = installedFromAppServer.length > 0
        ? [...installedFromAppServer]
        : [...diskInstalledMap.values()]
      let installedEntries = await Promise.all(installed.map((info) => buildLocalSkillHubEntry(info)))
      installedEntries.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name))
      const query = q.toLowerCase().trim()
      if (query) {
        installedEntries = installedEntries.filter((skill) =>
          skill.name.toLowerCase().includes(query) ||
          skill.owner.toLowerCase().includes(query) ||
          (skill.displayName || '').toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query),
        )
      }

      setJson(res, 200, { data: [], installed: installedEntries, total: installedEntries.length })
    } catch (error) {
      setJson(res, 500, { error: getErrorMessage(error, 'Failed to load local skills') })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/codex-api/skills-sync/status') {
    const state = await readSkillsSyncState()
    setJson(res, 200, {
      data: {
        loggedIn: Boolean(state.githubToken),
        githubUsername: state.githubUsername ?? '',
        repoOwner: state.repoOwner ?? '',
        repoName: state.repoName ?? '',
        configured: Boolean(state.githubToken && state.repoOwner && state.repoName),
        startup: {
          inProgress: startupSyncStatus.inProgress,
          mode: startupSyncStatus.mode,
          branch: startupSyncStatus.branch,
          lastAction: startupSyncStatus.lastAction,
          lastRunAtIso: startupSyncStatus.lastRunAtIso,
          lastSuccessAtIso: startupSyncStatus.lastSuccessAtIso,
          lastError: startupSyncStatus.lastError,
        },
      },
    })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/skills-sync/github/start-login') {
    try {
      const started = await startGithubDeviceLogin()
      setJson(res, 200, { data: started })
    } catch (error) {
      setJson(res, 502, { error: getErrorMessage(error, 'Failed to start GitHub login') })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/skills-sync/github/token-login') {
    try {
      const payload = asRecord(await readJsonBody(req))
      const token = typeof payload?.token === 'string' ? payload.token.trim() : ''
      if (!token) {
        setJson(res, 400, { error: 'Missing GitHub token' })
        return true
      }
      const username = await resolveGithubUsername(token)
      await finalizeGithubLoginAndSync(token, username, appServer)
      setJson(res, 200, { ok: true, data: { githubUsername: username } })
    } catch (error) {
      setJson(res, 502, { error: getErrorMessage(error, 'Failed to login with GitHub token') })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/skills-sync/github/logout') {
    try {
      const state = await readSkillsSyncState()
      await writeSkillsSyncState({
        ...state,
        githubToken: undefined,
        githubUsername: undefined,
        repoOwner: undefined,
        repoName: undefined,
      })
      setJson(res, 200, { ok: true })
    } catch (error) {
      setJson(res, 500, { error: getErrorMessage(error, 'Failed to logout GitHub') })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/skills-sync/github/complete-login') {
    try {
      const payload = asRecord(await readJsonBody(req))
      const deviceCode = typeof payload?.deviceCode === 'string' ? payload.deviceCode : ''
      if (!deviceCode) {
        setJson(res, 400, { error: 'Missing deviceCode' })
        return true
      }
      const result = await completeGithubDeviceLogin(deviceCode)
      if (!result.token) {
        setJson(res, 200, { ok: false, pending: result.error === 'authorization_pending', error: result.error || 'login_failed' })
        return true
      }
      const token = result.token
      const username = await resolveGithubUsername(token)
      await finalizeGithubLoginAndSync(token, username, appServer)
      setJson(res, 200, { ok: true, data: { githubUsername: username } })
    } catch (error) {
      setJson(res, 502, { error: getErrorMessage(error, 'Failed to complete GitHub login') })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/skills-sync/push') {
    try {
      const state = await readSkillsSyncState()
      if (!state.githubToken || !state.repoOwner || !state.repoName) {
        setJson(res, 400, { error: 'Skills sync is not configured yet' })
        return true
      }
      if (isUpstreamSkillsRepo(state.repoOwner, state.repoName)) {
        setJson(res, 400, { error: 'Refusing to push to upstream repository' })
        return true
      }
      const local = await collectLocalSyncedSkills(appServer)
      const installedMap = await scanInstalledSkillsFromDisk()
      await writeRemoteSkillsManifest(state.githubToken, state.repoOwner, state.repoName, local)
      await syncInstalledSkillsFolderToRepo(state.githubToken, state.repoOwner, state.repoName, installedMap)
      setJson(res, 200, { ok: true, data: { synced: local.length } })
    } catch (error) {
      setJson(res, 502, { error: getErrorMessage(error, 'Failed to push synced skills') })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/skills-sync/pull') {
    try {
      const state = await readSkillsSyncState()
      if (!state.githubToken || !state.repoOwner || !state.repoName) {
        try { await appServer.rpc('skills/list', { forceReload: true }) } catch {}
        setJson(res, 200, { ok: true, data: { synced: 0, source: 'local' } })
        return true
      }
      const remote = await readRemoteSkillsManifest(state.githubToken, state.repoOwner, state.repoName)
      await pullInstalledSkillsFolderFromRepo(state.githubToken, state.repoOwner, state.repoName)
      const localSkills = await scanInstalledSkillsFromDisk()
      const localDir = await detectUserSkillsDir(appServer)
      for (const skill of remote) {
        if (!localSkills.has(skill.name)) continue
        const skillPath = join(localDir, skill.name)
        await appServer.rpc('skills/config/write', { path: skillPath, enabled: skill.enabled })
      }
      const nextOwners: Record<string, string> = {}
      for (const item of remote) {
        if (item.owner) nextOwners[item.name] = item.owner
      }
      await writeSkillsSyncState({ ...state, installedOwners: nextOwners })
      try { await appServer.rpc('skills/list', { forceReload: true }) } catch {}
      setJson(res, 200, { ok: true, data: { synced: remote.length } })
    } catch (error) {
      setJson(res, 502, { error: getErrorMessage(error, 'Failed to pull synced skills') })
    }
    return true
  }

  if (req.method === 'GET' && url.pathname === '/codex-api/skills-hub/readme') {
    try {
      const path = url.searchParams.get('path') || ''
      if (!path) {
        setJson(res, 400, { error: 'Missing path' })
        return true
      }
      const content = await readFile(getSkillReadmePath(path), 'utf8')
      setJson(res, 200, { content })
    } catch (error) {
      setJson(res, 404, { error: getErrorMessage(error, 'Failed to read local SKILL.md') })
    }
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/skills-hub/install') {
    setJson(res, 410, { error: 'Remote skill installation is disabled' })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/codex-api/skills-hub/uninstall') {
    try {
      const payload = asRecord(await readJsonBody(req))
      const name = typeof payload?.name === 'string' ? payload.name : ''
      const path = typeof payload?.path === 'string' ? payload.path : ''
      const target = path ? getSkillDirFromPath(path) : (name ? join(getSkillsInstallDir(), name) : '')
      if (!target) {
        setJson(res, 400, { error: 'Missing name or path' })
        return true
      }
      await rm(target, { recursive: true, force: true })
      if (name) {
        const syncState = await readSkillsSyncState()
        const nextOwners = { ...(syncState.installedOwners ?? {}) }
        delete nextOwners[name]
        await writeSkillsSyncState({ ...syncState, installedOwners: nextOwners })
      }
      await autoPushSyncedSkills(appServer)
      try { await appServer.rpc('skills/list', { forceReload: true }) } catch {}
      setJson(res, 200, { ok: true, deletedPath: target })
    } catch (error) {
      setJson(res, 502, { error: getErrorMessage(error, 'Failed to uninstall skill') })
    }
    return true
  }

  return false
}
