import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const renderer = join(repoRoot, "skills/setup-cloudflare-pr-previews/scripts/render_templates.py");

test("renders flattened-config deploy commands and records history after upload", () => {
  const output = mkdtempSync(join(tmpdir(), "cloudflare-preview-"));

  try {
    execFileSync("python3", [renderer, "--app-name", "example-app", "--output", output]);

    const deployPath = join(output, "scripts/deploy.sh");
    const deploy = readFileSync(deployPath, "utf8");

    assert.match(deploy, /wrangler d1 migrations apply[^\n]+--env "\$WRANGLER_ENV" --remote/);
    assert.doesNotMatch(deploy, /wrangler deploy[^\n]+--env/);
    assert.doesNotMatch(deploy, /wrangler versions upload[^\n]+--env/);

    const firstDeploy = deploy.indexOf("pnpm wrangler deploy --config");
    const versionUpload = deploy.indexOf("pnpm wrangler versions upload --config");
    const historyInsert = deploy.indexOf("INSERT INTO deployment_history");
    assert.ok(firstDeploy >= 0);
    assert.ok(versionUpload >= 0);
    assert.ok(historyInsert > firstDeploy);
    assert.ok(historyInsert > versionUpload);

    for (const script of ["cleanup-preview-db.sh", "deploy.sh", "resolve-cloudflare-env.sh"]) {
      execFileSync("bash", ["-n", join(output, "scripts", script)]);
    }
  } finally {
    rmSync(output, { force: true, recursive: true });
  }
});
