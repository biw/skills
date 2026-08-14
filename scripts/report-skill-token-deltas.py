#!/usr/bin/env python3
"""Report token changes from applying Oxfmt to every text file in each skill."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
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
        "--repo-root",
        type=Path,
        default=Path.cwd(),
        help="Repository root containing skills/ and node_modules/ (default: current directory).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Write the Markdown report to this path instead of standard output.",
    )
    return parser.parse_args()


def find_skill_roots(skills_directory: Path) -> list[Path]:
    return sorted(skill_file.parent for skill_file in skills_directory.rglob("SKILL.md"))


def find_text_files(skill_root: Path) -> list[Path]:
    files = []
    for candidate in skill_root.rglob("*"):
        if not candidate.is_file() or any(part in IGNORED_DIRECTORY_NAMES for part in candidate.parts):
            continue

        content = candidate.read_bytes()
        if b"\0" in content:
            continue

        try:
            content.decode("utf-8")
        except UnicodeDecodeError:
            continue

        files.append(candidate)

    return sorted(files)


def formatter_path(repo_root: Path) -> Path:
    executable = "oxfmt.cmd" if os.name == "nt" else "oxfmt"
    formatter = repo_root / "node_modules" / ".bin" / executable
    if not formatter.is_file():
        raise FileNotFoundError(
            f"Could not find {formatter}. Run pnpm install before generating the token report.",
        )

    return formatter


def format_skills_copy(repo_root: Path, skills_directory: Path) -> Path:
    temporary_root = Path(tempfile.mkdtemp(prefix="skill-token-deltas-"))
    formatted_skills = temporary_root / "skills"
    shutil.copytree(skills_directory, formatted_skills)

    config = repo_root / ".oxfmtrc.json"
    if config.is_file():
        shutil.copy2(config, temporary_root / config.name)

    result = subprocess.run(
        [str(formatter_path(repo_root)), "--write", str(formatted_skills)],
        cwd=repo_root,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        shutil.rmtree(temporary_root)
        raise RuntimeError(f"Oxfmt failed:\n{result.stderr or result.stdout}")

    return temporary_root


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

    skill_roots = find_skill_roots(skills_directory)
    if not skill_roots:
        raise RuntimeError(f"No SKILL.md files found under {skills_directory}.")

    encoder = tiktoken.get_encoding(TOKEN_ENCODING)
    temporary_root = format_skills_copy(repo_root, skills_directory)
    deltas: list[TokenDelta] = []

    try:
        for skill_root in skill_roots:
            for current_file in find_text_files(skill_root):
                relative_file = current_file.relative_to(skill_root)
                updated_file = temporary_root / "skills" / current_file.relative_to(skills_directory)
                current_content = current_file.read_text(encoding="utf-8")
                updated_content = updated_file.read_text(encoding="utf-8")
                deltas.append(
                    TokenDelta(
                        skill=skill_root.name,
                        file=relative_file.as_posix(),
                        current=len(encoder.encode(current_content, disallowed_special=())),
                        updated=len(encoder.encode(updated_content, disallowed_special=())),
                    ),
                )
    finally:
        shutil.rmtree(temporary_root)

    report = render_report(deltas)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report, encoding="utf-8")
    else:
        print(report, end="")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
