# Repository Instructions

This repository publishes Agent Skills from `biw/skills`.

- Put installable skills under `skills/<skill-name>/SKILL.md`.
- When adding an installable skill, add it to the README's Available Skills list with a link and concise description.
- Start from both templates under `templates/skill/`, including `agents/openai.yaml.tmpl`.
- Keep the `name` frontmatter exactly equal to the parent folder name.
- Write descriptions as clear trigger surfaces in 200 characters or fewer.
- Keep starter material under `templates/` with `.tmpl` suffixes so the CLI does not publish it.
- Add scripts, references, and assets only when they directly support a skill; test executable helpers.
- The skill installer copies every file below `skills/<skill-name>/` except a few metadata/cache paths. Keep development tests exclusively under `tests/<skill-name>/`; never place `*.test.*` or `*.spec.*` files inside an installable skill directory.
- Run `pnpm validate` before committing skill changes.
- Use `pnpm skills add . --list` to smoke-test CLI discovery after at least one skill exists.
- Do not commit scratch repos or generated output. `.context/` is for local agent collaboration only.
