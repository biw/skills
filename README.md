# `biw/skills`

[![skills.sh](https://skills.sh/b/biw/skills)](https://skills.sh/biw/skills)

This repository is the public source for installable Agent Skills published from `biw/skills`.

## Quickstart

List available skills:

```bash
npx skills add biw/skills --list
```

Install a specific skill:

```bash
npx skills add biw/skills --skill <skill-name>
```

Install every skill:

```bash
npx skills add biw/skills --all
```

## Available Skills

- [`address-review-bots`](./skills/address-review-bots/SKILL.md): wait for and triage Claude, Devin, and similar GitHub PR review-bot feedback.
- [`better-logging`](./skills/better-logging/SKILL.md): design durable operation outcome events so failures, latency, retries, and rollouts are queryable.
- [`conductor-setup`](./skills/conductor-setup/SKILL.md): configure `conductor.json` and Conductor workspace scripts; use it as `/conductor-setup` in agent chats.
- [`electron-flamegraph`](./skills/electron-flamegraph/SKILL.md): profile Electron main-process CPU usage and analyze `.cpuprofile` files.
- [`publish-agent-skills`](./skills/publish-agent-skills/SKILL.md): create and maintain skills.sh-compatible Agent Skills repositories.

## License

MIT
