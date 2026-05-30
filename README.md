# biw Skills

[![skills.sh](https://skills.sh/b/biw/skills)](https://skills.sh/biw/skills)

This repository is the public source for installable Agent Skills published from `biw/skills`.

Skills are installed directly from GitHub with the `skills` CLI. There is no separate registry publish step: once a skill is merged and people install it, it can appear on skills.sh through install telemetry.

## Quickstart

List available skills:

```bash
npx skills add biw/skills --list
```

Install a specific skill for the auto-detected agent:

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

Install every skill for Claude Code:

```bash
npx skills add biw/skills --skill '*' --agent claude-code --yes
```

Install every skill for Codex:

```bash
npx skills add biw/skills --skill '*' --agent codex --yes
```

Install every skill for every supported agent:

```bash
npx skills add biw/skills --all
```

Claude Code project installs land under `.claude/skills/<skill-name>/SKILL.md`.
Codex project installs land under `.agents/skills/<skill-name>/SKILL.md`.
The shared `SKILL.md` is the source of truth for both agents. This repo also ships `agents/openai.yaml` for OpenAI/Codex-facing display metadata; Claude Code does not need a separate YAML file.

For repo maintainers, install dependencies once and use the local pnpm wrapper:

```bash
pnpm install
pnpm skills add biw/skills --list
pnpm skills add . --list
```

## Available Skills

- [`address-review-bots`](./skills/address-review-bots/SKILL.md): wait for and triage Claude, Devin, and similar GitHub PR review-bot feedback.
- [`better-logging`](./skills/better-logging/SKILL.md): design durable operation outcome events so failures, latency, retries, and rollouts are queryable.
- [`conductor-setup`](./skills/conductor-setup/SKILL.md): configure `conductor.json` and Conductor workspace scripts; use it as `/conductor-setup` in agent chats.
- [`electron-flamegraph`](./skills/electron-flamegraph/SKILL.md): profile Electron main-process CPU usage and analyze `.cpuprofile` files.
- [`publish-agent-skills`](./skills/publish-agent-skills/SKILL.md): create and maintain skills.sh-compatible Agent Skills repositories.

## License

MIT
