# biw Skills

[![skills.sh](https://skills.sh/b/biw/skills)](https://skills.sh/biw/skills)

This repository is the public source for installable Agent Skills published from `biw/skills`.

Skills are installed directly from GitHub with the `skills` CLI. There is no separate registry publish step: once a skill is merged and people install it, it can appear on skills.sh through install telemetry.

## Quickstart

List available skills:

```bash
npx skills add biw/skills --list
```

Install a specific skill:

```bash
npx skills add biw/skills --skill <skill-name>
```

Install a specific skill for Claude Code:

```bash
npx skills add biw/skills --skill <skill-name> --agent claude-code
```

Install a specific skill for Codex:

```bash
npx skills add biw/skills --skill <skill-name> --agent codex
```

Install all skills:

```bash
npx skills add biw/skills --all
```

For repo maintainers, install dependencies once and use the local pnpm wrapper:

```bash
pnpm install
pnpm skills add biw/skills --list
pnpm skills add . --list
```

## Available Skills

- [`address-review-bots`](./skills/address-review-bots/SKILL.md): wait for and triage Claude, Devin, and similar GitHub PR review-bot feedback.
- [`better-logging`](./skills/better-logging/SKILL.md): design durable operation outcome events so failures, latency, retries, and rollouts are queryable.
- [`conductor-workspaces`](./skills/conductor-workspaces/SKILL.md): configure `conductor.json` and Conductor workspace scripts.
- [`electron-flamegraph`](./skills/electron-flamegraph/SKILL.md): profile Electron main-process CPU usage and analyze `.cpuprofile` files.
- [`publish-agent-skills`](./skills/publish-agent-skills/SKILL.md): create and maintain skills.sh-compatible Agent Skills repositories.

## License

MIT
