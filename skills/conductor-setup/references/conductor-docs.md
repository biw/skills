# Conductor Docs Reference

Read this reference before modifying `conductor.json` or Conductor workspace scripts. Source docs:

- https://www.conductor.build/docs/reference/environment-variables
- https://www.conductor.build/docs/reference/scripts/setup
- https://www.conductor.build/docs/reference/scripts/run
- https://www.conductor.build/docs/reference/scripts
- https://www.conductor.build/docs/reference/files-to-copy
- https://www.conductor.build/docs/reference/conductor-json
- https://www.conductor.build/docs/reference/scripts/spotlight-testing
- https://www.conductor.build/docs/reference/shells
- https://www.conductor.build/docs/reference/mcp
- https://www.conductor.build/docs/reference/security-and-permissions
- https://www.conductor.build/docs/guides/repositories/monorepos
- https://www.conductor.build/docs/guides/repositories/linking-multiple-directories
- https://www.conductor.build/docs/troubleshooting/issues

## `conductor.json`

`conductor.json` is an optional repository-root file for shared Conductor scripts and settings. Commit it when teammates should use the same setup/run/archive behavior. Personal Repository Settings can override `conductor.json`, so if shared config appears ignored, ask the user to clear local setup/run/archive overrides.

Supported fields:

- `scripts.setup`: command run when Conductor creates a workspace.
- `scripts.run`: command run when the user clicks Run.
- `scripts.archive`: command run before Conductor archives a workspace.
- `runScriptMode`: `"concurrent"` or `"nonconcurrent"`.
- `enterpriseDataPrivacy`: `true` or `false`.

Minimal example:

```json
{
  "scripts": {
    "setup": "npm install",
    "run": "npm run dev"
  },
  "runScriptMode": "concurrent"
}
```

## Environment Variables

Conductor exposes these variables in workspace terminals and scripts:

- `CONDUCTOR_WORKSPACE_NAME`: workspace name.
- `CONDUCTOR_WORKSPACE_PATH`: workspace path.
- `CONDUCTOR_ROOT_PATH`: repository root path.
- `CONDUCTOR_DEFAULT_BRANCH`: default branch name, usually `main`.
- `CONDUCTOR_PORT`: first port in a range of 10 assigned to the workspace.

Use `$CONDUCTOR_ROOT_PATH` for root-level shared resources such as `.env` files, dependency caches, and artifacts shared between workspaces. Use `$CONDUCTOR_PORT` for local servers to avoid port conflicts across parallel workspaces.

## Setup Script

The setup script runs inside the newly created workspace directory. Use it for commands not covered by Git checkout:

- install dependencies;
- copy or symlink `.env` files;
- build generated assets;
- initialize local services or workspace-specific resources.

Use Files to copy instead of a setup script when Conductor only needs to copy static gitignored local files. For team-shared patterns, commit `.worktreeinclude` at the repository root. Use a setup script when the workspace needs commands, generated files, symlinks, or workspace-specific resources.

Setup scripts run in non-interactive shells. If a command works in a normal terminal but fails in setup, check shell initialization assumptions. Prefer putting required PATH/toolchain setup directly in the script. Avoid depending on `.zshrc` or `.zshenv` behavior that prompts, runs slowly, or assumes an interactive terminal.

For workspace-specific resources, use `$CONDUCTOR_WORKSPACE_NAME` in generated names and `$CONDUCTOR_PORT` for ports. This prevents one workspace from overwriting another workspace's database, data directory, app identifier, or local service.

## Run Script

The run script launches a long-running app, server, test watcher, or equivalent command from the workspace directory. Use `$CONDUCTOR_PORT` when starting a local server; Conductor allocates ten ports from `$CONDUCTOR_PORT` through `$CONDUCTOR_PORT+9`.

If the project cannot run cleanly from a workspace directory, Spotlight testing can sync one workspace back to the repository root and test from there.

When a run script starts multiple processes, keep them in the same process group so Conductor can stop them together. Use `concurrently` or a similar supervisor. Avoid backgrounding commands with `&`; backgrounded processes can keep ports, memory, or resources after Conductor stops the script.

Use `runScriptMode: "nonconcurrent"` when the project depends on a single shared resource, such as one fixed port or one local database. Otherwise default to concurrent workspace runs.

## Files to Copy

Files to copy use gitignore-style glob patterns for gitignored files that should be copied into each new workspace. Conductor defaults to `.env*`. Prefer a committed `.worktreeinclude` for team-shared patterns; it takes precedence over local Repository Settings and makes the settings UI read-only for those patterns.

Use `.worktreeinclude` for static local config such as `.env`, `.env.*`, or `config/local.json`. Use setup scripts when files need to be generated, symlinked, transformed, copied conditionally, or named per workspace.

## Shell Configuration

Conductor captures the login shell environment, then runs most commands, including setup and run scripts, with `zsh`. Slow or interactive shell startup can break agents and scripts; Conductor gives shell configuration a short startup window.

When reliability matters, make scripts self-contained:

```sh
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
eval "$(mise activate zsh)"
pnpm install
```

Keep `.zshenv` minimal. Do not put prompts, terminal UI setup, slow network calls, or commands requiring stdin in shell files that Conductor may load.

## Spotlight Testing

Spotlight testing is for projects that cannot run cleanly from workspace directories. It syncs one workspace's tracked changes back to the repository root, letting the root checkout keep using root-relative paths, fixed local resources, expensive build artifacts, or one heavy Docker/microservice stack.

Use normal run scripts when each workspace can run its own copy with workspace-specific ports and resources. Use `runScriptMode: "nonconcurrent"` first if the only problem is preventing multiple run scripts from sharing one fixed port or database.

Spotlight is one-way: root checkout changes do not sync back to the workspace. Edit in the workspace and let Conductor sync tracked changes to the root.

## Archive / Shutdown Script

The archive script runs before Conductor archives a workspace. Use it to clean up resources outside the workspace directory and to update shared caches under `$CONDUCTOR_ROOT_PATH`.

Conductor process shutdown sends `SIGHUP`, waits up to 200 ms, and then sends `SIGKILL` if the process is still running. Do not rely on long graceful shutdown work inside a run script process; put deterministic cleanup and cache updates in `scripts.archive`.

## Repository Layouts

For monorepos, Conductor creates workspaces at the repository root by default. If agents should only see specific packages or services, use Conductor's working-directory selection, which hides unselected directories with Git sparse checkout.

If the monorepo uses submodules, add `git submodule update --init --recursive` to the setup script so each workspace initializes them consistently.

For related repositories or sibling services, use Conductor's `/add-dir` flow to link workspaces from multiple directories. Do not hard-code assumptions that a sibling checkout exists at a developer-specific path.

When a workspace must run several services at once, create a run script that launches all needed services in one process group, or create per-repository run scripts for linked directories.

## MCP, Privacy, and Secrets

Project-level `.mcp.json` files are inherited by Conductor agents. MCP servers can send data to external services, so only add or edit MCP configuration when it is part of the task and acceptable under the repository's privacy policy.

Do not commit provider credentials or machine-local secrets in `conductor.json`. Provider variables belong in Conductor Environment settings or the user's shell environment; runtime app secrets should come from ignored files copied or symlinked into each workspace.

`enterpriseDataPrivacy` can be set in `conductor.json` for repository-wide policy. Only change it when the user asks or the repository policy clearly requires it, because it disables features that rely on external AI providers, including custom MCP servers.

## Troubleshooting Signals

For setup failures, check `conductor-setup.log`, missing ignored files, dependencies installed only in the repository root, fixed absolute paths, and unavailable authentication.

For run failures, check fixed ports, shared databases or caches, backgrounded processes, and commands that only work from the root checkout. Use `$CONDUCTOR_PORT`, workspace-specific resource names, `nonconcurrent`, or Spotlight testing based on the actual cause.

For archive failures, keep the script focused on cleanup outside the workspace directory and cache updates under `$CONDUCTOR_ROOT_PATH`; failed archive scripts can block archiving.
