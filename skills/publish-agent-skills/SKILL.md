---
name: publish-agent-skills
description: Create, validate, and publish skills.sh-compatible Agent Skills repos for Claude Code, Codex, and other agents using SKILL.md, pnpm, and npx skills.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Publish Agent Skills

## Workflow

1. Inspect the repo before editing. Confirm whether it already has `skills/`, `package.json`, validation scripts, CI, and published skills.
2. Put installable skills at `skills/<skill-name>/SKILL.md`, or in a deliberate channel such as `skills/.experimental/<skill-name>/SKILL.md`.
3. Keep templates, examples, and drafts from becoming installable. Use names such as `SKILL.md.tmpl`, not `SKILL.md`, outside the publishable `skills/` tree.
4. Wire the CLI for maintainers when the repo uses pnpm:

```json
{
  "scripts": {
    "skills": "skills",
    "validate": "node scripts/validate-skills.mjs"
  },
  "devDependencies": {
    "skills": "1.5.6"
  }
}
```

5. Document both public install commands (`npx skills add owner/repo`) and local maintainer commands (`pnpm skills add . --list`).
   Use `--skill '*' --agent <agent> --yes` when documenting "install every skill for one agent"; `--all` means every skill for every supported agent.
6. Validate before finishing. Run the repo's validation command, then run `pnpm skills add . --list` or `npx skills add . --list` once at least one real skill exists.

## Add A Skill

1. Create `skills/<skill-name>/`, where the folder name uses lowercase letters, numbers, and hyphens.
2. Copy `templates/skill/SKILL.md.tmpl` to `skills/<skill-name>/SKILL.md` when the repository provides one.
3. Copy `templates/skill/agents/openai.yaml.tmpl` to `skills/<skill-name>/agents/openai.yaml` when the repository validates OpenAI/Codex display metadata.
4. Update the frontmatter so `name` exactly matches the folder name and `description` explains what the skill does and when agents should use it.
5. Add optional `scripts/`, `references/`, or `assets/` only when they directly support the skill.
6. Run `pnpm validate` when the repo provides that script.
7. Run `pnpm skills add . --list` to confirm the CLI can discover the skill locally.

The GitHub Actions workflow should run both validation and CLI discovery on pull requests and pushes to the main branch.

## Quality Bar

- Use lowercase letters, numbers, and hyphens for skill folder names.
- Keep `name` exactly equal to the parent folder name.
- Write `description` as the trigger surface: include what the skill does and when agents should use it in 200 characters or fewer for Claude.ai compatibility.
- Treat `SKILL.md` as the cross-agent source of truth. Claude Code reads it directly; any `agents/openai.yaml` file is optional OpenAI/Codex display metadata, not a Claude-specific config.
- Keep `SKILL.md` concise. Move detailed docs to `references/`.
- Use scripts for repeatable or fragile operations, make script dependencies explicit, and test at least one representative execution path.
- Add `assets/` only for files the agent should copy or use in final outputs.
- Avoid auxiliary docs inside individual skill folders unless the agent needs to load them as references.
- Avoid checked-in scratch files, generated output, or example `SKILL.md` files outside the canonical `skills/` tree.
- Treat skills like code. Review any executable helper before publishing.

## Publication

There is no separate skills.sh publish command. Publish by merging the skill repo to GitHub and sharing the source:

```bash
npx skills add owner/repo --list
npx skills add owner/repo --skill skill-name
npx skills add owner/repo --skill skill-name --agent claude-code
npx skills add owner/repo --skill skill-name --agent codex
npx skills add owner/repo --skill '*' --agent claude-code --yes
npx skills add owner/repo --skill '*' --agent codex --yes
```

Add a skills.sh badge to the repo README when the repo is public:

```markdown
[![skills.sh](https://skills.sh/b/owner/repo)](https://skills.sh/owner/repo)
```

## Local Pitfalls

- The skills CLI can recursively discover `SKILL.md` files if it finds no standard skills. Remove scratch clones from the repo or keep them under ignored local-only directories before testing.
- Do not treat a successful package install as skill validation. Check the actual `SKILL.md` frontmatter and CLI discovery output.
- If scripts are bundled with a skill, document their dependencies and test at least one representative execution path.

## References

- [skills.sh documentation](https://skills.sh/docs)
- [skills CLI](https://github.com/vercel-labs/skills)
- [Agent Skills specification](https://agentskills.io/specification)
