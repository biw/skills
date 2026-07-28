---
name: conductor-setup
description: Configure .conductor/settings.toml, migrate legacy conductor.json, and set up Conductor workspace scripts, env vars, files, and caches.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Conductor Setup

Use this skill when configuring a repository for Conductor workspaces. When invoked directly, audit the setup against the conventions below and either apply the changes or report that none are needed.

## Workflow

1. Inspect `.conductor/settings.toml`, `.conductor/settings.local.toml`, legacy `conductor.json`, `.worktreeinclude`, `.conductor/*.sh`, legacy root-level `conductor-*.sh`, package scripts, and repo docs.
2. Read `references/conductor-docs.md` before changing script fields or environment variable usage.
3. Pick the settings file: committed `.conductor/settings.toml` for team defaults, gitignored `.conductor/settings.local.toml` for machine-local overrides, `~/.conductor/settings.toml` for user-wide preferences only. Migrate any `conductor.json` into `.conductor/settings.toml` and delete it unless the user wants it kept.
4. Keep script roles separate: `scripts.setup` prepares a new workspace, `scripts.run.<id>.command` starts long-running processes from the Run button, `scripts.archive` cleans up before archiving, `scripts.run_mode` decides whether run scripts may overlap.
5. Use Conductor variables over hard-coded paths and ports: `$CONDUCTOR_WORKSPACE_PATH`, `$CONDUCTOR_ROOT_PATH` (shared resources and caches), `$CONDUCTOR_WORKSPACE_NAME`, `$CONDUCTOR_PORT`, `$CONDUCTOR_IS_LOCAL` (local vs cloud).
6. Validate TOML syntax and run the narrowest relevant local check for any script you touch.

## Conventions

- Put shared settings in `.conductor/settings.toml` with the repository schema URL, using only documented repository fields. Do not create new `conductor.json` files.
- Prefer named run scripts under `[scripts.run.<id>]` with `command`, `default`, and `icon`, marking one `default = true` when there are several. Bare `scripts.run = "..."` is legacy.
- Keep Conductor scripts and logs together in `.conductor/`, unprefixed: `setup.sh`, `run.sh`, `shutdown.sh`, `archive.sh`, `setup.log`. Commit the scripts, gitignore the logs, and move root-level `conductor-*.sh` in, updating every reference. Conductor imposes no script location or filename, so this is a repository convention — leave an existing deliberate layout such as `script/` or `bin/` alone.
- Route `.conductor/setup.sh` output to `.conductor/setup.log` so failures are debuggable in loops. Preserve exit codes with `pipefail` when piping through `tee`.
- For static gitignored files that every workspace needs, use a committed `.worktreeinclude` at the repository root or `file_include_globs`. Reserve setup scripts for commands, generated files, symlinks, and workspace-specific resources.
- Copy files over 100 MB copy-on-write: `cp -c` on macOS, `cp --reflink=auto` on Linux, falling back to a symlink or a shared `$CONDUCTOR_ROOT_PATH` cache unless a true copy is required.
- Put PATH/toolchain setup directly in the scripts. Do not depend on slow, interactive, or prompt-producing shell startup files.
- Keep shared caches under `$CONDUCTOR_ROOT_PATH`, not inside transient workspaces, and use the archive script to flush or compact them and to clean only resources the workspace owns.
- Do not background run-script processes with `&`. Use `concurrently`, a supervisor, or one foreground process group so Conductor can stop everything cleanly.
- Reach for `run_mode = "nonconcurrent"` or Spotlight testing only when the project genuinely cannot run multiple instances — a single fixed port, database, root-only checkout, or one heavy local stack — never brittle workspace path hacks.
- Handle monorepos and linked repositories with Conductor's working-directory selection, `/add-dir`, or per-repository run scripts, not hard-coded sibling checkout paths.
- Do not commit secrets or machine-specific credentials to `.conductor/settings.toml`; put them in `.conductor/settings.local.toml`, shell config, or gitignored copied files. Only touch `.mcp.json` or `enterprise_data_privacy` when asked or when repository policy requires it.

## Snippet

Adapt command names to the repository, and gitignore `.conductor/*.log`:

```toml
"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"

[scripts]
setup = "bash -lc 'set -o pipefail; ./.conductor/setup.sh 2>&1 | tee .conductor/setup.log'"
archive = "./.conductor/shutdown.sh"
run_mode = "concurrent"

[scripts.run.dev]
command = "./.conductor/run.sh"
default = true
icon = "play"
```

Inside `.conductor/setup.sh`, make large-file copies explicit:

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
