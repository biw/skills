# Repository Instructions

This repository publishes Agent Skills from `biw/skills`.

- Put installable skills under `skills/<skill-name>/SKILL.md`.
- Keep the `name` frontmatter exactly equal to the parent folder name.
- Keep starter material under `templates/` with `.tmpl` suffixes so the CLI does not publish it.
- Run `pnpm validate` before committing skill changes.
- Use `pnpm skills add . --list` to smoke-test CLI discovery after at least one skill exists.
- Do not commit scratch repos or generated output. `.context/` is for local agent collaboration only.
