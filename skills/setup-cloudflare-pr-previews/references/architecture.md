# Cloudflare PR Preview Architecture

## Contents

1. [Scope and topology](#scope-and-topology)
2. [Lifecycle](#lifecycle)
3. [Environment resolution](#environment-resolution)
4. [Resource naming](#resource-naming)
5. [D1 provisioning and migrations](#d1-provisioning-and-migrations)
6. [Worker upload modes](#worker-upload-modes)
7. [Cleanup trust boundary](#cleanup-trust-boundary)
8. [Shared resources](#shared-resources)
9. [Target repository integration](#target-repository-integration)
10. [Cloudflare and GitHub configuration](#cloudflare-and-github-configuration)

## Scope and Topology

The topology uses two stable Worker projects backed by three classes of D1 database:

```text
production Worker <app>
└── stable D1 <app>-production

preview Worker <app>-staging
├── stable preview D1 <app>-staging
└── branch version alias <branch-alias>
    └── ephemeral D1 <app>-preview-<sanitized-branch>
```

The branch environment is an uploaded version of the preview Worker, not a separately named Worker. `wrangler versions upload --preview-alias` maps a readable alias to the new version and produces a URL shaped like:

```text
https://<alias>-<preview-worker>.<account-subdomain>.workers.dev
```

This gives each branch independent code, runtime URL variables, and D1 state while reusing the stable preview Worker as the version container.

## Lifecycle

### Production branch on the production project

1. Workers Builds exports `CLOUDFLARE_ENV=production`.
2. The bundle selects the production Wrangler environment.
3. Deployment resolves `<app>-production` by name and fails if it does not exist.
4. Deployment applies pending migrations through a temporary config containing the real database ID.
5. Deployment patches the built Worker config with the same ID.
6. Deployment records branch/build/commit metadata.
7. `wrangler deploy --env production` updates the stable production Worker.

### Production branch on the preview project

1. Workers Builds exports `CLOUDFLARE_ENV=preview`.
2. Deployment selects the stable preview URL and `<app>-staging` database.
3. Deployment creates the database if missing, then migrates and verifies it.
4. `wrangler deploy --env preview` updates the stable preview Worker.

### Non-production branch on the preview project

1. Workers Builds exports `CLOUDFLARE_ENV=preview` and `WORKERS_CI_BRANCH`.
2. Deployment derives a bounded alias and D1 name from the branch.
3. Deployment creates or reuses the D1 database and applies migrations.
4. Deployment derives the alias URL from the stable preview `workers.dev` hostname.
5. Deployment patches URL-dependent runtime variables and the D1 binding.
6. `wrangler versions upload --env preview --preview-alias <alias>` updates the branch preview.

### Pull request close

1. GitHub receives `pull_request_target: closed`.
2. The workflow checks out the PR base branch.
3. Trusted cleanup code derives the database name from `pull_request.head.ref`.
4. Cleanup skips protected branches, no-ops if the database is absent, and deletes the matching branch database otherwise.

This lifecycle does not delete the uploaded Worker version or shared preview bindings. Cloudflare retains version history; a later upload with the same alias repoints that alias.

Cloudflare currently does not generate preview URLs for Workers that implement Durable Objects, and preview URL logs are not available through Workers Logs, Wrangler tail, or Logpush. Treat either limitation as an architecture blocker rather than discovering it after rollout.

## Environment Resolution

Use this precedence:

1. explicit `CLOUDFLARE_ENV`;
2. known Worker/project name;
3. an unambiguous production-only or preview-only URL override;
4. CI branch/build presence (`main`/`master` becomes production, other branches preview);
5. local `development` fallback.

Explicit environment configuration is essential. The same production branch is built once for the production project and once for the stable preview project, so branch name alone cannot distinguish those builds.

Cloudflare Workers Builds supplies `WORKERS_CI`, `WORKERS_CI_BRANCH`, `WORKERS_CI_COMMIT_SHA`, and `WORKERS_CI_BUILD_UUID`. Pages variables can remain as compatibility fallbacks but should not be the primary contract for Workers Builds.

## Resource Naming

Database names use a shared shell function imported by deploy and cleanup:

```text
<app>-preview-<sanitized-branch>
```

The database sanitizer lowercases, maps `/` to `-`, maps `.` to `_`, replaces other invalid runs with `-`, collapses repeated separators, trims outer hyphens, falls back to `preview`, and truncates the final database name to 64 characters.

Preview aliases have a different constraint. Lowercase the branch, replace every non-alphanumeric/hyphen run with `-`, collapse and trim hyphens, ensure the alias begins with a letter, and cap its length so `<alias>-<worker-name>` remains at most 63 characters.

Because truncation can collide, this pattern assumes branch names are unique within the repository and generally differ near the beginning. For repositories with untrusted forks or many long, similarly-prefixed branches, use a stable hash or PR number in both deploy and cleanup. Changing this identity scheme is a product decision, not a mechanical refactor.

## D1 Provisioning and Migrations

Keep committed D1 `database_id` values as placeholders. At deployment:

1. List remote D1 databases and select the exact database name.
2. For production, fail when absent.
3. For preview, create when absent and list again to obtain the UUID.
4. Copy `wrangler.jsonc` to a temporary, ignored config.
5. Patch the matching D1 binding's name and UUID under the selected environment.
6. Run `wrangler d1 migrations apply <binding> --config <temp> --env <env> --remote`.
7. Query `sqlite_master` to verify `deployment_history` exists.
8. Patch the framework-emitted deploy config at its top-level matching D1 binding.

Use Wrangler's migration ledger instead of executing every SQL file directly. Require at least one migration file so an empty or misconfigured migration directory fails early.

The deployment-history table is operational evidence that the correct database was migrated and used. Keep branch, UTC deployment timestamp, build ID, and commit SHA. If the target repository already has equivalent durable deployment records, adapt verification and insertion instead of creating a duplicate table.

## Worker Upload Modes

Use stable deploys for the two long-lived endpoints:

```bash
pnpm wrangler deploy --config <built-config> --env production
pnpm wrangler deploy --config <built-config> --env preview
```

Use a version upload for branch previews:

```bash
pnpm wrangler versions upload \
  --config <built-config> \
  --env preview \
  --preview-alias <alias>
```

Set `preview_urls: true`. Every runtime variable whose value depends on the public origin must be supplied to the upload command. Do not pass secrets as `--var`; configure Worker secrets per environment.

## Cleanup Trust Boundary

`pull_request_target` has access to base-repository secrets even for fork PRs. Its safety comes from running only trusted base-branch code:

- trigger only on PR close;
- use minimal `contents: read` GitHub permissions;
- check out `github.event.pull_request.base.ref`;
- never check out the head SHA;
- never execute scripts or dependency changes from the PR head;
- install from the base branch lockfile;
- pass only the head branch name as data;
- keep the deletion function narrowly scoped to the derived D1 name.

Missing credentials or Cloudflare list failures must fail visibly. An already-absent database is the only expected cleanup no-op besides protected branches.

## Shared Resources

D1 should be isolated by default. Staging R2 buckets may be shared when data is safely partitioned and branch databases hold the references, but that decision is application-specific.

For every binding, classify it:

| Class | Examples | Branch behavior |
| --- | --- | --- |
| Isolated mutable state | D1, write-heavy KV, queues with branch-specific consumers | Provision and delete per branch |
| Deliberately shared state | shared staging R2, immutable fixtures | Bind stable preview resource and never delete during PR cleanup |
| Production-only | production D1/R2/KV/secrets | Bind only in production |
| External/irreversible | email, payment webhooks, third-party callbacks | Disable, sandbox, or explicitly scope for preview |

Document every shared mutable resource. “Standalone preview” means isolated only to the extent this table proves.

## Target Repository Integration

The renderer produces reference files, not a repository-wide merge. Integrate these surfaces:

- `wrangler.jsonc`: environments, preview URLs, placeholder D1 bindings, shared/stable bindings, URLs.
- build config: select `CLOUDFLARE_ENV` before resolving Wrangler config and bake public client variables correctly.
- `package.json`: bundle, dynamic deploy, cleanup, local migration, and type generation scripts.
- migration system: add `deployment_history` using the repository's migration naming rules.
- Prisma, when present: keep `prisma.config.ts`, `schema.prisma`, the generated client, and the Wrangler `migrations_dir` consistent; use the D1 adapter at runtime and apply migrations before deploying code that depends on them.
- `.gitignore`: ignore temporary Wrangler configs, build output, `.context`, `.dev.vars*`, and local `.wrangler` state as appropriate.
- GitHub Actions: add the trusted PR-close cleanup workflow.
- deployment documentation: describe dashboard setup and ownership.

If the target bundler does not emit a deployable Wrangler config, point deployment at the actual built artifact or adapt the script to use source config. Never assume `dist/server/wrangler.json` without checking a real build.

## Cloudflare and GitHub Configuration

Connect the same repository to two Workers Builds projects:

| Project | Build variable | Branch policy |
| --- | --- | --- |
| `<app>` | `CLOUDFLARE_ENV=production` | Production branch only |
| `<app>-staging` | `CLOUDFLARE_ENV=preview` | Production branch plus non-production branches |

Use the repository's bundle command as the build command and dynamic deploy script as the deploy command. Workers Builds now has a separate non-production branch deploy command; set that to the same dynamic deploy script on the preview project. Leaving its default `wrangler versions upload` command would skip database creation, migrations, binding patching, and URL overrides. Create stable D1 databases and any stable buckets once. Configure runtime secrets separately for preview and production.

The Workers Builds token must include Account D1 Edit in addition to the permissions needed to upload the Worker because the deploy script lists, creates, migrates, and queries D1. Cloudflare's automatically-created Workers Builds token permission set may not include D1, so verify the selected token explicitly in each project.

Preview URLs are public when enabled unless Cloudflare Access protects them. Decide and document an Access policy before treating previews as safe for sensitive test data.

In GitHub, configure:

- repository variable `CLOUDFLARE_ACCOUNT_ID`;
- repository secret `CLOUDFLARE_API_TOKEN` with Account D1 Edit, scoped to the target account, so cleanup can list and delete D1 databases.

Current primary documentation:

- Cloudflare preview URLs: <https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/>
- Workers Builds configuration and variables: <https://developers.cloudflare.com/workers/ci-cd/builds/configuration/>
- Wrangler environments and non-inheritable bindings: <https://developers.cloudflare.com/workers/wrangler/environments/>
- D1 Wrangler commands: <https://developers.cloudflare.com/d1/wrangler-commands/>
