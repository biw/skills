---
name: electron-flamegraph
description: Profile Electron main-process CPU usage, generate launch commands, analyze .cpuprofile files, and identify actionable performance fixes.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Electron Flamegraph: Setup & Analysis

Two-phase skill: give the user the exact command to profile their Electron app, **do not run it**, then analyze the `.cpuprofile` they return with.

The user is running the app on their own machine because (a) reproducing the slow behavior usually requires interaction they have to drive, and (b) their Electron app can't run in this environment anyway. Respect the boundary — don't try to execute the profiling command.

## Phase 1 — Setup (before the user runs anything)

### 1.1 Inspect the repo

Read these before suggesting any command:

- `package.json` — `scripts`, `main` entry, and electron-related deps (`electron`, `@electron-forge/*`, `electron-vite`, `electron-builder`, `vite`, `esbuild`, `tsx`). This determines the launcher.
- Any tooling config in the repo root: `forge.config.{js,ts,cjs,mjs}`, `electron.vite.config.*`, `electron-builder.{yml,json,js}`, `vite.config.*`.
- The main process entry file (from `package.json#main` or the forge/vite config). Note whether it's TypeScript or plain JS, and whether it's bundled before launch (affects source map usability).

The launcher matters because raw `electron .` takes Node flags directly, Electron Forge needs `-- --flag` passthrough, and electron-vite sometimes needs `NODE_OPTIONS`. Read `references/setup-patterns.md` for the exact invocation per launcher.

### 1.2 Pick a profiling strategy

Ask the user briefly if the right choice isn't obvious from the conversation. Three options:

**A. Whole-process `--cpu-prof`** — pass Node flags to the Electron main process. Best when the user has no specific hypothesis. Cost: captures startup noise, file is large, harder to read.

**B. Programmatic scoped profiling** — wrap the suspect code with `node:inspector` Session. Best when they already suspect a specific operation (a query, an import, a window transition). Gives a clean profile of just that slice. Requires a small code edit.

**C. Live `--inspect` + Chrome DevTools** — launch with the inspector, attach DevTools, hit record before the suspect action. Best for interactive investigation where the slow thing requires clicking around.

Default: **B if they have a hypothesis, A otherwise.** If they describe the problem as "it feels blocked when I do X", that's a hypothesis — push them toward B.

### 1.3 Produce the exact commands

Read `references/setup-patterns.md` and generate the invocation for their specific launcher. Do not guess — the flag passthrough rules differ and getting it wrong wastes the user's time.

For strategy B, write the `profileBlock` helper into their codebase matching the existing style (TS vs JS) and show them exactly where to wrap the suspect code. Use arrow functions. If something similar already exists, reuse it rather than duplicating.

### 1.4 Hand off

End Phase 1 with:

- The exact command(s) to run
- Where the `.cpuprofile` file will land (cwd by default, or `--cpu-prof-dir`)
- What scenario to reproduce during capture
- A clear instruction to paste the resulting file path back when done

Do **not** execute the command. Stop and wait.

## Phase 2 — Analysis (after the user returns with a .cpuprofile)

### 2.1 Locate and sanity-check the file

Verify:
- File exists and is valid JSON with `nodes`, `samples`, `timeDeltas` keys
- Sampled duration is >200ms (shorter is noise)
- The user actually reproduced the problem during capture — ask if unclear. A profile of an idle app tells you nothing.

### 2.2 Run the analyzer

```bash
node scripts/analyze-cpuprofile.mjs <path-to-cpuprofile>
```

Run the bundled analyzer from this skill directory. If needed, resolve the directory containing this `SKILL.md` and pass the script path explicitly.

Optional flags:
- `--top=N` — how many hot functions to list (default 20)
- `--stall-threshold-ms=N` — minimum sample duration to flag as a stall (default 50)
- `--json` — machine-readable output for further processing

The script produces:
- Time distribution across user code / node_modules / node: builtins / native & GC
- Top functions by **self time** (where cycles actually go)
- Top functions by **total time** (what call paths dominate)
- Long synchronous samples (main-thread stalls)
- Heuristic warnings for common culprits: sync fs, JSON.parse/stringify hot spots, regex-heavy paths, module load time

### 2.3 Interpret — don't just dump the output

The raw output is a starting point. The job is to correlate it with what the user was doing during capture and point at the specific thing to fix.

Ground rules:

- **Self time >> total time for diagnosis.** Total time says where a problem lives in the call tree; self time says where cycles actually go. Most fixes target self-time hot spots.
- **Discount startup frames** unless startup is what they were profiling. `Module._compile`, `require`, V8 compilation, and first-query engine warmup dominate a full-lifetime profile but usually aren't the real problem.
- **Native frames are often honest.** If libSQL, Prisma's engine IPC, an N-API addon, or Core Audio shows up as a big native block, the fix is almost never "optimize the JS around it" — it's "call it less" or "ask for less data."
- **Stalls matter more than cumulative time.** A function that takes 5% cumulative but runs in one 800ms block is a worse user experience than 20% spread across many short calls. The stalls section of the analyzer surfaces this.
- **Bundled code has mangled names.** If the main process is built by electron-vite/esbuild/webpack, function names may be `t`, `e$1`, etc. Tell the user to enable source maps in their dev build and re-profile if the names are unreadable.

### 2.4 Give actionable recommendations

For each finding worth addressing:

1. **What the profile shows** — with actual numbers from the analyzer output
2. **What's likely causing it** — tied to something concrete in their codebase if possible
3. **The specific change** — file, line, or architectural move. Not "consider optimizing"
4. **How to verify** — re-profile the same scope and compare

If the profile doesn't show a clear main-thread stall but the user's complaint was "it feels blocked," say that directly. Possible the complaint is a renderer/UX issue, not a main-process CPU issue — in which case they need the renderer's built-in DevTools Performance tab, not this skill. Don't invent findings to match the original hypothesis.

## What this skill won't do

- **Profile the renderer process.** Renderers have built-in DevTools (Cmd-Opt-I / Ctrl-Shift-I → Performance tab). Different problem, different tool.
- **Run the app.** The user runs it and comes back with the file.
- **Pre-analyze without data.** If the user hasn't run the command yet, don't pretend to analyze — stop at Phase 1.
- **Reflexively recommend worker threads.** Most slowdowns are fixed by doing less work, not by adding threading. Only suggest workers when the profile shows sustained CPU-bound work on the main thread that can't be reduced.
