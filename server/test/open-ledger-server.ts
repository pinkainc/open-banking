// A real open-ledger server for the open-ledger ledger tests (decision 927): started once
// per test process from its repo (OPEN_LEDGER_DIR, default ../../minka/open-ledger from the
// repo root), memory store, a free port; stopped when the process exits.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const OPEN_LEDGER_DIR = resolve(process.env.OPEN_LEDGER_DIR ?? join(ROOT, '../../minka/open-ledger'))

let started: Promise<string> | undefined

/** The base URL (…/api/v2) of the open-ledger server this process uses. */
export const openLedgerUrl = () => (started ??= start())

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => ok(port))
    })
  })
}

async function start(): Promise<string> {
  if (!existsSync(join(OPEN_LEDGER_DIR, 'node_modules'))) throw new Error(`open-ledger not found at ${OPEN_LEDGER_DIR} (or npm install not run there)`)
  const port = await freePort()
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) }
  for (const k of ['DATABASE_URL', 'OPEN_LEDGER_LOG', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[k]
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'server/src/main.ts'], { cwd: OPEN_LEDGER_DIR, env, stdio: ['ignore', 'ignore', 'pipe'] })
  process.on('exit', () => child.kill('SIGTERM'))
  let log = ''
  await new Promise<void>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`open-ledger did not start in 30 s:\n${log}`)), 30_000)
    child.stderr!.on('data', (b: Buffer) => {
      log += b.toString()
      if (log.includes(`open-ledger on :${port}`)) { clearTimeout(timer); ok() }
    })
    child.once('exit', (code) => { clearTimeout(timer); fail(new Error(`open-ledger exited (${code}):\n${log}`)) })
  })
  // The server must not keep a finished test process alive.
  child.stderr!.removeAllListeners('data').resume()
  ;(child.stderr as any).unref?.()
  child.unref()
  return `http://127.0.0.1:${port}/api/v2`
}
