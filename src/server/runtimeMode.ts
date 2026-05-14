export type CodexuiRunMode = 'prod' | 'debug'

const DEBUG_MODE_VALUES = new Set(['debug', 'dev', 'development', 'read-only', 'readonly'])

export function readCodexuiRunMode(env: NodeJS.ProcessEnv = process.env): CodexuiRunMode {
  const value = env.CODEXUI_RUN_MODE?.trim().toLowerCase()
  return value && DEBUG_MODE_VALUES.has(value) ? 'debug' : 'prod'
}

export function isCodexuiDebugMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return readCodexuiRunMode(env) === 'debug'
}
