# `biw/skills`

[![skills.sh](https://skills.sh/b/biw/skills)](https://skills.sh/biw/skills)

A set of useful skills for agents.

## Quickstart

Select and install skills:

```bash
npx skills add biw/skills
```

## Available Skills

- [`address-review-bots`](./skills/address-review-bots/SKILL.md): wait for and triage Claude, Devin, and similar GitHub PR review-bot feedback.
- [`better-logging`](./skills/better-logging/SKILL.md): design durable operation outcome events so failures, latency, retries, and rollouts are queryable.
- [`conductor-setup`](./skills/conductor-setup/SKILL.md): configure `.conductor/settings.toml`, migrate legacy `conductor.json`, and set up Conductor workspace scripts; use it as `/conductor-setup` in agent chats.
- [`electron-flamegraph`](./skills/electron-flamegraph/SKILL.md): profile Electron main-process CPU usage and analyze `.cpuprofile` files.
- [`publish-agent-skills`](./skills/publish-agent-skills/SKILL.md): create and maintain skills.sh-compatible Agent Skills repositories.

## License

MIT
