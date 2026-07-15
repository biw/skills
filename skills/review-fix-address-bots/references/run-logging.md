# Review Run Logging

Write one append-only JSONL file per skill run under:

```text
${CODEX_HOME:-~/.codex}/log/review-fix-address-bots/YYYY/MM/DD/
```

This mirrors Codex's session date layout while keeping repository identity inside each run. The default `~/.codex/log/` directory is runtime state and should remain ignored by any repository containing `CODEX_HOME`.

## Start and Events

Resolve the directory containing the skill's `SKILL.md`, then start the log before review work:

```bash
node scripts/review-run-log.mjs start \
  --repo-root "$PWD" \
  --data-json '{"requestedReviewerCount":5,"reviewerCohortRequested":[{"model":"gpt-5.6-sol","count":1},{"model":"gpt-5.6-terra","count":2},{"model":"gpt-5.6-luna","count":2}],"reasoningRequested":"high","remediationRoundLimit":3,"reviewBotLoopLimit":8}'
```

Keep the returned `logPath` in `.context`. Append an event immediately after each reviewer pass so partial runs remain useful if later work stops:

```bash
node scripts/review-run-log.mjs append \
  --log "$REVIEW_RUN_LOG" \
  --event reviewer_pass_completed \
  --data-file .context/reviewer-pass.json
```

Useful events include `target_integrated`, `reviewer_session_started`, `reviewer_pass_completed`, `reviewer_continuity_verified`, `finding_classified`, `validation_completed`, `push_completed`, `review_bot_loop_completed`, and `run_blocked`. Events may evolve; keep names lower snake case.

Record experimental inputs when they become known: custom-versus-bundled review prompt source and SHA-256 fingerprint, target/base/head SHAs, diff size, the requested five-reviewer model cohort, round limits, requested reasoning, launch mechanisms, retries, and relevant skill options. The helper fingerprints the skill instructions and logger automatically. Hash custom prompts instead of storing their contents.

For every reviewer pass, record:

- stable `reviewerId`, phase (`initial` or `remediation`), and one-based round,
- invocation start/completion order, launch mechanism, and session identifier when available,
- requested and actually applied model and reasoning level separately,
- continuity-handshake result for every persistent session,
- stable deduplicated `findingIds` once available,
- whether the pass found any issue and whether findings were new, repeated, or overlapping,
- actual token usage when the runtime exposes it; otherwise use `null`, never an estimate,
- duration when observable and any failure or retry.

Do not log full prompts, full review bodies, code contents, credentials, environment variables, or auth material. Finding IDs and concise summaries are enough for later analysis.

## Finish Schema

Always attempt `finish`, including for blocked or failed runs. Pass a summary with this shape:

```json
{
  "status": "complete",
  "reviewers": [
    {
      "reviewerId": "sol-1",
      "launchMechanism": "native",
      "sessionId": "opaque-session-id",
      "modelRequested": "gpt-5.6-sol",
      "modelApplied": "gpt-5.6-sol",
      "reasoningRequested": "high",
      "reasoningApplied": "high",
      "continuityVerified": true,
      "continuityChecks": [
        {
          "round": 1,
          "verified": true,
          "tokenUsage": null
        }
      ],
      "rounds": [
        {
          "phase": "initial",
          "round": 1,
          "findingIds": ["F1"],
          "tokenUsage": null
        }
      ]
    }
  ],
  "findings": [
    {
      "findingId": "F1",
      "classification": "valid",
      "reportedBy": ["sol-1"],
      "action": "fixed"
    }
  ],
  "githubReviewBots": [{ "login": "claude[bot]", "model": null, "findingIds": ["B1"] }],
  "reviewBotLoopCount": 1
}
```

Include one reviewer object for each of `sol-1`, `terra-1`, `terra-2`, `luna-1`, and `luna-2`, even when a reviewer found no issues. Preserve applied model fields so comparisons reflect what actually ran rather than what was merely requested; leave an unavailable `modelApplied` unset so the helper groups it as `unknown`. Record every continuity attempt in `continuityChecks`, including retries and `tokenUsage: null` when the runtime exposes no accounting.

```bash
node scripts/review-run-log.mjs finish \
  --log "$REVIEW_RUN_LOG" \
  --data-file .context/review-run-summary.json
```

The helper derives reviewer session and invocation counts, continuity-invocation counts, rounds per reviewer, initial and cumulative unique findings, pairwise shared/unique finding IDs with Jaccard overlap, reviewers that found issues, GitHub bot counts, and token totals with per-field coverage. Invocation and cumulative token metrics include both review rounds and continuity checks; initial token metrics remain limited to the initial review pass. The helper also groups reviewers only by applied model and derives initial finding classifications, valid and model-unique valid finding IDs, and cross-model overlap. Record a GitHub bot's model/version only when GitHub exposes it; otherwise use `null`. Preserve the raw reviewer/round/continuity/finding arrays so future analyses can compute different metrics without changing old logs. Treat these metrics as observations from one run, not a general model ranking.

If logging fails, do not hide the failure or fabricate a record. Report it, but do not let telemetry failure cause unsafe Git, PR, or code mutations.
