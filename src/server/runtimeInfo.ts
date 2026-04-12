import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function getUserNpmPrefix(): string {
  return join(homedir(), '.npm-global')
}

function canRun(command: string, args: string[] = []): boolean {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return result.status === 0
}

function resolveCodexCommand(): string | null {
  if (canRun('codex', ['--version'])) {
    return 'codex'
  }

  const userCandidate = join(getUserNpmPrefix(), 'bin', 'codex')
  if (existsSync(userCandidate) && canRun(userCandidate, ['--version'])) {
    return userCandidate
  }

  const prefix = process.env.PREFIX?.trim()
  if (!prefix) {
    return null
  }

  const candidate = join(prefix, 'bin', 'codex')
  if (existsSync(candidate) && canRun(candidate, ['--version'])) {
    return candidate
  }

  return null
}

function extractCliVersion(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return 'unknown'

  const semverMatch = trimmed.match(/\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)
  if (semverMatch?.[1]) {
    return semverMatch[1]
  }

  const tokens = trimmed.split(/\s+/)
  return tokens[tokens.length - 1] ?? 'unknown'
}

export function readCodexCliVersion(): string {
  const command = resolveCodexCommand()
  if (!command) {
    return 'unknown'
  }

  const result = spawnSync(command, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) {
    return 'unknown'
  }

  return extractCliVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
}
