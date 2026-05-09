import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const schemasDir = path.join(rootDir, 'documentation', 'app-server-schemas')
const writeMode = process.argv.includes('--write')

async function runCodex(args) {
  await new Promise((resolve, reject) => {
    const child = spawn('codex', args, {
      cwd: rootDir,
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `codex ${args.join(' ')} exited with ${code}`))
    })
  })
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, base))
      continue
    }
    if (entry.isFile()) {
      files.push(path.relative(base, fullPath).split(path.sep).join('/'))
    }
  }
  return files.sort((first, second) => first.localeCompare(second))
}

async function readTextIfExists(filePath) {
  if (!await pathExists(filePath)) return null
  return await readFile(filePath, 'utf8')
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item))
  if (!value || typeof value !== 'object') return value
  const sorted = {}
  for (const key of Object.keys(value).sort((first, second) => first.localeCompare(second))) {
    sorted[key] = sortJsonValue(value[key])
  }
  return sorted
}

async function readComparableText(filePath, relativePath) {
  const text = await readTextIfExists(filePath)
  if (text === null || !relativePath.endsWith('.json')) return text
  return `${JSON.stringify(sortJsonValue(JSON.parse(text)), null, 2)}\n`
}

async function compareDirs(expectedDir, actualDir) {
  const expectedFiles = await listFiles(expectedDir)
  const actualFiles = await listFiles(actualDir)
  const allFiles = Array.from(new Set([...expectedFiles, ...actualFiles])).sort((first, second) => first.localeCompare(second))
  const diffs = []

  for (const relativePath of allFiles) {
    const expectedExists = expectedFiles.includes(relativePath)
    const actualExists = actualFiles.includes(relativePath)
    if (!expectedExists) {
      diffs.push(`missing in generated output: ${relativePath}`)
      continue
    }
    if (!actualExists) {
      diffs.push(`missing in documentation: ${relativePath}`)
      continue
    }

    const [expected, actual] = await Promise.all([
      readComparableText(path.join(expectedDir, relativePath), relativePath),
      readComparableText(path.join(actualDir, relativePath), relativePath),
    ])
    if (expected !== actual) {
      diffs.push(`changed: ${relativePath}`)
    }
  }

  return diffs
}

async function generateSchemas(outDir) {
  const jsonDir = path.join(outDir, 'json')
  const typescriptDir = path.join(outDir, 'typescript')
  await runCodex(['app-server', 'generate-json-schema', '--out', jsonDir])
  await runCodex(['app-server', 'generate-ts', '--out', typescriptDir])
}

async function replaceDir(sourceDir, targetDir) {
  await rm(targetDir, { recursive: true, force: true })
  await cp(sourceDir, targetDir, { recursive: true })
}

const tempRoot = await mkdtemp(path.join(tmpdir(), 'codexui-app-server-schemas-'))

try {
  await generateSchemas(tempRoot)

  if (writeMode) {
    await replaceDir(path.join(tempRoot, 'json'), path.join(schemasDir, 'json'))
    await replaceDir(path.join(tempRoot, 'typescript'), path.join(schemasDir, 'typescript'))
    console.log('Updated app-server schemas from the installed Codex CLI.')
  } else {
    const [jsonDiffs, tsDiffs] = await Promise.all([
      compareDirs(path.join(tempRoot, 'json'), path.join(schemasDir, 'json')),
      compareDirs(path.join(tempRoot, 'typescript'), path.join(schemasDir, 'typescript')),
    ])
    const diffs = [
      ...jsonDiffs.map((line) => `json/${line}`),
      ...tsDiffs.map((line) => `typescript/${line}`),
    ]

    if (diffs.length > 0) {
      console.error('App-server schema drift detected. Run `npm run appserver:schema:update`.')
      for (const diff of diffs.slice(0, 80)) {
        console.error(`- ${diff}`)
      }
      if (diffs.length > 80) {
        console.error(`- ... ${diffs.length - 80} more`)
      }
      process.exitCode = 1
    } else {
      console.log('App-server schemas are up to date.')
    }
  }
} finally {
  await rm(tempRoot, { recursive: true, force: true })
}
