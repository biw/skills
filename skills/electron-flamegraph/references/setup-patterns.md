# Electron Profiling Setup Patterns

How to apply each profiling strategy across common Electron setups. Read the section matching the user's launcher before giving them commands.

## Strategy A — Whole-process --cpu-prof

V8 flags recognized: `--cpu-prof`, `--cpu-prof-dir=<dir>`, `--cpu-prof-interval=<microseconds>` (default 1000μs = 1ms), `--cpu-prof-name=<filename>`.

### Raw `electron .`

```bash
electron --cpu-prof --cpu-prof-dir=./profiles --cpu-prof-interval=500 .
```

The flags come _before_ the entry `.`, because everything after the script path goes to `process.argv`.

### npm script wrapping `electron .`

Either edit the existing script or add a sibling:

```json
{
  "scripts": {
    "start": "electron .",
    "start:prof": "electron --cpu-prof --cpu-prof-dir=./profiles ."
  }
}
```

### Electron Forge (`@electron-forge/cli`)

Forge wraps the electron binary. Pass flags through with `--`:

```bash
npm start -- --cpu-prof --cpu-prof-dir=./profiles
```

Or with the forge CLI directly:

```bash
electron-forge start -- --cpu-prof --cpu-prof-dir=./profiles
```

If that doesn't produce a `.cpuprofile`, check `forge.config.{js,ts}` for a custom `runner` or hooks that might swallow argv. As a fallback, `NODE_OPTIONS` works:

```bash
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=./profiles" npm start
```

### electron-vite

```bash
electron-vite dev -- --cpu-prof --cpu-prof-dir=./profiles
```

If the flags don't reach electron (happens on some versions), use `NODE_OPTIONS`:

```bash
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=./profiles" electron-vite dev
```

Caveat: `NODE_OPTIONS` applies to every Node process spawned, which may include the vite dev server. Expect extra `.cpuprofile` files in the output dir — you want the one named with the Electron main process PID. `ps` while the app is running will tell you which PID is electron.

### Packaged / built app

Run the binary directly with flags:

**macOS:**

```bash
./out/MyApp-darwin-arm64/MyApp.app/Contents/MacOS/MyApp --cpu-prof --cpu-prof-dir=/tmp/profiles
```

**Linux:**

```bash
./out/MyApp-linux-x64/MyApp --cpu-prof --cpu-prof-dir=/tmp/profiles
```

**Windows:**

```
.\out\MyApp-win32-x64\MyApp.exe --cpu-prof --cpu-prof-dir=C:\temp\profiles
```

## Strategy B — Programmatic scoped profiling

Drop this helper into the main-process codebase. Match the existing file style (TS vs JS). Use arrow functions.

### TypeScript

```ts
import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const profileBlock = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.start");
  try {
    return await fn();
  } finally {
    const { profile } = await session.post("Profiler.stop");
    const path = join(process.cwd(), `${name}-${Date.now()}.cpuprofile`);
    writeFileSync(path, JSON.stringify(profile));
    session.disconnect();
    console.log(`[profile] wrote ${path}`);
  }
};
```

### JavaScript (ESM)

```js
import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const profileBlock = async (name, fn) => {
  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  await session.post("Profiler.start");
  try {
    return await fn();
  } finally {
    const { profile } = await session.post("Profiler.stop");
    const path = join(process.cwd(), `${name}-${Date.now()}.cpuprofile`);
    writeFileSync(path, JSON.stringify(profile));
    session.disconnect();
    console.log(`[profile] wrote ${path}`);
  }
};
```

### Usage

```ts
const rows = await profileBlock("prisma-findmany", () =>
  prisma.whatever.findMany({ where: {/* ... */} }),
);
```

Constraints:

- One inspector session per process at a time. Don't nest `profileBlock` calls — the inner one will fail to start the profiler.
- `await` must cover everything you care about. If the profiled function returns a Promise that continues work after resolving, that tail work won't be captured.
- In a worker thread, this works unchanged — each worker has its own inspector session.

## Strategy C — Live --inspect

```bash
electron --inspect=9229 .
```

Or for Forge / electron-vite, use the passthrough patterns from Strategy A, substituting `--inspect=9229` for `--cpu-prof`.

Then in Chrome:

1. Open `chrome://inspect`
2. Click "Configure" and add `localhost:9229` if not already listed
3. Under "Remote Target" a Node target should appear — click "inspect"
4. In the DevTools that opens, go to the Performance tab
5. Hit record, reproduce the slow behavior, stop recording

If multiple Electron processes show up (main + utility processes), the main process is usually the one with your app's cwd in the title. If unsure, look at the source files visible in the Sources tab.

Use `--inspect-brk=9229` instead to pause on the first line of main — useful when profiling startup.

## Gotchas

- **Renderer profiling is separate.** `--cpu-prof` on the main process does not profile the renderer. Renderers have their own V8 instance. Use the window's built-in DevTools (Cmd-Opt-I / Ctrl-Shift-I) → Performance tab.
- **Source maps.** Bundled main processes (electron-vite, esbuild, webpack) emit `.cpuprofile` files with mangled names and bundled paths. Enable source maps in the dev build so DevTools can map back. The analyzer script in this skill shows the raw bundled names — readable but uglier than source-mapped output in DevTools.
- **Dev vs release builds profile differently.** HMR, source maps, unbundled modules, and debug assertions all change perf characteristics. Profile the build that matches the reported problem.
- **Sampling interval tradeoff.** Default `--cpu-prof-interval=1000` (1ms) misses sub-millisecond functions entirely. Drop to 100–500μs for short operations; raise to 2000–5000μs if the profile file gets unwieldy.
- **Electron utility processes.** Some Electron apps spawn utility processes (`utilityProcess.fork`). Each has its own PID and `.cpuprofile`. Check filenames for the right one.
