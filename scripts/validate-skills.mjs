#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

const root = process.cwd();
const ignoredDirectories = new Set([
  ".context",
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

const allowedSkillRoots = [
  ["skills"],
  ["skills", ".curated"],
  ["skills", ".experimental"],
  ["skills", ".system"],
];

const namePattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const errors = [];
const warnings = [];
const skills = [];
const seenNames = new Map();
const maxDescriptionLength = 200;

function relative(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isInsideAllowedSkillRoot(filePath) {
  const parts = relative(filePath).split("/");
  return allowedSkillRoots.some((rootParts) => {
    if (parts.length !== rootParts.length + 2) {
      return false;
    }

    return rootParts.every((part, index) => parts[index] === part) && parts.at(-1) === "SKILL.md";
  });
}

async function findSkillFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await findSkillFiles(fullPath);
        }

        return;
      }

      if (entry.isFile() && entry.name === "SKILL.md") {
        skills.push(fullPath);
      }
    }),
  );
}

function parseFrontmatter(content, filePath) {
  const displayPath = relative(filePath);

  if (!content.startsWith("---\n")) {
    errors.push(`${displayPath}: SKILL.md must start with YAML frontmatter.`);
    return null;
  }

  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    errors.push(`${displayPath}: missing closing YAML frontmatter marker.`);
    return null;
  }

  const frontmatter = content.slice(4, end);
  try {
    const parsed = YAML.parse(frontmatter);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`${displayPath}: frontmatter must be a YAML mapping.`);
      return null;
    }

    return parsed;
  } catch (error) {
    errors.push(`${displayPath}: invalid YAML frontmatter: ${error.message}`);
    return null;
  }
}

function validateSkill(filePath, metadata) {
  const displayPath = relative(filePath);
  const parentName = path.basename(path.dirname(filePath));

  if (!isInsideAllowedSkillRoot(filePath)) {
    errors.push(
      `${displayPath}: installable skills must live at skills/<name>/SKILL.md or skills/.curated|.experimental|.system/<name>/SKILL.md.`,
    );
  }

  if (typeof metadata.name !== "string" || metadata.name.trim() === "") {
    errors.push(`${displayPath}: frontmatter.name is required.`);
  } else {
    if (metadata.name !== parentName) {
      errors.push(`${displayPath}: frontmatter.name must match parent folder "${parentName}".`);
    }

    if (!namePattern.test(metadata.name) || metadata.name.includes("--")) {
      errors.push(
        `${displayPath}: frontmatter.name must be 1-64 lowercase letters, numbers, and hyphens, with no leading, trailing, or repeated hyphens.`,
      );
    }

    const previousPath = seenNames.get(metadata.name);
    if (previousPath) {
      errors.push(`${displayPath}: duplicate skill name also declared in ${previousPath}.`);
    } else {
      seenNames.set(metadata.name, displayPath);
    }
  }

  if (typeof metadata.description !== "string" || metadata.description.trim() === "") {
    errors.push(`${displayPath}: frontmatter.description is required.`);
  } else if (metadata.description.length > maxDescriptionLength) {
    errors.push(
      `${displayPath}: frontmatter.description must be ${maxDescriptionLength} characters or fewer for Claude.ai compatibility.`,
    );
  } else if (metadata.description.length < 40) {
    warnings.push(`${displayPath}: description is very short; include what the skill does and when to use it.`);
  }

  if (metadata.compatibility !== undefined) {
    if (typeof metadata.compatibility !== "string" || metadata.compatibility.trim() === "") {
      errors.push(`${displayPath}: compatibility must be a non-empty string when present.`);
    } else if (metadata.compatibility.length > 500) {
      errors.push(`${displayPath}: compatibility must be 500 characters or fewer.`);
    }
  }

  if (metadata.license !== undefined && typeof metadata.license !== "string") {
    errors.push(`${displayPath}: license must be a string when present.`);
  }

  if (
    metadata.metadata !== undefined &&
    (!metadata.metadata || typeof metadata.metadata !== "object" || Array.isArray(metadata.metadata))
  ) {
    errors.push(`${displayPath}: metadata must be a YAML mapping when present.`);
  }

  if (metadata["allowed-tools"] !== undefined && typeof metadata["allowed-tools"] !== "string") {
    errors.push(`${displayPath}: allowed-tools must be a string when present.`);
  }
}

async function ensureDirectoryExists(directory) {
  try {
    const directoryStat = await stat(directory);
    return directoryStat.isDirectory();
  } catch {
    return false;
  }
}

if (!(await ensureDirectoryExists(path.join(root, "skills")))) {
  errors.push("skills/: missing canonical skills directory.");
} else {
  await findSkillFiles(root);
}

for (const skillPath of skills.sort()) {
  const content = await readFile(skillPath, "utf8");
  const metadata = parseFrontmatter(content, skillPath);

  if (metadata) {
    validateSkill(skillPath, metadata);
  }
}

for (const warning of warnings) {
  console.warn(`Warning: ${warning}`);
}

if (errors.length > 0) {
  console.error("Skill validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (skills.length === 0) {
  console.log("No skills found yet. Add installable skills under skills/<name>/SKILL.md.");
} else {
  console.log(`Validated ${skills.length} skill${skills.length === 1 ? "" : "s"}.`);
}
