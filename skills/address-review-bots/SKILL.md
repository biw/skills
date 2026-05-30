---
name: address-review-bots
description: Close GitHub PR review-bot feedback loops for Claude, Devin, and similar AI reviewers after a push.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Address Review Bots

## Use When

Use this after creating or pushing to a PR when the user asks to wait for Claude, Devin, or similar review-bot feedback, address bot comments, or keep iterating until bot reviews are clean.

This complements local validation. It does not replace the target repository's normal pre-push or pre-merge checks.

## Core Loop

1. Confirm the current branch has a PR:

```bash
gh pr view --json number,url,headRefOid,headRefName
```

If no PR exists, stop and tell the user this skill needs an existing PR.

2. Record the review window immediately before or after pushing:

```bash
REVIEW_BOT_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

3. Wait for review-bot checks and snapshot fresh comments:

```bash
mkdir -p .context
node scripts/review-bot-snapshot.mjs \
  --wait \
  --since "$REVIEW_BOT_SINCE" \
  --json > .context/review-bot-snapshot.json
```

Run the bundled `scripts/review-bot-snapshot.mjs` from this skill directory. If the agent cannot execute relative to the skill directory, resolve the directory containing this `SKILL.md` first and pass the script path explicitly.

If you are starting from already-posted comments and did not capture a push timestamp, omit `--since`.

4. Classify each fresh bot comment:

- `valid_actionable`: the bot found a real issue that should be fixed before merge.
- `already_fixed_or_stale`: the finding is no longer present on the current head, or the comment points at an old head.
- `false_positive`: the bot's claim is wrong; gather concrete code evidence.
- `needs_user_decision`: the change is product/UX/architecture policy rather than an obvious correctness fix.
- `valid_low_risk_cleanup`: the bot found a real, bounded improvement that is not merge-blocking but is cheap, objective, and aligned with repo conventions.
- `non_actionable`: summaries, praise, progress updates, or "no issues" comments.

Do not treat "non-blocking", "nit", "none worth an inline change", or similar wording as automatically `non_actionable`. If the comment includes concrete code references, a plausible failure mode, a consistency issue, or a maintainability concern, inspect the referenced code and classify it on its merits.

Fix `valid_actionable` comments automatically. Also fix `valid_low_risk_cleanup` comments automatically when the change is tightly scoped and does not alter product, UX, architecture policy, or public behavior in a way that needs user judgment. Leave product, UX, and architecture tradeoffs for the user unless the decision is obvious from repo conventions.

Before moving on, make a compact classification table in your notes or final answer for every substantive bot observation:

```text
permalink | claim | classification | evidence | action taken / why not
```

5. Apply scoped fixes and nearby tests for valid actionable comments.

6. Self-review the delta, then verify with the repository's final validation command.

Choose the command from repo docs, package scripts, prior user instructions, or CI configuration. If the user has set `REVIEW_BOT_VALIDATION_COMMAND`, use that exactly. Otherwise prefer a comprehensive existing script such as `pnpm precommit`, `pnpm test`, `npm test`, `bun test`, or the repo's documented equivalent.

Use narrower checks while iterating, but do not commit or push review-bot fixes without a fresh final validation run after the last code change.

7. Commit and push if fixes were made:

```bash
git add <fixed-files>
git commit -m "fix: address review bot feedback"
git push
```

8. Repeat from step 2 until there are no fresh valid actionable or valid low-risk cleanup bot comments, remaining comments are stale/non-actionable/false positives/user decisions, or further changes would be speculative.

Default to at most 8 fix-push loops unless the user explicitly asks to keep going.

## Review Judgment

Treat review bots as input, not authority. A valid comment needs concrete evidence in code, tests, generated artifacts, or repo conventions. Before fixing or rejecting a substantive observation, inspect the referenced file and surrounding code.

Review bots may update an existing top-level summary comment instead of creating a fresh review comment. If a fresh bot status comment says a review summary was posted or updated, inspect that summary even when the snapshot lists it under stale comments because its original `createdAt` predates the current review window. In that case, use `updatedAt` and the status comment content to decide whether the summary needs classification.

For stale inline comments, compare the snapshot head SHA, comment commit ID, and current code.

When rejecting a comment, leave a short PR reply only when it helps future reviewers understand the decision. For inline comments, prefer replying in-thread if tooling supports it; otherwise, use a top-level PR comment with the permalink.

## Self-Review Before Push

After applying a review-bot fix and before committing or pushing, step back and review the changes as if another engineer made them. Do not assume the patch is correct because you wrote it.

Review the full `git diff`, every edited file, nearby call sites or tests, whether the fix addresses the underlying issue rather than only the bot's example, and whether it introduces new edge cases or test gaps.

The goal is not to consume all 8 loops. The goal is to push fixes that review bots and CI do not need to correct again.

If a fresh valid actionable bot finding appears after a push, deepen the next self-review: focused diff review first, then related files/tests, then module-level assumptions and failure modes if misses continue. Repeated misses mean the local review is missing context; slow down and inspect the broader subsystem before pushing again.

## Waiting Rules

Be selective about waiting for GitHub. This skill is for PR review automation after a push; for normal implementation work, the repository's local validation command is usually the faster gate. The helper waits for review-like checks matching Claude, Devin, or review patterns and should not block indefinitely on unrelated CI.

## Helper Script

Use `scripts/review-bot-snapshot.mjs` rather than rewriting GitHub API commands. Default bots are Claude and Devin; override with `--bot-logins` or `REVIEW_BOT_LOGINS` if needed.

Common options:

```bash
node scripts/review-bot-snapshot.mjs --help
node scripts/review-bot-snapshot.mjs --wait
node scripts/review-bot-snapshot.mjs --wait --json
node scripts/review-bot-snapshot.mjs --pr 123 --bot-logins "claude[bot],devin-ai-integration[bot]"
```

## Final Response

Report:

- how many review-bot loops ran,
- which bot comments were fixed,
- which comments were rejected or left for user decision, with permalinks,
- the classification and rationale for every substantive bot observation,
- the commit SHA(s) pushed,
- the final validation command and result.

If no valid comments remain, say that directly only after classifying each substantive observation. If review checks timed out, say what was checked and what is still unknown.
