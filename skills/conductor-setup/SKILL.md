---
name: conductor-setup
description: Configure conductor.json and Conductor workspace scripts for setup, run, archive/shutdown, env vars, large files, and shared caches.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Conductor Setup

Use this skill when configuring a repository for Conductor workspaces. Focus first on `conductor.json`; add or edit shell scripts only when the shared JSON should call reusable setup, run, or archive/shutdown commands.

## Workflow

1. Inspect `conductor.json`, `.worktreeinclude`, existing `conductor-setup.sh`, `conductor-run.sh`, `conductor-shutdown.sh`, `conductor-archive.sh`, package scripts, and repo docs.
2. Read `references/conductor-docs.md` before changing script fields or environment variable usage.
3. Prefer committed `conductor.json` for shared team behavior. Remember that local Repository Settings can override it.
4. Keep setup, run, and archive/shutdown responsibilities separate:
   - `scripts.setup`: prepare a new workspace.
   - `scripts.run`: start long-running app/server/test processes.
   - `scripts.archive`: run shutdown cleanup before a workspace is archived.
5. Use Conductor variables instead of hard-coded paths or ports:
   - `$CONDUCTOR_WORKSPACE_PATH` for the active workspace.
   - `$CONDUCTOR_ROOT_PATH` for shared root-level resources and caches.
   - `$CONDUCTOR_WORKSPACE_NAME` for workspace-specific names.
   - `$CONDUCTOR_PORT` for server ports.
6. For monorepos and multi-repo systems, prefer Conductor's working-directory selection, `/add-dir`, or per-repository run scripts over hard-coded sibling checkout paths.
7. Validate JSON syntax and run the narrowest relevant local check for any script you touch.

## Required Conventions

- Always use copy-on-write cloning for files over 100 MB when duplicating large artifacts. On macOS prefer `cp -c`; on Linux prefer `cp --reflink=auto`. If clone/reflink is unavailable, prefer a symlink or shared cache under `$CONDUCTOR_ROOT_PATH` unless the repo needs a true copy.
- Route every `conductor-setup.sh` run to `conductor-setup.log` so setup failures are easy to debug in loops. Preserve exit codes with `pipefail` when piping through `tee`.
- Use a committed `.worktreeinclude` for static gitignored files that should be copied into every workspace. Keep setup scripts for commands, generated files, symlinks, and workspace-specific resources.
- Put required PATH/toolchain setup directly in setup or run scripts when possible. Do not rely on slow, interactive, or prompt-producing shell startup files.
- Put shared caches outside individual workspaces under `$CONDUCTOR_ROOT_PATH`, and use the archive/shutdown script to flush, update, compact, or clean those shared caches.
- Do not background long-running run-script processes with `&`. Use `concurrently`, a supervisor, or a single foreground process group so Conductor can stop everything cleanly.
- Use `runScriptMode: "nonconcurrent"` only when the project cannot safely run multiple workspace instances because of a single fixed port, database, or shared local resource.
- Use Spotlight testing instead of overcomplicated run/setup scripts when the project truly needs the repository root checkout, expensive root build artifacts, or one heavy local stack.
- Do not commit secrets, provider API keys, or machine-specific credentials in `conductor.json`. Only change `.mcp.json` or `enterpriseDataPrivacy` when the user asks or the repository policy requires it.

## Snippet

Use this as a starting point and adapt command names to the repository:

```json
{
  "scripts": {
    "setup": "bash -lc 'set -o pipefail; ./conductor-setup.sh 2>&1 | tee conductor-setup.log'",
    "run": "./conductor-run.sh",
    "archive": "./conductor-shutdown.sh"
  },
  "runScriptMode": "concurrent"
}
```

Inside `conductor-setup.sh`, make large-file copies explicit:

```bash
copy_large_file() {
  src="$1"
  dest="$2"
  size="$(wc -c < "$src" | tr -d ' ')"
  if [ "$size" -gt 104857600 ]; then
    cp -c "$src" "$dest" 2>/dev/null || cp --reflink=auto "$src" "$dest" 2>/dev/null || ln -s "$src" "$dest"
  else
    cp "$src" "$dest"
  fi
}
```

## Review Checklist

- `conductor.json` is valid JSON and uses only documented fields.
- Setup work that only copies static gitignored files is not over-engineered; prefer `.worktreeinclude` for team-shared file-copy patterns.
- Scripts contain their own required shell setup and do not depend on interactive prompts or slow startup files.
- Setup logs land in `conductor-setup.log`.
- Run scripts use `$CONDUCTOR_PORT` or `runScriptMode: "nonconcurrent"` when needed.
- Shared caches live under `$CONDUCTOR_ROOT_PATH`, not inside transient workspace directories.
- Shutdown/archive logic updates shared caches and cleans only resources owned by the workspace.
- Root-only, fixed-resource, or very expensive local stacks are handled with Spotlight testing or `nonconcurrent`, not brittle workspace path hacks.
- Monorepo and multi-repository needs are handled with Conductor working-directory selection, `/add-dir`, or separate per-repository scripts.
