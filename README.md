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
- [`audit-improve-seo`](./skills/audit-improve-seo/SKILL.md): audit and improve technical and on-page SEO, including metadata, indexability, structured data, and generated social images.
- [`better-logging`](./skills/better-logging/SKILL.md): design durable operation outcome events so failures, latency, retries, and rollouts are queryable.
- [`conductor-setup`](./skills/conductor-setup/SKILL.md): configure `.conductor/settings.toml`, migrate legacy `conductor.json`, and set up local/cloud Conductor workspace scripts; invoke it as `$conductor-setup` in Codex.
- [`detailed-pr-description`](./skills/detailed-pr-description/SKILL.md): assess test coverage or draft/update review-ready GitHub PR descriptions with change context, risks, follow-up work, and focused code references.
- [`electron-flamegraph`](./skills/electron-flamegraph/SKILL.md): profile Electron main-process CPU usage and analyze `.cpuprofile` files.
- [`review-fix-address-bots`](./skills/review-fix-address-bots/SKILL.md): compare three persistent GPT-5.6 Sol, Terra, and Luna reviews by default (or a requested cohort), resolve findings through bounded critique, and close GitHub review-bot feedback loops.
- [`setup-cloudflare-pr-previews`](./skills/setup-cloudflare-pr-previews/SKILL.md): set up, audit, or repair Cloudflare Workers PR previews with aliased URLs, branch-isolated D1 databases, migrations, binding injection, stable environments, and PR-close cleanup.

## License

MIT
