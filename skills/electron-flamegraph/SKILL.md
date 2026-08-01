---
name: electron-flamegraph
description: Profile Electron main-process CPU usage, generate launch commands, analyze .cpuprofile files, and identify actionable performance fixes.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Electron Flamegraph: Setup & Analysis

Route to exactly one phase. Do not load the other phase's reference unless the user asks to continue into it.

## Setup a capture

Use when the user has not produced a `.cpuprofile` yet.

1. Inspect `package.json`, Electron tooling config, and the main-process entry to identify the launcher, language, bundling, and source-map behavior.
2. Read `references/setup-patterns.md`, but only the strategy and launcher sections that apply.
3. Choose whole-process `--cpu-prof` when there is no specific hypothesis, programmatic scoped profiling when one operation is suspected, or live `--inspect` for interactive capture. Default to scoped profiling for a concrete operation and whole-process profiling otherwise.
4. Produce the exact launcher-specific command. For scoped profiling, add or adapt the helper in the project's style and show the precise call to wrap.
5. Tell the user where the profile will land and what scenario to reproduce, then stop and wait for the resulting file path. Do not execute the interactive profiling command.

## Analyze a capture

Use when the user provides a `.cpuprofile` path. Read `references/analysis-workflow.md` and follow it completely. Run the bundled `scripts/analyze-cpuprofile.mjs` from this skill directory rather than recreating its analysis.

## Boundaries

- Profile Electron's main process only. Use the renderer DevTools Performance panel for renderer work.
- Do not analyze without a valid capture or invent a CPU finding to match the user's hypothesis.
- Do not recommend worker threads unless the profile shows sustained, irreducible CPU-bound main-process work.

## Resources

- `references/setup-patterns.md`: capture strategies and exact launcher-specific commands.
- `references/analysis-workflow.md`: profile validation, analyzer options, interpretation, and reporting.
- `scripts/analyze-cpuprofile.mjs`: deterministic `.cpuprofile` summary and heuristics.
