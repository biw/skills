import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const skill = new URL("../../skills/local-browser/", import.meta.url);
const helper = fileURLToPath(new URL("scripts/browser.mjs", skill));
const require = createRequire(new URL("package.json", skill));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function invoke(env, args, code = "") {
  const child = spawn(process.execPath, [helper, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", () => {});
  child.stdin.end(code);
  return {
    child,
    done: new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
    }),
  };
}

async function poll(fn, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(30);
  }
  throw new Error("Timed out waiting for observable browser state");
}

test(
  "shared browser lifecycle, isolation, cancellation, and deadlines",
  { timeout: 45000, skip: process.env.LOCAL_BROWSER_INTEGRATION !== "1" },
  async (t) => {
    const { chromium } = require("playwright");
    const runtime = await mkdtemp(join(tmpdir(), "local-browser-test-"));
    const reserve = net.createServer();
    await new Promise((resolve) => reserve.listen(0, "127.0.0.1", resolve));
    const port = reserve.address().port;
    await new Promise((resolve) => reserve.close(resolve));
    const env = {
      ...process.env,
      LOCAL_BROWSER_RUNTIME_DIR: runtime,
      LOCAL_BROWSER_PORT: String(port),
      LOCAL_BROWSER_IDLE_MS: "1500",
    };
    const web = http.createServer((_req, res) =>
      res.end("<title>Local browser test</title><button>Ready</button>"),
    );
    await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${web.address().port}`;
    const tasks = [];
    let managerPid, browserPid;
    t.after(async () => {
      for (const task of tasks) if (task.child.exitCode === null) task.child.kill("SIGKILL");
      await Promise.all(tasks.map((task) => task.done));
      await invoke(env, ["stop"]).done;
      if (managerPid && alive(managerPid)) {
        process.kill(managerPid, "SIGTERM");
        await poll(() => !alive(managerPid));
      }
      await new Promise((resolve) => web.close(resolve));
      await rm(runtime, { recursive: true, force: true });
    });
    const run = (code, args = []) => {
      const task = invoke(env, ["run", ...args], code);
      tasks.push(task);
      return task;
    };
    const status = async () => {
      const result = await invoke(env, ["status"]).done;
      assert.equal(result.exitCode, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.equal((await status()).running, false, "status must not launch a manager or browser");
    assert.equal(JSON.parse((await invoke(env, ["stop"]).done).stdout).running, false);

    // Deliberately race both initial launches; they must report one browser PID.
    const codeFor = (owner) => `
    await page.goto(${JSON.stringify(url)});
    await page.evaluate(value => localStorage.setItem('owner', value), ${JSON.stringify(owner)});
    await context.addCookies([{ name: 'owner', value: ${JSON.stringify(owner)}, url: ${JSON.stringify(url)} }]);
    await new Promise(done => setTimeout(done, 1800));
    return { owner: await page.evaluate(() => localStorage.getItem('owner')), cookie: (await context.cookies())[0].value };
  `;
    const a = run(codeFor("a")),
      b = run(codeFor("b"));
    const concurrent = await poll(async () => {
      const s = await status();
      return s.browserPid && s.tasks.length === 2 ? s : false;
    });
    managerPid = concurrent.managerPid;
    browserPid = concurrent.browserPid;
    const refuse = await invoke(env, ["stop"]).done;
    assert.equal(refuse.exitCode, 1);
    assert.match(refuse.stdout, /active tasks/);
    const modeMismatch = await run("return true;", ["--headed"]).done;
    assert.equal(modeMismatch.exitCode, 1);
    assert.match(modeMismatch.stderr, /display mode differs/);
    const [ar, br] = await Promise.all([a.done, b.done]);
    assert.equal(ar.exitCode, 0, ar.stderr);
    assert.equal(br.exitCode, 0, br.stderr);
    assert.deepEqual(JSON.parse(ar.stdout), { owner: "a", cookie: "a" });
    assert.deepEqual(JSON.parse(br.stdout), { owner: "b", cookie: "b" });
    assert.equal((await status()).browserPid, browserPid);
    assert.equal((await status()).tasks.length, 0);

    const survivor = run(
      `await page.goto(${JSON.stringify(url)}); await new Promise(done => setTimeout(done, 2500)); return await page.title();`,
    );
    const abandoned = run(
      'await page.setContent("abandoned"); await new Promise(done => setTimeout(done, 30000));',
    );
    await poll(async () => (await status()).tasks.length === 2);
    abandoned.child.kill("SIGKILL");
    await abandoned.done;
    await poll(async () => (await status()).tasks.length === 1);
    const failed = await run(
      'await page.setContent("failed"); throw new Error("expected-task-failure");',
    ).done;
    assert.equal(failed.exitCode, 1);
    assert.match(failed.stderr, /expected-task-failure/);
    // A synchronous infinite loop cannot prevent the manager enforcing the deadline.
    const timedOut = await run("while (true) {}", ["--timeout-ms", "200"]).done;
    assert.equal(timedOut.exitCode, 1);
    assert.match(timedOut.stderr, /timed out/);
    const survived = await survivor.done;
    assert.equal(survived.exitCode, 0, survived.stderr);
    assert.equal(JSON.parse(survived.stdout), "Local browser test");
    assert.equal((await status()).browserPid, browserPid);
    assert.equal((await status()).tasks.length, 0);

    // A separately launched browser remains usable when the helper cleans up.
    const unrelated = await chromium.launch();
    try {
      const page = await unrelated.newPage();
      await page.setContent("<title>Unrelated browser</title>");
      await poll(() => !alive(managerPid) && !alive(browserPid));
      assert.equal(await page.title(), "Unrelated browser");
      assert.equal((await status()).running, false);
    } finally {
      await unrelated.close();
    }

    // The singleton can restart after cleanup and idle browsers can be stopped.
    const restart = await run('return "restarted";').done;
    assert.equal(restart.exitCode, 0, restart.stderr);
    const restarted = await status();
    managerPid = restarted.managerPid;
    browserPid = restarted.browserPid;
    assert.equal(JSON.parse((await invoke(env, ["stop"]).done).stdout).stopped, true);
    await poll(() => !alive(managerPid) && !alive(browserPid));

    // The browser's pipe must also close if the manager itself crashes.
    const interrupted = run(
      'await page.setContent("manager crash"); await new Promise(done => setTimeout(done, 30000));',
    );
    const crashing = await poll(async () => {
      const s = await status();
      return s.browserPid && s.tasks[0]?.workerPid ? s : false;
    });
    managerPid = crashing.managerPid;
    browserPid = crashing.browserPid;
    process.kill(managerPid, "SIGKILL");
    assert.notEqual((await interrupted.done).exitCode, 0);
    await poll(
      () => !alive(managerPid) && !alive(browserPid) && !alive(crashing.tasks[0].workerPid),
    );
    assert.equal((await status()).running, false);
  },
);
