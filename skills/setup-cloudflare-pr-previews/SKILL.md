---
name: setup-cloudflare-pr-previews
description: Set up, audit, or repair Cloudflare Workers PR previews with aliased URLs, branch-isolated D1 databases, migrations, binding injection, stable environments, and PR-close cleanup.
---

# Set Up Cloudflare PR Previews

Create a reusable deployment topology while adapting names, build output, migrations, runtime URL variables, and explicitly shared resources to the target project.

## Start With the Contract

1. Inspect repository instructions, `package.json`, lockfiles, `wrangler.jsonc`, build configuration, generated Worker output, migration layout, existing CI, and deployment documentation. When present, also inspect Better Auth environment handling and Prisma schema/configuration.
2. Read `references/architecture.md` completely before changing files.
3. If the repository uses `@cloudflare/vite-plugin`, also read `references/vite-plugin-integration.md` completely.
4. Identify these values before rendering templates:
   - application/resource prefix;
   - production and preview Worker names;
   - production branch or branches;
   - D1 binding and migrations directory;
   - deployable built Wrangler config path;
   - stable production and preview URLs;
   - every runtime variable that must equal the active deployment URL;
   - resources isolated per branch versus deliberately shared.
5. Run the bundled renderer into a scratch directory, never over the repository:

```bash
python3 <skill-dir>/scripts/render_templates.py \
  --app-name <app> \
  --preview-worker-name <app-staging> \
  --d1-binding DB \
  --migrations-dir prisma/migrations \
  --built-config dist/wrangler.json \
  --url-var BETTER_AUTH_URL \
  --url-var VITE_SITE_URL \
  --output .context/cloudflare-pr-previews
```

6. Integrate the rendered files deliberately. Preserve existing target-repository behavior and use the target package manager. Do not blindly replace existing Wrangler, package, build, migration, or workflow files.

## Required Topology

Maintain three deployment modes:

| Trigger | Worker action | D1 database | URL |
| --- | --- | --- | --- |
| Production branch on production build | Deploy stable production | `<app>-production` | Stable production URL |
| Production branch on preview build | Deploy stable preview | `<app>-staging` | Stable preview URL |
| Non-production branch on preview build | Upload aliased version | `<app>-preview-<sanitized-branch>` | `<alias>-<preview-worker>.<workers-domain>` |

Treat this as branch-scoped PR isolation. Two PRs built from the same branch name intentionally resolve to the same database and alias. If fork collisions or multiple PRs from one branch are possible, stop and agree on a PR-number or repository-qualified identity before changing the naming contract.

## Implement in Order

### 1. Configure Wrangler environments

- Keep `development`, `preview`, and `production` environments explicit.
- Repeat non-inheritable `vars` and bindings in every environment.
- Set `preview_urls: true`.
- Use placeholder D1 IDs in committed config; resolve and inject real IDs only during deploy.
- Point the preview environment at the stable preview Worker and shared preview resources.
- Point production at production-only resources.
- Share R2, KV, queues, or other mutable resources across branch previews only after confirming that cross-branch data sharing is safe. Isolate D1 by default and document every intentionally shared binding.

### 2. Select the environment before bundling

- Make the build command call `resolve-cloudflare-env.sh` and export the result as `CLOUDFLARE_ENV`.
- Give an explicit `CLOUDFLARE_ENV=production` or `preview` to each Workers Builds project. Do not rely on `main` alone because the same branch deploys both stable Workers.
- Preserve Workers Builds variables (`WORKERS_CI_BRANCH`, `WORKERS_CI_COMMIT_SHA`, `WORKERS_CI_BUILD_UUID`) and only retain Pages fallbacks when the repository still needs them.

### 3. Provision and deploy

- Resolve D1 by exact name and patch a temporary source config for migration commands.
- Never write remote database IDs back into committed `wrangler.jsonc`.
- Require the production database to exist already.
- Create or reuse stable-preview and branch-preview databases idempotently.
- Apply every pending migration and verify the deployment-history table before upload.
- Patch the framework-generated deploy config by binding name. Patching only the source config is insufficient when the bundler emits a deploy config.
- Override all URL-dependent runtime variables on the Wrangler command so auth callbacks, WebAuthn origins, CORS, and client URLs match the aliased hostname.
- For Better Auth, set `BETTER_AUTH_URL` to the exact stable or aliased deployment origin and keep its secret in Worker secrets.
- For Prisma with D1, keep `prisma/migrations` aligned with `migrations_dir`, apply migrations before upload, and generate the client through the project's normal install/build workflow.
- Use `wrangler deploy` for stable deployments and `wrangler versions upload --preview-alias` for branch previews.

### 4. Tear down safely

- Use `pull_request_target` with only the `closed` event.
- Check out the base branch and run the cleanup script from trusted base-branch code. Never check out or execute the PR head in this privileged workflow.
- Derive the D1 name with the exact same shared naming function used at deploy time.
- Make missing databases a successful no-op and protect `main`/`master` from deletion.
- Require `CLOUDFLARE_ACCOUNT_ID` as a repository variable and `CLOUDFLARE_API_TOKEN` as a secret with D1 list/delete access.
- Delete only resources owned by this lifecycle. Delete the branch D1 database, but do not delete shared resources or Worker version history.

### 5. Document dashboard setup

Document both Workers Builds projects, build/deploy commands, branch policies, stable resource bootstrap commands, required secrets/variables, runtime secrets, shared-resource decisions, manual cleanup, and rollback expectations. On the preview project, set both the production-branch deploy command and the separate non-production branch deploy command to the dynamic deploy script; Cloudflare's default non-production command bypasses D1 provisioning. Adapt the rendered `CLOUDFLARE_SETUP.md` instead of adding a second competing deployment guide.

Decide whether branch preview URLs may be public. Cloudflare preview URLs are public when enabled unless protected with Cloudflare Access; application login alone is not the same network boundary.

## Verification

Run checks that do not mutate Cloudflare first:

```bash
bash -n scripts/resolve-cloudflare-env.sh
bash -n scripts/preview-resources.sh
bash -n scripts/deploy.sh
bash -n scripts/cleanup-preview-db.sh
```

Then verify all of the following:

- explicit environment overrides win during resolution;
- local builds resolve to `development`;
- a non-production branch on the preview project resolves to `preview`;
- both stable builds on the production branch resolve correctly because each project sets `CLOUDFLARE_ENV`;
- database and alias sanitizers are deterministic, bounded, and identical between provision and cleanup;
- the generated deploy config exists at the configured path after a bundle;
- D1 patching targets the configured binding rather than whichever binding appears first;
- the migration framework accepts the deployment-history migration;
- package scripts, workflow package-manager setup, and lockfile agree;
- secrets are not present in diffs or command arguments.

If credentials and authorization are available, finish with one real non-production preview deployment, redeploy the same branch to prove reuse, then run manual cleanup for that test branch and confirm a second cleanup is a no-op. Do not exercise production merely to validate the setup.

## Guardrails

- Do not auto-create production databases or production buckets.
- Do not delete stable preview or production resources.
- Do not expose secrets through `--var`, source config, logs, or committed dotenv files.
- Do not use a preview URL derived from a custom hostname; aliased Worker preview URLs require the preview Worker's `workers.dev` host shape.
- Do not use this preview-URL topology for Workers that implement Durable Objects; Cloudflare does not currently generate Worker preview URLs for them.
- Do not feed commented JSONC to generated `jq` patch steps. Keep `wrangler.jsonc` JSON-compatible or replace those steps with a JSONC-aware parser.
- Do not claim full per-PR isolation when any mutable binding is shared; list shared bindings explicitly.
- Do not treat a successful database migration as a successful Worker upload. Preserve actionable failures for both phases.
- Do not silently ignore D1 list/authentication failures in newly authored scripts.
- Do not add GitHub Actions write permissions; cleanup needs only repository read access plus Cloudflare credentials.

## Resources

- `references/architecture.md`: lifecycle, trust boundary, naming, provisioning, and dashboard model.
- `references/vite-plugin-integration.md`: dual-config patching and build-time/runtime URL handling.
- `scripts/render_templates.py`: render parameterized orchestration files into a scratch directory.
- `assets/*.tmpl`: source templates copied by the renderer; integrate them rather than editing the skill in place.
