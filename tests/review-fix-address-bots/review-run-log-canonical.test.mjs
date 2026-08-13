import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  appendEvent,
  canonicalSummaryFromEvents,
  collectCodexCliSessionResult,
  collectCodexSessionUsage,
  diagnoseCodexUsage,
  finishRun,
  inspectCodexCliReviewerSession,
  inspectCodexNativeReviewerSession,
  inspectReviewerSessions,
  launchCodexCliReviewer,
  recoverCodexCliReviewerResult,
  renderUsageTable,
  startRun,
  validateFinishSummary,
} from "../../skills/review-fix-address-bots/scripts/review-run-log.mjs";

const reviewerStart = (reviewerId, model) => ({
  event: "reviewer_session_started",
  data: {
    launchMechanism: "native",
    modelApplied: model,
    modelRequested: model,
    reasoningApplied: "high",
    reasoningRequested: "high",
    reviewerId,
    sessionId: `/root/${reviewerId.replace("-", "_")}`,
  },
});

test("reconstructs canonical reviewer records from the append-only event ledger", () => {
  const events = [
    reviewerStart("sol-1", "gpt-5.6-sol"),
    reviewerStart("terra-1", "gpt-5.6-terra"),
    reviewerStart("luna-1", "gpt-5.6-luna"),
    {
      event: "reviewer_pass_completed",
      data: { durationMs: 1_500, finding_ids: ["F1"], reviewer: "sol-1", round: 1 },
    },
    {
      event: "remediation_reviewer_pass_completed",
      data: { findingIds: [], reviewerId: "sol-1", round: 1 },
    },
    {
      event: "reviewer_continuity_verified",
      data: { durationMs: 300, reviewer: "sol-1", round: 1 },
    },
  ];
  const summary = {
    reviewers: [
      { id: "sol-1", model: "gpt-5.6-sol", reasoning: "high" },
      { id: "terra-1", model: "gpt-5.6-terra", reasoning: "high" },
      { id: "luna-1", model: "gpt-5.6-luna", reasoning: "high" },
    ],
  };

  const canonical = canonicalSummaryFromEvents(events, summary);
  const sol = canonical.reviewers.find((reviewer) => reviewer.reviewerId === "sol-1");

  assert.deepEqual(sol?.rounds, [
    { durationMs: 1_500, findingIds: ["F1"], phase: "initial", round: 1, tokenUsage: null },
    { findingIds: [], phase: "remediation", round: 1, tokenUsage: null },
  ]);
  assert.deepEqual(sol?.continuityChecks, [
    { durationMs: 300, round: 1, tokenUsage: null, verified: true },
  ]);
  assert.equal(sol?.modelApplied, "gpt-5.6-sol");
  assert.equal(sol?.reasoningApplied, "high");

  assert.throws(() => validateFinishSummary(canonical), /has no recorded review rounds/);
});

test("retains an exact native cancellation in the canonical reviewer record", () => {
  const canonical = canonicalSummaryFromEvents(
    [
      reviewerStart("sol-1", "gpt-5.6-sol"),
      {
        event: "reviewer_session_cancelled",
        data: {
          deadlineMs: 1_200_000,
          phase: "initial",
          reason: "native reviewer exceeded the hard deadline",
          reviewerId: "sol-1",
          sessionId: "/root/sol_1",
        },
      },
    ],
    { reviewers: [] },
  );

  assert.deepEqual(canonical.reviewers, [
    {
      continuityChecks: [],
      failure: { phase: "initial", reason: "native reviewer exceeded the hard deadline" },
      launchMechanism: "native",
      modelApplied: "gpt-5.6-sol",
      modelRequested: "gpt-5.6-sol",
      reasoningApplied: "high",
      reasoningRequested: "high",
      reviewerId: "sol-1",
      rounds: [],
      sessionId: "/root/sol_1",
      sessionLifecycle: "cancelled",
    },
  ]);
});

test("collectCodexUsage enriches the ledger-canonicalized reviewer records", () => {
  const root = mkdtempSync(join(tmpdir(), "review-run-log-"));
  const repoRoot = process.cwd();
  const startedAt = "2026-07-23T12:00:00.000Z";
  const reviewerIds = ["sol-1", "terra-1", "luna-1"];

  try {
    const { logPath } = startRun({
      outputRoot: root,
      repoRoot,
      timestamp: startedAt,
      runId: "usage-regression",
    });
    for (const reviewerId of reviewerIds) {
      appendEvent({
        logPath,
        ...reviewerStart(reviewerId, `gpt-5.6-${reviewerId.split("-")[0]}`),
        timestamp: startedAt,
      });
      appendEvent({
        logPath,
        event: "reviewer_pass_completed",
        data: { findingIds: [], reviewerId, round: 1 },
        timestamp: startedAt,
      });
      appendEvent({
        logPath,
        event: "reviewer_continuity_verified",
        data: { reviewerId, round: 1 },
        timestamp: startedAt,
      });
    }

    const sessionsRoot = join(root, "sessions");
    const sessionDirectory = join(sessionsRoot, "2026", "07", "23");
    mkdirSync(sessionDirectory, { recursive: true });
    for (const reviewerId of reviewerIds) {
      const sessionId = `/root/${reviewerId.replace("-", "_")}`;
      const records = [
        {
          type: "session_meta",
          payload: {
            cwd: repoRoot,
            id: sessionId,
            source: {
              subagent: { thread_spawn: { agent_path: sessionId, parent_thread_id: "parent-run" } },
            },
            timestamp: startedAt,
          },
        },
        { type: "event_msg", payload: { type: "task_started" } },
        { type: "event_msg", payload: { type: "task_started" } },
        { type: "event_msg", payload: { duration_ms: 1_000, type: "task_complete" } },
        { type: "event_msg", payload: { duration_ms: 2_000, type: "task_complete" } },
        {
          type: "event_msg",
          payload: {
            info: {
              total_token_usage: {
                cached_input_tokens: 10,
                input_tokens: 20,
                output_tokens: 30,
                reasoning_output_tokens: 5,
                total_tokens: 55,
              },
            },
            type: "token_count",
          },
        },
      ];
      writeFileSync(
        join(sessionDirectory, `${reviewerId}.jsonl`),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
    }

    const record = finishRun({
      collectCodexUsage: true,
      logPath,
      sessionsRoot,
      summary: {
        reviewers: reviewerIds.map((id) => ({
          id,
          model: `gpt-5.6-${id.split("-")[0]}`,
          reasoning: "high",
        })),
      },
      timestamp: "2026-07-23T12:01:00.000Z",
    });

    assert.equal(record.data.tokenUsageCollection.status, "complete");
    assert.equal(record.data.derived.reviewerInvocationCount, 6);
    assert.deepEqual(
      record.data.reviewers.map((reviewer) => reviewer.reviewerId),
      [...reviewerIds].sort(),
    );
    assert.ok(
      record.data.reviewers.every((reviewer) => reviewer.sessionTokenUsage?.totalTokens === 55),
    );
    assert.ok(record.data.reviewers.every((reviewer) => reviewer.sessionDurationMs === 3_000));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("recovers a completed persistent CLI reviewer result after command output is lost", () => {
  const root = mkdtempSync(join(tmpdir(), "review-cli-recovery-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:54.664Z";
  const sessionId = "019fd3e4-ef37-75d3-b79f-55c86957ec00";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const { logPath } = startRun({
      outputRoot: root,
      repoRoot,
      timestamp: startedAt,
      runId: "cli-recovery",
    });
    appendEvent({
      logPath,
      event: "reviewer_session_started",
      timestamp: "2026-08-05T21:47:52.000Z",
      data: {
        launchMechanism: "codex_cli",
        modelApplied: "gpt-5.6-luna",
        modelRequested: "gpt-5.6-luna",
        reasoningApplied: "high",
        reasoningRequested: "high",
        reviewerId: "luna-1",
        sessionId,
      },
    });

    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    const records = [
      {
        timestamp: "2026-08-05T21:47:04.625Z",
        type: "session_meta",
        payload: {
          cwd: repoRoot,
          id: sessionId,
          model: "gpt-5.6-luna",
          source: "exec",
          timestamp: "2026-08-05T21:47:03.904Z",
        },
      },
      {
        type: "turn_context",
        payload: { effort: "high", model: "gpt-5.6-luna" },
      },
      { type: "event_msg", payload: { type: "task_started" } },
      {
        type: "event_msg",
        payload: { message: "No findings.", phase: "final_answer", type: "agent_message" },
      },
      {
        type: "event_msg",
        payload: {
          completed_at: 1785966994,
          duration_ms: 569456,
          last_agent_message: "No findings.",
          type: "task_complete",
        },
      },
    ];
    writeFileSync(
      join(sessionDirectory, `rollout-${sessionId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const recovered = recoverCodexCliReviewerResult({
      logPath,
      sessionsRoot,
      reviewerId: "luna-1",
      timestamp: "2026-08-05T22:00:00.000Z",
    });
    assert.deepEqual(recovered, {
      completedAt: "2026-08-05T21:56:34.000Z",
      controls: { model: "gpt-5.6-luna", reasoning: "high" },
      durationMs: 569456,
      lastAgentMessage: "No findings.",
      reviewerId: "luna-1",
      sessionId,
      status: "complete",
      taskCompletedCount: 1,
      taskStartedCount: 1,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("does not recover a CLI result when its verified controls differ from the ledger", () => {
  const root = mkdtempSync(join(tmpdir(), "review-cli-control-mismatch-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:54.664Z";
  const sessionId = "luna-session";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      join(sessionDirectory, "rollout-luna-session.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: { cwd: repoRoot, id: sessionId, model: "gpt-5.6-luna", source: "exec" },
        },
        { type: "turn_context", payload: { effort: "medium", model: "gpt-5.6-luna" } },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );

    const result = collectCodexCliSessionResult(
      { modelApplied: "gpt-5.6-luna", reasoningApplied: "high", sessionId },
      { endedAt: "2026-08-05T22:00:00.000Z", repoRoot, sessionsRoot, startedAt },
    );
    assert.equal(result.status, "unavailable");
    assert.equal(
      result.reason,
      "persistent CLI session applied controls do not match the reviewer ledger",
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("reports a verified CLI session without a completed task as in progress", () => {
  const root = mkdtempSync(join(tmpdir(), "review-cli-in-progress-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:54.664Z";
  const sessionId = "luna-in-progress";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      join(sessionDirectory, "rollout-luna-in-progress.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: { cwd: repoRoot, id: sessionId, model: "gpt-5.6-luna", source: "exec" },
        },
        { type: "turn_context", payload: { effort: "high", model: "gpt-5.6-luna" } },
        { type: "event_msg", payload: { type: "task_started" } },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );

    const result = collectCodexCliSessionResult(
      { modelApplied: "gpt-5.6-luna", reasoningApplied: "high", sessionId },
      { endedAt: "2026-08-05T22:00:00.000Z", repoRoot, sessionsRoot, startedAt },
    );
    assert.deepEqual(result, {
      controls: { model: "gpt-5.6-luna", reasoning: "high" },
      reason: "persistent CLI session has an active task without a terminal response",
      sessionId,
      status: "in_progress",
      taskCompletedCount: 0,
      taskStartedCount: 1,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("does not recover a prior completed turn while a newer reviewer turn is still active", () => {
  const root = mkdtempSync(join(tmpdir(), "review-cli-newer-turn-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:00.000Z";
  const sessionId = "luna-newer-turn";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      join(sessionDirectory, `rollout-${sessionId}.jsonl`),
      `${[
        {
          type: "session_meta",
          payload: { cwd: repoRoot, id: sessionId, model: "gpt-5.6-luna", source: "exec" },
        },
        { type: "turn_context", payload: { effort: "high", model: "gpt-5.6-luna" } },
        { type: "event_msg", payload: { type: "task_started" } },
        {
          type: "event_msg",
          payload: { message: "Initial complete.", phase: "final_answer", type: "agent_message" },
        },
        {
          type: "event_msg",
          payload: {
            last_agent_message: "Initial complete.",
            type: "task_complete",
          },
        },
        { type: "event_msg", payload: { type: "task_started" } },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    const result = collectCodexCliSessionResult(
      { modelApplied: "gpt-5.6-luna", reasoningApplied: "high", sessionId },
      { endedAt: "2026-08-05T22:00:00.000Z", repoRoot, sessionsRoot, startedAt },
    );
    assert.equal(result.status, "in_progress");
    assert.equal(result.taskStartedCount, 2);
    assert.equal(result.taskCompletedCount, 1);
    assert.match(result.reason, /active task/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("inspects an in-progress CLI session without guessing that the worker failed", () => {
  const root = mkdtempSync(join(tmpdir(), "review-cli-inspect-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:00.000Z";
  const sessionId = "luna-inspect";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const { logPath } = startRun({
      outputRoot: root,
      repoRoot,
      timestamp: startedAt,
      runId: "cli-inspect",
    });
    appendEvent({
      logPath,
      event: "reviewer_session_started",
      data: {
        launchMechanism: "codex_cli",
        modelApplied: "gpt-5.6-luna",
        modelRequested: "gpt-5.6-luna",
        reasoningApplied: "high",
        reasoningRequested: "high",
        reviewerId: "luna-1",
        sessionId,
      },
    });
    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      join(sessionDirectory, `rollout-${sessionId}.jsonl`),
      `${[
        {
          timestamp: "2026-08-05T21:40:01.000Z",
          type: "session_meta",
          payload: { cwd: repoRoot, id: sessionId, model: "gpt-5.6-luna", source: "exec" },
        },
        { type: "turn_context", payload: { effort: "high", model: "gpt-5.6-luna" } },
        {
          timestamp: "2026-08-05T21:40:04.000Z",
          type: "event_msg",
          payload: { type: "task_started" },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );

    const active = inspectCodexCliReviewerSession({
      logPath,
      reviewerId: "luna-1",
      sessionsRoot,
      staleAfterMs: 10_000,
      timestamp: "2026-08-05T21:40:09.000Z",
    });
    assert.equal(active.status, "in_progress");
    assert.equal(active.lifecycle, "active");
    assert.equal(active.lastActivityAt, "2026-08-05T21:40:04.000Z");
    assert.equal(active.lastEvent.eventType, "task_started");
    assert.equal(active.activeTaskStartedAt, "2026-08-05T21:40:04.000Z");

    const stalled = inspectCodexCliReviewerSession({
      logPath,
      reviewerId: "luna-1",
      sessionsRoot,
      staleAfterMs: 10_000,
      timestamp: "2026-08-05T21:40:15.000Z",
    });
    assert.equal(stalled.lifecycle, "stalled");
    assert.equal(stalled.quietForMs, 11_000);
    assert.match(stalled.recommendedAction, /quiet past the threshold/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("inspects a native reviewer transcript before declaring a Sol or Terra worker stuck", () => {
  const root = mkdtempSync(join(tmpdir(), "review-native-inspect-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:00.000Z";
  const agentPath = "/root/sol_1";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const { logPath } = startRun({
      outputRoot: root,
      repoRoot,
      timestamp: startedAt,
      runId: "native-inspect",
    });
    appendEvent({
      logPath,
      event: "reviewer_session_started",
      data: {
        launchMechanism: "native",
        modelApplied: "gpt-5.6-sol",
        modelRequested: "gpt-5.6-sol",
        reasoningApplied: "high",
        reasoningRequested: "high",
        reviewerId: "sol-1",
        sessionId: agentPath,
      },
    });
    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    const sessionPath = join(sessionDirectory, "rollout-sol.jsonl");
    const records = [
      {
        timestamp: "2026-08-05T21:40:01.000Z",
        type: "session_meta",
        payload: {
          cwd: repoRoot,
          id: "sol-rollout-id",
          source: {
            subagent: { thread_spawn: { agent_path: agentPath, parent_thread_id: "run" } },
          },
        },
      },
      { type: "turn_context", payload: { effort: "high", model: "gpt-5.6-sol" } },
      {
        timestamp: "2026-08-05T21:40:04.000Z",
        type: "event_msg",
        payload: { type: "task_started" },
      },
    ];
    writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const active = inspectCodexNativeReviewerSession({
      logPath,
      reviewerId: "sol-1",
      sessionsRoot,
      staleAfterMs: 10_000,
      timestamp: "2026-08-05T21:40:09.000Z",
    });
    assert.equal(active.status, "in_progress");
    assert.equal(active.lifecycle, "active");
    assert.equal(active.sessionId, "sol-rollout-id");
    assert.equal(active.nativeHandle, agentPath);
    assert.equal(active.controls.model, "gpt-5.6-sol");
    assert.match(active.recommendedAction, /same native reviewer handle/);

    const stalled = inspectCodexNativeReviewerSession({
      logPath,
      reviewerId: "sol-1",
      sessionsRoot,
      staleAfterMs: 10_000,
      timestamp: "2026-08-05T21:40:15.000Z",
    });
    assert.equal(stalled.lifecycle, "stalled");
    assert.equal(stalled.quietForMs, 11_000);

    records.push(
      {
        timestamp: "2026-08-05T21:40:16.000Z",
        type: "event_msg",
        payload: { message: "No findings.", phase: "final_answer", type: "agent_message" },
      },
      {
        timestamp: "2026-08-05T21:40:16.001Z",
        type: "event_msg",
        payload: {
          completed_at: 1785966016,
          duration_ms: 12_000,
          last_agent_message: "No findings.",
          type: "task_complete",
        },
      },
    );
    writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    const complete = inspectCodexNativeReviewerSession({
      logPath,
      reviewerId: "sol-1",
      sessionsRoot,
      timestamp: "2026-08-05T21:40:17.000Z",
    });
    assert.equal(complete.lifecycle, "complete");
    assert.equal(complete.durationMs, 12_000);
    assert.equal(complete.lastAgentMessage, "No findings.");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("watches mixed reviewer sessions with soft and hard per-turn deadlines", () => {
  const root = mkdtempSync(join(tmpdir(), "review-watcher-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:00.000Z";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const { logPath } = startRun({
      outputRoot: root,
      repoRoot,
      timestamp: startedAt,
      runId: "watcher",
    });
    for (const [reviewerId, launchMechanism, model, sessionId] of [
      ["sol-1", "native", "gpt-5.6-sol", "/root/sol_1"],
      ["luna-1", "codex_cli", "gpt-5.6-luna", "luna-watcher"],
    ]) {
      appendEvent({
        logPath,
        event: "reviewer_session_started",
        data: {
          launchMechanism,
          modelApplied: model,
          modelRequested: model,
          reasoningApplied: "high",
          reasoningRequested: "high",
          reviewerId,
          sessionId,
        },
      });
    }
    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    const taskStarted = {
      timestamp: "2026-08-05T21:40:04.000Z",
      type: "event_msg",
      payload: { type: "task_started" },
    };
    writeFileSync(
      join(sessionDirectory, "rollout-sol.jsonl"),
      `${[
        {
          timestamp: "2026-08-05T21:40:01.000Z",
          type: "session_meta",
          payload: {
            cwd: repoRoot,
            id: "sol-watcher",
            source: { subagent: { thread_spawn: { agent_path: "/root/sol_1" } } },
          },
        },
        { type: "turn_context", payload: { effort: "high", model: "gpt-5.6-sol" } },
        taskStarted,
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    writeFileSync(
      join(sessionDirectory, "rollout-luna.jsonl"),
      `${[
        {
          timestamp: "2026-08-05T21:40:01.000Z",
          type: "session_meta",
          payload: { cwd: repoRoot, id: "luna-watcher", model: "gpt-5.6-luna", source: "exec" },
        },
        { type: "turn_context", payload: { effort: "high", model: "gpt-5.6-luna" } },
        taskStarted,
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );

    const soft = inspectReviewerSessions({
      logPath,
      sessionsRoot,
      softDeadlineMs: 10_000,
      hardDeadlineMs: 20_000,
      recordObservations: true,
      staleAfterMs: 10_000,
      timestamp: "2026-08-05T21:40:15.000Z",
    });
    assert.equal(soft.summary.reviewerCount, 2);
    assert.equal(soft.observationsRecorded, 2);
    assert.deepEqual(soft.summary.softExceededReviewerIds, ["luna-1", "sol-1"]);
    assert.deepEqual(soft.summary.hardExceededReviewerIds, []);
    assert.ok(soft.reviewers.every((reviewer) => reviewer.lifecycle === "stalled"));
    assert.deepEqual(
      readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse)
        .slice(-2)
        .map((event) => event.event),
      ["reviewer_session_observed", "reviewer_session_observed"],
    );

    const hard = inspectReviewerSessions({
      logPath,
      sessionsRoot,
      softDeadlineMs: 10_000,
      hardDeadlineMs: 20_000,
      staleAfterMs: 10_000,
      timestamp: "2026-08-05T21:40:25.000Z",
    });
    assert.deepEqual(hard.summary.hardExceededReviewerIds, ["luna-1", "sol-1"]);
    assert.ok(hard.reviewers.every((reviewer) => reviewer.deadline.elapsedMs === 21_000));
    assert.throws(
      () =>
        inspectReviewerSessions({
          logPath,
          sessionsRoot,
          softDeadlineMs: 20_000,
          hardDeadlineMs: 10_000,
        }),
      /hardDeadlineMs/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("collects a fresh native retry handle while retaining its stable reviewer ID", () => {
  const root = mkdtempSync(join(tmpdir(), "review-native-retry-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:00.000Z";
  const retryHandle = "/root/sol_1_retry_1";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      join(sessionDirectory, "rollout-sol-retry.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            cwd: repoRoot,
            id: "sol-retry-rollout",
            source: {
              subagent: {
                thread_spawn: { agent_path: retryHandle, parent_thread_id: "retry-run" },
              },
            },
            timestamp: "2026-08-05T21:40:02.000Z",
          },
        },
        { type: "event_msg", payload: { type: "task_started" } },
        { type: "event_msg", payload: { duration_ms: 1_000, type: "task_complete" } },
        { type: "event_msg", payload: { type: "task_started" } },
        { type: "event_msg", payload: { duration_ms: 2_000, type: "task_complete" } },
        {
          type: "event_msg",
          payload: {
            info: {
              total_token_usage: {
                cached_input_tokens: 10,
                input_tokens: 20,
                output_tokens: 30,
                reasoning_output_tokens: 5,
                total_tokens: 55,
              },
            },
            type: "token_count",
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    const collected = collectCodexSessionUsage(
      {
        reviewers: [
          {
            reviewerId: "sol-1",
            launchMechanism: "native",
            sessionId: retryHandle,
            modelApplied: "gpt-5.6-sol",
            reasoningApplied: "high",
            rounds: [{ phase: "initial", round: 1, findingIds: [] }],
            continuityChecks: [{ round: 1, verified: true }],
          },
        ],
      },
      {
        sessionsRoot,
        startedAt,
        endedAt: "2026-08-05T21:45:00.000Z",
        repoRoot,
      },
    );
    assert.equal(collected.collection.status, "complete");
    assert.equal(collected.collection.reviewers[0].sessionId, "sol-retry-rollout");
    assert.equal(collected.summary.reviewers[0].sessionTokenUsage.totalTokens, 55);
    assert.equal(collected.summary.reviewers[0].sessionDurationMs, 3_000);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("launches a CLI reviewer with a captured thread and verified controls", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-cli-launch-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:00.000Z";
  const sessionId = "luna-launch";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const { logPath } = startRun({
      outputRoot: root,
      repoRoot,
      timestamp: startedAt,
      runId: "cli-launch",
    });
    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    writeFileSync(
      join(sessionDirectory, `rollout-${sessionId}.jsonl`),
      `${[
        {
          timestamp: "2026-08-05T21:40:01.000Z",
          type: "session_meta",
          payload: { cwd: repoRoot, id: sessionId, model: "gpt-5.6-luna", source: "exec" },
        },
        { type: "turn_context", payload: { effort: "high", model: "gpt-5.6-luna" } },
        { type: "event_msg", payload: { type: "task_started" } },
        {
          type: "event_msg",
          payload: { message: "REVIEW_PACKET_ACK", phase: "final_answer", type: "agent_message" },
        },
        {
          type: "event_msg",
          payload: {
            completed_at: 1785966002,
            duration_ms: 2_000,
            last_agent_message: "REVIEW_PACKET_ACK",
            type: "task_complete",
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    const promptFile = join(root, "packet.txt");
    const outputFile = join(root, "luna.jsonl");
    const fakeCodex = join(root, "fake-codex");
    writeFileSync(
      fakeCodex,
      `#!/bin/sh\necho '{"type":"thread.started","thread_id":"${sessionId}"}'\ncat >/dev/null\n`,
    );
    chmodSync(fakeCodex, 0o755);
    writeFileSync(promptFile, "read-only review packet\n");

    const result = await launchCodexCliReviewer({
      codexCommand: fakeCodex,
      logPath,
      model: "gpt-5.6-luna",
      outputFile,
      promptFile,
      reasoning: "high",
      reviewerId: "luna-1",
      sessionsRoot,
    });

    assert.equal(result.sessionId, sessionId);
    assert.equal(result.clientExitCode, 0);
    assert.equal(result.inspection.lifecycle, "complete");
    assert.match(readFileSync(outputFile, "utf8"), /thread.started/);
    const events = readFileSync(logPath, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      events.slice(1).map((event) => event.event),
      ["reviewer_session_started", "reviewer_session_controls_verified"],
    );
    assert.deepEqual(events.at(-1).data, {
      modelApplied: "gpt-5.6-luna",
      reasoningApplied: "high",
      reviewerId: "luna-1",
      sessionId,
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("finishes a partial mixed cohort and retains independently collected usage", () => {
  const root = mkdtempSync(join(tmpdir(), "review-partial-usage-"));
  const repoRoot = join(root, "repo");
  const sessionsRoot = join(root, "sessions");
  const startedAt = "2026-08-05T21:40:00.000Z";

  try {
    mkdirSync(repoRoot, { recursive: true });
    const { logPath } = startRun({
      outputRoot: root,
      repoRoot,
      timestamp: startedAt,
      runId: "partial-usage",
      configuration: {
        requestedReviewerCount: 3,
        reviewerCohortRequested: [
          { model: "gpt-5.6-sol", count: 1 },
          { model: "gpt-5.6-terra", count: 1 },
          { model: "gpt-5.6-luna", count: 1 },
        ],
        reasoningRequested: "high",
      },
    });
    for (const [reviewerId, model, launchMechanism, sessionId] of [
      ["sol-1", "gpt-5.6-sol", "native", "/root/sol_1"],
      ["luna-1", "gpt-5.6-luna", "codex_cli", "luna-partial"],
    ]) {
      appendEvent({
        logPath,
        event: "reviewer_session_started",
        data: {
          launchMechanism,
          modelApplied: model,
          modelRequested: model,
          reasoningApplied: "high",
          reasoningRequested: "high",
          reviewerId,
          sessionId,
        },
      });
      appendEvent({
        logPath,
        event: "reviewer_pass_completed",
        data: { findingIds: [], reviewerId, round: 1, tokenUsage: null },
      });
      appendEvent({
        logPath,
        event: "reviewer_continuity_verified",
        data: { reviewerId, round: 1, tokenUsage: null, verified: true },
      });
    }
    appendEvent({
      logPath,
      event: "reviewer_session_observed",
      data: { lifecycle: "stalled", reviewerId: "terra-1" },
    });

    const sessionDirectory = join(sessionsRoot, "2026", "08", "05");
    mkdirSync(sessionDirectory, { recursive: true });
    const usage = {
      cached_input_tokens: 10,
      input_tokens: 20,
      output_tokens: 30,
      reasoning_output_tokens: 5,
      total_tokens: 55,
    };
    const taskRecords = [
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", payload: { duration_ms: 1_000, type: "task_complete" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", payload: { duration_ms: 2_000, type: "task_complete" } },
      { type: "event_msg", payload: { info: { total_token_usage: usage }, type: "token_count" } },
    ];
    writeFileSync(
      join(sessionDirectory, "rollout-sol.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: {
            cwd: repoRoot,
            id: "/root/sol_1",
            source: {
              subagent: { thread_spawn: { agent_path: "/root/sol_1", parent_thread_id: "run" } },
            },
            timestamp: startedAt,
          },
        },
        ...taskRecords,
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );
    writeFileSync(
      join(sessionDirectory, "rollout-luna.jsonl"),
      `${[
        {
          type: "session_meta",
          payload: { cwd: repoRoot, id: "luna-partial", model: "gpt-5.6-luna", source: "exec" },
        },
        { type: "turn_context", payload: { effort: "high", model: "gpt-5.6-luna" } },
        ...taskRecords,
      ]
        .map((record) => JSON.stringify(record))
        .join("\n")}\n`,
    );

    const finished = finishRun({
      collectCodexUsage: true,
      logPath,
      sessionsRoot,
      summary: { status: "partial" },
      timestamp: "2026-08-05T21:45:00.000Z",
    });
    assert.equal(finished.data.status, "partial");
    assert.equal(finished.data.tokenUsageCollection.status, "partial");
    assert.equal(finished.data.tokenUsageCollection.collectedCount, 2);
    assert.deepEqual(
      finished.data.reviewers.map((reviewer) => reviewer.reviewerId),
      ["luna-1", "sol-1", "terra-1"],
    );
    assert.equal(
      finished.data.reviewers.find((reviewer) => reviewer.reviewerId === "luna-1")
        ?.sessionTokenUsage?.totalTokens,
      55,
    );
    assert.equal(
      finished.data.reviewers.find((reviewer) => reviewer.reviewerId === "sol-1")
        ?.sessionDurationMs,
      3_000,
    );
    assert.equal(
      finished.data.reviewers.find((reviewer) => reviewer.reviewerId === "terra-1")
        ?.sessionTokenUsage,
      undefined,
    );
    const diagnosis = diagnoseCodexUsage({
      logPath,
      sessionsRoot,
      timestamp: "2026-08-05T21:45:00.000Z",
    });
    assert.equal(diagnosis.status, "incomplete");
    assert.deepEqual(diagnosis.missingReviewerIds, ["terra-1"]);
    assert.match(
      diagnosis.collection.reviewers.find((entry) => entry.reviewerId === "terra-1")?.reason,
      /no reviewer_session_started event/,
    );
    assert.equal(renderUsageTable(finished.data.derived), "");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
