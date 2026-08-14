#!/usr/bin/env python3
"""Report per-skill token deltas between a base revision and the working tree."""

from __future__ import annotations

import argparse
import subprocess
from dataclasses import dataclass
from pathlib import Path

import tiktoken


IGNORED_DIRECTORY_NAMES = {".context", ".git", "__pycache__", "node_modules"}
TOKEN_ENCODING = "o200k_base"


@dataclass(frozen=True)
class TokenDelta:
    skill: str
    file: str
    current: int
    updated: int

    @property
    def delta(self) -> int:
        return self.updated - self.current


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-ref",
        default="origin/main",
        help="Git revision used for the Current column (default: origin/main).",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=Path.cwd(),
        help="Repository root containing skills/ (default: current directory).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Write the Markdown report to this path instead of standard output.",
    )
    return parser.parse_args()


def git_output(repo_root: Path, *arguments: str) -> bytes:
    result = subprocess.run(
        ["git", *arguments],
        cwd=repo_root,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"git {' '.join(arguments)} failed: {stderr}")

    return result.stdout


def base_files(repo_root: Path, base_ref: str) -> set[Path]:
    listing = git_output(repo_root, "ls-tree", "-r", "--name-only", base_ref, "--", "skills")
    return {Path(line) for line in listing.decode("utf-8").splitlines() if line}


def worktree_files(skills_directory: Path) -> set[Path]:
    files = set()
    for candidate in skills_directory.rglob("*"):
        if not candidate.is_file() or any(part in IGNORED_DIRECTORY_NAMES for part in candidate.parts):
            continue

        files.add(candidate.relative_to(skills_directory.parent))

    return files


def base_file_content(repo_root: Path, base_ref: str, path: Path) -> bytes:
    return git_output(repo_root, "show", f"{base_ref}:{path.as_posix()}")


def is_utf8_text(content: bytes | None) -> bool:
    if content is None or b"\0" in content:
        return False

    try:
        content.decode("utf-8")
    except UnicodeDecodeError:
        return False

    return True


def skill_roots(paths: set[Path]) -> list[Path]:
    return sorted(path.parent for path in paths if path.name == "SKILL.md")


def skill_root_for_file(path: Path, roots: list[Path]) -> Path | None:
    matching_roots = [root for root in roots if path.is_relative_to(root)]
    return max(matching_roots, key=lambda root: len(root.parts), default=None)


def format_delta(delta: int) -> str:
    return f"{delta:+,}" if delta else "0"


def escape_markdown(value: str) -> str:
    return value.replace("\\", "\\\\").replace("|", "\\|")


def render_report(deltas: list[TokenDelta]) -> str:
    lines = [
        "| Skill | File | Current | Updated | Δ |",
        "| --- | --- | ---: | ---: | ---: |",
    ]

    skills_with_changes = sorted({delta.skill for delta in deltas if delta.delta})
    for skill in skills_with_changes:
        skill_deltas = sorted(
            (delta for delta in deltas if delta.skill == skill),
            key=lambda delta: delta.file,
        )
        for delta in skill_deltas:
            if not delta.delta:
                continue

            lines.append(
                "| "
                f"{escape_markdown(delta.skill)} | "
                f"{escape_markdown(delta.file)} | "
                f"{delta.current:,} | {delta.updated:,} | {format_delta(delta.delta)} |",
            )

        current_total = sum(delta.current for delta in skill_deltas)
        updated_total = sum(delta.updated for delta in skill_deltas)
        lines.append(
            f"| **{escape_markdown(skill)}** | **Total** | "
            f"**{current_total:,}** | **{updated_total:,}** | "
            f"**{format_delta(updated_total - current_total)}** |",
        )

    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    repo_root = args.repo_root.resolve()
    skills_directory = repo_root / "skills"
    if not skills_directory.is_dir():
        raise FileNotFoundError(f"Could not find {skills_directory}.")

    base_paths = base_files(repo_root, args.base_ref)
    updated_paths = worktree_files(skills_directory)
    roots = skill_roots(base_paths | updated_paths)
    if not roots:
        raise RuntimeError(f"No SKILL.md files found under {skills_directory} or {args.base_ref}.")

    encoder = tiktoken.get_encoding(TOKEN_ENCODING)
    deltas: list[TokenDelta] = []
    for path in sorted(base_paths | updated_paths):
        root = skill_root_for_file(path, roots)
        if root is None:
            continue

        current_content = (
            base_file_content(repo_root, args.base_ref, path) if path in base_paths else None
        )
        updated_content = (repo_root / path).read_bytes() if path in updated_paths else None
        if not all(is_utf8_text(content) for content in (current_content, updated_content) if content is not None):
            continue

        current_text = current_content.decode("utf-8") if current_content is not None else ""
        updated_text = updated_content.decode("utf-8") if updated_content is not None else ""
        deltas.append(
            TokenDelta(
                skill=root.name,
                file=path.relative_to(root).as_posix(),
                current=len(encoder.encode(current_text, disallowed_special=())),
                updated=len(encoder.encode(updated_text, disallowed_special=())),
            ),
        )

    report = render_report(deltas)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
    else:
        print(report, end="")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
