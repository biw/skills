#!/usr/bin/env node
import net from "node:net";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const protocol = "local-browser-v1";
const runtime = process.env.LOCAL_BROWSER_RUNTIME_DIR || join(homedir(), ".cache", "local-browser");
const port = Number(process.env.LOCAL_BROWSER_PORT || 43100 + ((process.getuid?.() || 0) % 10000));
const idleMs = Number(process.env.LOCAL_BROWSER_IDLE_MS || 300000);
const limit = 2 * 1024 * 1024;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
if (
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535 ||
  !Number.isFinite(idleMs) ||
  idleMs < 100
) {
  throw new Error("Invalid local browser port or idle timeout");
}

async function token() {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  const path = join(runtime, "token");
  try {
    await writeFile(path, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await readFile(path, "utf8");
    if (/^[a-f0-9]{64}$/.test(value)) return value;
    await delay(20);
  }
  throw new Error(`Invalid runtime token at ${path}`);
}

async function request(message) {
  const secret = await token();
  return new Promise((done, fail) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout((message.timeoutMs || 2000) + 15000, () =>
      socket.destroy(new Error("Browser helper did not respond")),
    );
    socket.on("connect", () =>
      socket.write(JSON.stringify({ ...message, protocol, token: secret }) + "\n"),
    );
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > limit * 3) socket.destroy(new Error("Browser response too large"));
    });
    socket.on("error", fail);
    socket.on("end", () => {
      try {
        const result = JSON.parse(response);
        if (result.protocol !== protocol)
          throw new Error("Port is occupied by a different service");
        done(result);
      } catch (error) {
        fail(error);
      }
    });
    // Normal disconnect and process termination cancel only this request.
  });
}

async function serve() {
  const secret = await token();
  const jobs = new Map();
  let enginePromise,
    engine,
    mode,
    idleTimer,
    stopping = false;
  const server = net.createServer((socket) => {
    let input = "",
      received = false;
    socket.on("error", () => {});
    socket.setTimeout(5000, () => {
      if (!received) socket.destroy();
    });
    socket.on("data", (chunk) => {
      if (received) return;
      input += chunk;
      if (input.length > limit) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      received = true;
      socket.setTimeout(0);
      void handle(socket, input.slice(0, input.indexOf("\n")));
    });
  });
  function reply(socket, value) {
    if (!socket.destroyed) socket.end(JSON.stringify({ protocol, ...value }) + "\n");
  }
  function armIdle() {
    clearTimeout(idleTimer);
    if (!jobs.size && !stopping) idleTimer = setTimeout(() => void shutdown(), idleMs);
  }
  async function shutdown(stopSocket) {
    if (stopping) return;
    stopping = true;
    clearTimeout(idleTimer);
    server.close();
    for (const job of jobs.values()) job.child?.kill("SIGKILL");
    try {
      if (enginePromise) await enginePromise;
      await engine?.close();
    } finally {
      if (stopSocket && !stopSocket.destroyed) {
        await new Promise((done) =>
          stopSocket.end(JSON.stringify({ protocol, stopped: true }) + "\n", done),
        );
      }
      process.exit(0);
    }
  }
  async function getEngine(headed) {
    if (enginePromise && mode !== headed)
      throw new Error("Shared browser display mode differs; finish tasks, run stop, then retry");
    if (!enginePromise) {
      mode = headed;
      enginePromise = (async () => {
        const { chromium } = await import("playwright");
        engine = await chromium.launchServer({ headless: !headed, host: "127.0.0.1" });
        engine.on("close", () => {
          for (const job of jobs.values()) job.child?.kill("SIGKILL");
          engine = enginePromise = undefined;
        });
        return engine;
      })().catch((error) => {
        enginePromise = undefined;
        throw error;
      });
    }
    return enginePromise;
  }
  async function handle(socket, raw) {
    let message;
    try {
      message = JSON.parse(raw);
      if (message.protocol !== protocol || message.token !== secret)
        throw new Error("Browser helper authentication or protocol mismatch");
      if (stopping) throw new Error("Browser helper is stopping; retry shortly");
      if (message.command === "status") {
        reply(socket, {
          running: true,
          managerPid: process.pid,
          browserPid: engine?.process().pid || null,
          mode: enginePromise ? (mode ? "headed" : "headless") : null,
          tasks: [...jobs].map(([id, job]) => ({ id, workerPid: job.child?.pid || null })),
          idleMs,
        });
        return;
      }
      if (message.command === "stop") {
        if (jobs.size) throw new Error("Browser has active tasks; stop refused");
        await shutdown(socket);
        return;
      }
      if (
        message.command !== "run" ||
        typeof message.code !== "string" ||
        !message.code.trim() ||
        !Number.isInteger(message.timeoutMs) ||
        message.timeoutMs < 100 ||
        message.timeoutMs > 600000 ||
        typeof message.cwd !== "string" ||
        !message.cwd.startsWith("/")
      )
        throw new Error("Invalid browser task");
      clearTimeout(idleTimer);
      const id = randomUUID();
      const job = { child: null, cancelled: false };
      jobs.set(id, job);
      const cancel = () => {
        job.cancelled = true;
        job.child?.kill("SIGKILL");
      };
      socket.on("close", cancel);
      let timer;
      try {
        const browser = await getEngine(Boolean(message.headed));
        if (job.cancelled) return;
        const child = (job.child = spawn(process.execPath, [self, "__worker"], {
          stdio: ["pipe", "pipe", "pipe"],
          cwd: message.cwd,
        }));
        let stdout = "",
          stderr = "",
          failure;
        const collect = (target) => (chunk) => {
          if (target === "out") stdout += chunk;
          else stderr += chunk;
          if (stdout.length + stderr.length > limit) {
            failure = "Browser task output exceeds 2 MiB";
            child.kill("SIGKILL");
          }
        };
        child.stdout.on("data", collect("out"));
        child.stderr.on("data", collect("err"));
        child.stdin.on("error", () => {});
        timer = setTimeout(() => {
          failure = "Browser task timed out";
          child.kill("SIGKILL");
        }, message.timeoutMs);
        const completion = new Promise((done, fail) => {
          child.on("error", fail);
          child.on("close", (code) => done(code));
        });
        child.stdin.end(JSON.stringify({ ...message, endpoint: browser.wsEndpoint() }));
        const exitCode = await completion;
        reply(socket, {
          taskId: id,
          browserPid: browser.process().pid,
          stdout: stdout.slice(0, limit),
          stderr: stderr.slice(0, limit),
          exitCode: exitCode ?? 1,
          error: failure,
        });
      } finally {
        clearTimeout(timer);
        socket.off("close", cancel);
        jobs.delete(id);
        armIdle();
      }
    } catch (error) {
      reply(socket, { exitCode: 1, error: error.message });
    }
  }
  server.on("error", (error) => {
    // Binding precedes browser launch: simultaneous starters cannot launch twice.
    if (error.code === "EADDRINUSE") process.exit(0);
    console.error(error.message);
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", armIdle);
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGHUP", () => void shutdown());
}

async function worker() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const message = JSON.parse(raw);
  const { chromium } = await import("playwright");
  const browser = await chromium.connect(message.endpoint);
  let disconnecting = false;
  browser.on("disconnected", () => {
    if (!disconnecting) process.exit(1);
  });
  try {
    const context = await browser.newContext({ storageState: message.storageState || undefined });
    try {
      context.setDefaultTimeout(15000);
      context.setDefaultNavigationTimeout(30000);
      const page = await context.newPage();
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const result = await new AsyncFunction("page", "context", message.code)(page, context);
      if (result !== undefined) console.log(JSON.stringify(result));
    } finally {
      await context.close();
    }
  } finally {
    // For connect(), close disconnects this client and its contexts, not the server.
    disconnecting = true;
    await browser.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "__serve") return serve();
  if (command === "__worker") return worker();
  if (!["run", "status", "stop"].includes(command)) {
    console.log(
      "Usage: browser.mjs run [--headed] [--timeout-ms N] [--storage-state PATH] < task.js\n       browser.mjs status | stop",
    );
    if (command && command !== "--help") process.exitCode = 1;
    return;
  }
  const message = { command, cwd: process.cwd(), timeoutMs: 120000, headed: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--headed") message.headed = true;
    else if (args[i] === "--timeout-ms" && args[i + 1]) message.timeoutMs = Number(args[++i]);
    else if (args[i] === "--storage-state" && args[i + 1])
      message.storageState = resolve(args[++i]);
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (command === "run") {
    if (
      !Number.isInteger(message.timeoutMs) ||
      message.timeoutMs < 100 ||
      message.timeoutMs > 600000
    )
      throw new Error("Task timeout must be 100–600000 ms");
    let code = "";
    for await (const chunk of process.stdin) {
      code += chunk;
      if (code.length > limit / 2) throw new Error("Task script too large");
    }
    if (!code.trim()) throw new Error("Supply a task script on stdin");
    message.code = code;
  }
  let result;
  try {
    result = await request(message);
  } catch (error) {
    if (error.code !== "ECONNREFUSED") throw error;
    if (command !== "run") {
      console.log(JSON.stringify({ running: false }));
      return;
    }
    const log = await open(join(runtime, "manager.log"), "a", 0o600);
    const daemon = spawn(process.execPath, [self, "__serve"], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    daemon.on("error", () => {});
    daemon.unref();
    await log.close();
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        result = await request(message);
        break;
      } catch (retry) {
        if (retry.code !== "ECONNREFUSED") throw retry;
        await delay(50);
      }
    }
    if (!result)
      throw new Error(`Browser helper failed to start; see ${join(runtime, "manager.log")}`);
  }
  if (command === "run") {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.error(result.error);
    process.exitCode = result.exitCode || 0;
  } else {
    console.log(JSON.stringify(result));
    if (result.error) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
