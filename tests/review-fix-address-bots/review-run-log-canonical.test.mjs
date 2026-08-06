import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  appendEvent,
  canonicalSummaryFromEvents,
  collectCodexCliSessionResult,
  finishRun,
  recoverCodexCliReviewerResult,
  startRun,
  validateFinishSummary,
} from '../../skills/review-fix-address-bots/scripts/review-run-log.mjs'

const reviewerStart = (reviewerId, model) => ({
  event: 'reviewer_session_started',
  data: {
    launchMechanism: 'native',
    modelApplied: model,
    modelRequested: model,
    reasoningApplied: 'high',
    reasoningRequested: 'high',
    reviewerId,
    sessionId: `/root/${reviewerId.replace('-', '_')}`,
  },
})

test('reconstructs canonical reviewer records from the append-only event ledger', () => {
  const events = [
    reviewerStart('sol-1', 'gpt-5.6-sol'),
    reviewerStart('terra-1', 'gpt-5.6-terra'),
    reviewerStart('luna-1', 'gpt-5.6-luna'),
    {
      event: 'reviewer_pass_completed',
      data: { finding_ids: ['F1'], reviewer: 'sol-1', round: 1 },
    },
    {
      event: 'remediation_reviewer_pass_completed',
      data: { findingIds: [], reviewerId: 'sol-1', round: 1 },
    },
    {
      event: 'reviewer_continuity_verified',
      data: { reviewer: 'sol-1', round: 1 },
    },
  ]
  const summary = {
    reviewers: [
      { id: 'sol-1', model: 'gpt-5.6-sol', reasoning: 'high' },
      { id: 'terra-1', model: 'gpt-5.6-terra', reasoning: 'high' },
      { id: 'luna-1', model: 'gpt-5.6-luna', reasoning: 'high' },
    ],
  }

  const canonical = canonicalSummaryFromEvents(events, summary)
  const sol = canonical.reviewers.find((reviewer) => reviewer.reviewerId === 'sol-1')

  assert.deepEqual(sol?.rounds, [
    { findingIds: ['F1'], phase: 'initial', round: 1, tokenUsage: null },
    { findingIds: [], phase: 'remediation', round: 1, tokenUsage: null },
  ])
  assert.deepEqual(sol?.continuityChecks, [{ round: 1, tokenUsage: null, verified: true }])
  assert.equal(sol?.modelApplied, 'gpt-5.6-sol')
  assert.equal(sol?.reasoningApplied, 'high')

  assert.throws(() => validateFinishSummary(canonical), /has no recorded review rounds/)
})

test('collectCodexUsage enriches the ledger-canonicalized reviewer records', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-run-log-'))
  const repoRoot = process.cwd()
  const startedAt = '2026-07-23T12:00:00.000Z'
  const reviewerIds = ['sol-1', 'terra-1', 'luna-1']

  try {
    const { logPath } = startRun({ outputRoot: root, repoRoot, timestamp: startedAt, runId: 'usage-regression' })
    for (const reviewerId of reviewerIds) {
      appendEvent({ logPath, ...reviewerStart(reviewerId, `gpt-5.6-${reviewerId.split('-')[0]}`), timestamp: startedAt })
      appendEvent({
        logPath,
        event: 'reviewer_pass_completed',
        data: { findingIds: [], reviewerId, round: 1 },
        timestamp: startedAt,
      })
      appendEvent({
        logPath,
        event: 'reviewer_continuity_verified',
        data: { reviewerId, round: 1 },
        timestamp: startedAt,
      })
    }

    const sessionsRoot = join(root, 'sessions')
    const sessionDirectory = join(sessionsRoot, '2026', '07', '23')
    mkdirSync(sessionDirectory, { recursive: true })
    for (const reviewerId of reviewerIds) {
      const sessionId = `/root/${reviewerId.replace('-', '_')}`
      const records = [
        {
          type: 'session_meta',
          payload: {
            cwd: repoRoot,
            id: sessionId,
            source: { subagent: { thread_spawn: { agent_path: sessionId, parent_thread_id: 'parent-run' } } },
            timestamp: startedAt,
          },
        },
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_started' } },
        { type: 'event_msg', payload: { type: 'task_complete' } },
        { type: 'event_msg', payload: { type: 'task_complete' } },
        {
          type: 'event_msg',
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
            type: 'token_count',
          },
        },
      ]
      writeFileSync(
        join(sessionDirectory, `${reviewerId}.jsonl`),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      )
    }

    const record = finishRun({
      collectCodexUsage: true,
      logPath,
      sessionsRoot,
      summary: {
        reviewers: reviewerIds.map((id) => ({ id, model: `gpt-5.6-${id.split('-')[0]}`, reasoning: 'high' })),
      },
      timestamp: '2026-07-23T12:01:00.000Z',
    })

    assert.equal(record.data.tokenUsageCollection.status, 'complete')
    assert.equal(record.data.derived.reviewerInvocationCount, 6)
    assert.deepEqual(
      record.data.reviewers.map((reviewer) => reviewer.reviewerId),
      [...reviewerIds].sort(),
    )
    assert.ok(record.data.reviewers.every((reviewer) => reviewer.sessionTokenUsage?.totalTokens === 55))
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('recovers a completed persistent CLI reviewer result after command output is lost', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-cli-recovery-'))
  const repoRoot = join(root, 'repo')
  const sessionsRoot = join(root, 'sessions')
  const startedAt = '2026-08-05T21:40:54.664Z'
  const sessionId = '019fd3e4-ef37-75d3-b79f-55c86957ec00'

  try {
    mkdirSync(repoRoot, { recursive: true })
    const { logPath } = startRun({ outputRoot: root, repoRoot, timestamp: startedAt, runId: 'cli-recovery' })
    appendEvent({
      logPath,
      event: 'reviewer_session_started',
      timestamp: '2026-08-05T21:47:52.000Z',
      data: {
        launchMechanism: 'codex_cli',
        modelApplied: 'gpt-5.6-luna',
        modelRequested: 'gpt-5.6-luna',
        reasoningApplied: 'high',
        reasoningRequested: 'high',
        reviewerId: 'luna-1',
        sessionId,
      },
    })

    const sessionDirectory = join(sessionsRoot, '2026', '08', '05')
    mkdirSync(sessionDirectory, { recursive: true })
    const records = [
      {
        timestamp: '2026-08-05T21:47:04.625Z',
        type: 'session_meta',
        payload: {
          cwd: repoRoot,
          id: sessionId,
          model: 'gpt-5.6-luna',
          source: 'exec',
          timestamp: '2026-08-05T21:47:03.904Z',
        },
      },
      {
        type: 'turn_context',
        payload: { effort: 'high', model: 'gpt-5.6-luna' },
      },
      { type: 'event_msg', payload: { type: 'task_started' } },
      {
        type: 'event_msg',
        payload: { message: 'No findings.', phase: 'final_answer', type: 'agent_message' },
      },
      {
        type: 'event_msg',
        payload: {
          completed_at: 1785966994,
          duration_ms: 569456,
          last_agent_message: 'No findings.',
          type: 'task_complete',
        },
      },
    ]
    writeFileSync(
      join(sessionDirectory, `rollout-${sessionId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )

    const recovered = recoverCodexCliReviewerResult({
      logPath,
      sessionsRoot,
      reviewerId: 'luna-1',
      timestamp: '2026-08-05T22:00:00.000Z',
    })
    assert.deepEqual(recovered, {
      completedAt: '2026-08-05T21:56:34.000Z',
      controls: { model: 'gpt-5.6-luna', reasoning: 'high' },
      durationMs: 569456,
      lastAgentMessage: 'No findings.',
      reviewerId: 'luna-1',
      sessionId,
      status: 'complete',
      taskCompletedCount: 1,
      taskStartedCount: 1,
    })
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('does not recover a CLI result when its verified controls differ from the ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-cli-control-mismatch-'))
  const repoRoot = join(root, 'repo')
  const sessionsRoot = join(root, 'sessions')
  const startedAt = '2026-08-05T21:40:54.664Z'
  const sessionId = 'luna-session'

  try {
    mkdirSync(repoRoot, { recursive: true })
    const sessionDirectory = join(sessionsRoot, '2026', '08', '05')
    mkdirSync(sessionDirectory, { recursive: true })
    writeFileSync(
      join(sessionDirectory, 'rollout-luna-session.jsonl'),
      `${[
        {
          type: 'session_meta',
          payload: { cwd: repoRoot, id: sessionId, model: 'gpt-5.6-luna', source: 'exec' },
        },
        { type: 'turn_context', payload: { effort: 'medium', model: 'gpt-5.6-luna' } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
    )

    const result = collectCodexCliSessionResult(
      { modelApplied: 'gpt-5.6-luna', reasoningApplied: 'high', sessionId },
      { endedAt: '2026-08-05T22:00:00.000Z', repoRoot, sessionsRoot, startedAt },
    )
    assert.equal(result.status, 'unavailable')
    assert.equal(result.reason, 'persistent CLI session applied controls do not match the reviewer ledger')
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})

test('reports a verified CLI session without a completed task as in progress', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-cli-in-progress-'))
  const repoRoot = join(root, 'repo')
  const sessionsRoot = join(root, 'sessions')
  const startedAt = '2026-08-05T21:40:54.664Z'
  const sessionId = 'luna-in-progress'

  try {
    mkdirSync(repoRoot, { recursive: true })
    const sessionDirectory = join(sessionsRoot, '2026', '08', '05')
    mkdirSync(sessionDirectory, { recursive: true })
    writeFileSync(
      join(sessionDirectory, 'rollout-luna-in-progress.jsonl'),
      `${[
        {
          type: 'session_meta',
          payload: { cwd: repoRoot, id: sessionId, model: 'gpt-5.6-luna', source: 'exec' },
        },
        { type: 'turn_context', payload: { effort: 'high', model: 'gpt-5.6-luna' } },
        { type: 'event_msg', payload: { type: 'task_started' } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`,
    )

    const result = collectCodexCliSessionResult(
      { modelApplied: 'gpt-5.6-luna', reasoningApplied: 'high', sessionId },
      { endedAt: '2026-08-05T22:00:00.000Z', repoRoot, sessionsRoot, startedAt },
    )
    assert.deepEqual(result, {
      controls: { model: 'gpt-5.6-luna', reasoning: 'high' },
      reason: 'persistent CLI session has no completed task with a terminal response',
      sessionId,
      status: 'in_progress',
      taskCompletedCount: 0,
      taskStartedCount: 1,
    })
  } finally {
    rmSync(root, { force: true, recursive: true })
  }
})
