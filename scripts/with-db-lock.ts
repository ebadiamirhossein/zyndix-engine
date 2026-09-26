/**
 * scripts/with-db-lock.ts — run a DB test suite while holding a machine-wide lock.
 *
 *   pnpm exec tsx scripts/with-db-lock.ts pnpm -s test:classify
 *
 * DB suites assert BEFORE = AFTER on global row counts, so two suites running
 * at once (e.g. parallel agents in Wave 1) break each other. The lock is an
 * atomic mkdir under the OS temp dir; a lock older than 15 minutes is treated
 * as abandoned and broken. Waits up to 30 minutes, then gives up.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "zyndix-engine-db-test.lock");
const STALE_MS = 15 * 60_000;
const MAX_WAIT_MS = 30 * 60_000;

function tryAcquire(): boolean {
  try {
    mkdirSync(LOCK);
    writeFileSync(join(LOCK, "owner"), `${process.pid} ${new Date().toISOString()} ${process.argv.slice(2).join(" ")}`);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) {
        console.error(`[db-lock] breaking stale lock: ${safeOwner()}`);
        rmSync(LOCK, { recursive: true, force: true });
      }
    } catch {
      // raced with the owner releasing it; retry
    }
    return false;
  }
}

function safeOwner(): string {
  try {
    return readFileSync(join(LOCK, "owner"), "utf-8");
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const cmd = process.argv.slice(2);
  if (cmd.length === 0) throw new Error("usage: tsx scripts/with-db-lock.ts <command…>");
  const started = Date.now();
  let announced = false;
  while (!tryAcquire()) {
    if (!announced) {
      console.error(`[db-lock] waiting for: ${safeOwner()}`);
      announced = true;
    }
    if (Date.now() - started > MAX_WAIT_MS) throw new Error("[db-lock] gave up after 30 minutes");
    await new Promise((r) => setTimeout(r, 3_000));
  }
  const release = () => rmSync(LOCK, { recursive: true, force: true });
  process.on("SIGINT", () => {
    release();
    process.exit(130);
  });
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
  child.on("exit", (code) => {
    release();
    process.exit(code ?? 1);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
