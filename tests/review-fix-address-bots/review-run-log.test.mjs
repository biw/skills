import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LOG_TEMPLATES,
  PRICING_SNAPSHOT,
  appendEvent,
  collectCodexSessionUsage,
  deriveMetrics,
  estimateTokenCost,
  finishRun,
  renderUsageTable,
  sanitizeRemote,
  startRun,
} from '../../skills/review-fix-address-bots/scripts/review-run-log.mjs'

test('canonical templates produce a finishable event-driven run', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'review-run-templates-'))
  try {
    const { logPath } = startRun({
      repoRoot: temporaryRoot,
      outputRoot: join(temporaryRoot, 'logs'),
      configuration: LOG_TEMPLATES.configuration,
    })
    for (const template of [
      LOG_TEMPLATES.events.reviewerSessionStarted,
      LOG_TEMPLATES.events.initialPass,
      LOG_TEMPLATES.events.continuity,
      LOG_TEMPLATES.events.findingResolved,
    ]) {
      appendEvent({ logPath, event: template.event, data: template.data })
    }

    const finished = finishRun({ logPath, summary: LOG_TEMPLATES.finishSummary })
    assert.equal(finished.data.reviewers[0].reviewerId, 'sol-1')
    assert.deepEqual(finished.data.reviewers[0].rounds[0].findingIds, ['F1'])
    assert.equal(finished.data.findings[0].classification, 'valid')
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('writes dated JSONL and derives reviewer overlap without inventing token usage', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'review-run-log-'))
  try {
    const { logPath, runId } = startRun({
      repoRoot: temporaryRoot,
      outputRoot: join(temporaryRoot, 'logs'),
      timestamp: '2026-07-13T20:01:02.003Z',
      runId: 'test-run',
      configuration: { requestedReviewerCount: 3 },
    })
    assert.equal(runId, 'test-run')
    assert.match(logPath, /2026\/07\/13\/review-run-2026-07-13T20-01-02-003Z-test-run\.jsonl$/)

    appendEvent({
      logPath,
      event: 'reviewer_pass_completed',
      timestamp: '2026-07-13T20:02:00Z',
      data: { reviewerId: 'reviewer-1', phase: 'initial', round: 1 },
    })

    const finished = finishRun({
      logPath,
      timestamp: '2026-07-13T20:03:00Z',
      summary: {
        status: 'complete',
        reviewers: [
          {
            reviewerId: 'reviewer-1',
            launchMechanism: 'native',
            sessionId: 'session-reviewer-1',
            modelRequested: 'test-model',
            modelApplied: 'test-model',
            reasoningRequested: 'high',
            reasoningApplied: 'high',
            continuityChecks: [{ round: 1, verified: true, tokenUsage: null }],
            rounds: [
              {
                phase: 'initial',
                round: 1,
                findingIds: ['F1', 'F2'],
                tokenUsage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
              },
              { phase: 'remediation', round: 1, findingIds: ['F3'], tokenUsage: null },
            ],
          },
          {
            reviewerId: 'reviewer-2',
            launchMechanism: 'native',
            sessionId: 'session-reviewer-2',
            modelRequested: 'test-model',
            modelApplied: 'test-model',
            reasoningRequested: 'high',
            reasoningApplied: 'high',
            continuityChecks: [{ round: 1, verified: true, tokenUsage: null }],
            rounds: [
              { phase: 'initial', round: 1, findingIds: ['F1', 'F2'], tokenUsage: null },
              { phase: 'remediation', round: 1, findingIds: ['F4'], tokenUsage: null },
            ],
          },
          {
            reviewerId: 'reviewer-3',
            launchMechanism: 'native',
            sessionId: 'session-reviewer-3',
            modelRequested: 'test-model',
            modelApplied: 'test-model',
            reasoningRequested: 'high',
            reasoningApplied: 'high',
            continuityChecks: [{ round: 1, verified: true, tokenUsage: null }],
            rounds: [{ phase: 'initial', round: 1, findingIds: ['F2', 'F5'], tokenUsage: null }],
          },
        ],
        githubReviewBots: [{ login: 'claude[bot]' }, { login: 'devin-ai-integration[bot]' }],
        reviewBotLoopCount: 2,
      },
    })

    const derived = finished.data.derived
    assert.equal(derived.reviewerSessionCount, 3)
    assert.equal(derived.reviewerInvocationCount, 8)
    assert.equal(derived.initialUniqueFindingCount, 3)
    assert.equal(derived.cumulativeUniqueFindingCount, 5)
    assert.deepEqual(derived.initialOverlap.allReviewersSharedFindingIds, ['F2'])
    assert.deepEqual(derived.cumulativeOverlap.uniqueByReviewer, [
      { reviewerId: 'reviewer-1', findingIds: ['F3'] },
      { reviewerId: 'reviewer-2', findingIds: ['F4'] },
      { reviewerId: 'reviewer-3', findingIds: ['F5'] },
    ])
    assert.deepEqual(derived.initialOverlap.pairs[0], {
      leftReviewerId: 'reviewer-1',
      rightReviewerId: 'reviewer-2',
      sharedFindingIds: ['F1', 'F2'],
      onlyLeftFindingIds: [],
      onlyRightFindingIds: [],
      jaccard: 1,
    })
    assert.equal(derived.tokenUsage.complete, false)
    assert.equal(derived.tokenUsage.invocationsWithUsage, 1)
    assert.equal(derived.estimatedCost.complete, false)
    assert.equal(derived.estimatedCost.estimatedKnownUsd, null)
    assert.equal(derived.estimatedCost.estimatedTotalUsd, null)
    assert.deepEqual(derived.tokenUsage.totals, {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    })
    assert.deepEqual(derived.tokenUsage.fieldCoverage, {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 1,
    })
    assert.equal(derived.githubReviewBotCount, 2)
    assert.equal(derived.reviewBotLoopCount, 2)

    const events = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(events.map((event) => event.event), [
      'run_started',
      'reviewer_pass_completed',
      'run_finished',
    ])
    assert.throws(() => finishRun({ logPath, summary: {} }), /already finished/)
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('sanitizes remote credentials and transport details', () => {
  const credentialedRemote = new URL('https://example.invalid/acme/repository.git?ignored=value')
  credentialedRemote.username = 'fixture-user'
  credentialedRemote.password = 'fixture-password'

  assert.equal(
    sanitizeRemote(credentialedRemote.href, 'fallback'),
    'example.invalid/acme/repository',
  )
  assert.equal(sanitizeRemote('git@github.com:biw/skills.git', 'fallback'), 'github.com/biw/skills')
  assert.equal(sanitizeRemote(undefined, 'local-repo'), 'local-repo')
})

test('groups five-reviewer findings by applied model for quality comparison', () => {
  const derived = deriveMetrics({
    reviewers: [
      {
        reviewerId: 'sol-1',
        modelRequested: 'gpt-5.6-sol',
        modelApplied: 'gpt-5.6-sol',
        continuityChecks: [{ round: 1, verified: true, tokenUsage: { totalTokens: 10 } }],
        rounds: [{ phase: 'initial', round: 1, findingIds: ['F1', 'F2'], tokenUsage: { totalTokens: 100 } }],
      },
      {
        reviewerId: 'terra-1',
        modelRequested: 'gpt-5.6-terra',
        modelApplied: 'gpt-5.6-terra',
        continuityChecks: [{ round: 1, verified: true, tokenUsage: null }],
        rounds: [{ phase: 'initial', round: 1, findingIds: ['F1', 'F3'], tokenUsage: { totalTokens: 80 } }],
      },
      {
        reviewerId: 'terra-2',
        modelRequested: 'gpt-5.6-terra',
        modelApplied: 'gpt-5.6-terra',
        continuityChecks: [{ round: 1, verified: true, tokenUsage: null }],
        rounds: [{ phase: 'initial', round: 1, findingIds: ['F3', 'F4'], tokenUsage: null }],
      },
      {
        reviewerId: 'luna-1',
        modelRequested: 'gpt-5.6-luna',
        modelApplied: 'gpt-5.6-luna',
        continuityChecks: [{ round: 1, verified: true, tokenUsage: null }],
        rounds: [{ phase: 'initial', round: 1, findingIds: ['F1', 'F5'], tokenUsage: { totalTokens: 40 } }],
      },
      {
        reviewerId: 'luna-2',
        modelRequested: 'gpt-5.6-luna',
        modelApplied: 'gpt-5.6-luna',
        continuityChecks: [{ round: 1, verified: true, tokenUsage: null }],
        rounds: [{ phase: 'initial', round: 1, findingIds: ['F5', 'F6'], tokenUsage: null }],
      },
    ],
    findings: [
      { findingId: 'F1', classification: 'valid' },
      { findingId: 'F2', classification: 'false_positive' },
      { findingId: 'F3', classification: 'valid' },
      { findingId: 'F4', classification: 'needs_user_decision' },
      { findingId: 'F5', classification: 'valid' },
      { findingId: 'F6', classification: 'false_positive' },
    ],
  })

  assert.equal(derived.reviewerSessionCount, 5)
  assert.equal(derived.reviewerInvocationCount, 10)
  assert.equal(derived.continuityInvocationCount, 5)
  assert.equal(derived.tokenUsage.invocationCount, 10)
  assert.equal(derived.tokenUsage.invocationsWithUsage, 4)
  assert.deepEqual(derived.tokenUsage.totals, { totalTokens: 230 })
  assert.deepEqual(
    derived.modelComparison.byModel.map(({ model, reviewerCount }) => ({ model, reviewerCount })),
    [
      { model: 'gpt-5.6-sol', reviewerCount: 1 },
      { model: 'gpt-5.6-terra', reviewerCount: 2 },
      { model: 'gpt-5.6-luna', reviewerCount: 2 },
    ],
  )
  assert.deepEqual(derived.modelComparison.byModel[0].initialClassificationCounts, {
    false_positive: 1,
    valid: 1,
  })
  assert.deepEqual(derived.modelComparison.byModel[0].initialUniqueValidFindingIds, [])
  assert.deepEqual(derived.modelComparison.byModel[1].initialUniqueValidFindingIds, ['F3'])
  assert.deepEqual(derived.modelComparison.byModel[2].initialUniqueValidFindingIds, ['F5'])
  assert.deepEqual(derived.modelComparison.initialOverlap.allReviewersSharedFindingIds, ['F1'])
  assert.equal(derived.modelComparison.byModel[1].invocationCount, 4)
  assert.equal(derived.modelComparison.byModel[1].initialTokenUsage.invocationCount, 2)
  assert.equal(derived.modelComparison.byModel[1].initialTokenUsage.complete, false)
  assert.equal(derived.modelComparison.byModel[1].cumulativeTokenUsage.invocationCount, 4)
  assert.equal(derived.modelComparison.byModel[1].cumulativeEstimatedCostUsd, null)
})

test('estimates standard API-equivalent cost with cached input priced separately', () => {
  const derived = deriveMetrics({
    reviewers: [
      {
        reviewerId: 'sol-1',
        modelApplied: 'gpt-5.6-sol',
        continuityChecks: [
          {
            round: 1,
            tokenUsage: {
              inputTokens: 20_000,
              cachedInputTokens: 15_000,
              outputTokens: 1_000,
              reasoningOutputTokens: 600,
              totalTokens: 21_000,
            },
          },
        ],
        rounds: [
          {
            phase: 'initial',
            round: 1,
            findingIds: [],
            tokenUsage: {
              inputTokens: 80_000,
              cachedInputTokens: 75_000,
              outputTokens: 2_000,
              reasoningOutputTokens: 1_200,
              totalTokens: 82_000,
            },
          },
        ],
      },
      {
        reviewerId: 'luna-1',
        modelApplied: 'gpt-5.6-luna',
        rounds: [
          {
            phase: 'initial',
            round: 1,
            findingIds: [],
            tokenUsage: {
              inputTokens: 50_000,
              cachedInputTokens: 40_000,
              outputTokens: 1_000,
              reasoningOutputTokens: 500,
              totalTokens: 51_000,
            },
          },
        ],
      },
    ],
  })

  assert.equal(PRICING_SNAPSHOT.ratesPerMillionTokens['gpt-5.6-sol'].cachedInput, 0.5)
  assert.equal(derived.reviewerUsage[0].estimatedCostUsd, 0.185)
  assert.equal(derived.reviewerUsage[1].estimatedCostUsd, 0.02)
  assert.equal(derived.modelComparison.byModel[0].initialEstimatedCostUsd, 0.1225)
  assert.equal(derived.modelComparison.byModel[0].cumulativeEstimatedCostUsd, 0.185)
  assert.deepEqual(
    {
      reviewerCount: derived.estimatedCost.reviewerCount,
      reviewersWithEstimate: derived.estimatedCost.reviewersWithEstimate,
      complete: derived.estimatedCost.complete,
      estimatedTotalUsd: derived.estimatedCost.estimatedTotalUsd,
    },
    { reviewerCount: 2, reviewersWithEstimate: 2, complete: true, estimatedTotalUsd: 0.205 },
  )
})

test('does not estimate cost from incomplete or invalid token accounting', () => {
  assert.equal(
    estimateTokenCost('gpt-5.6-sol', {
      invocationCount: 1,
      fieldCoverage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 },
      totals: { inputTokens: 100, outputTokens: 10 },
    }),
    null,
  )
  assert.equal(
    estimateTokenCost('gpt-5.6-sol', {
      invocationCount: 1,
      fieldCoverage: { inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 },
      totals: { inputTokens: 100, cachedInputTokens: 101, outputTokens: 10 },
    }),
    null,
  )
  assert.equal(
    estimateTokenCost('unknown', {
      invocationCount: 1,
      fieldCoverage: { inputTokens: 1, cachedInputTokens: 1, outputTokens: 1 },
      totals: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 },
    }),
    null,
  )
})

test('collects an unambiguous Codex reviewer session and renders deterministic Markdown', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'review-session-usage-'))
  try {
    const sessionsRoot = join(temporaryRoot, 'sessions')
    const sessionDirectory = join(sessionsRoot, '2026', '07', '15')
    mkdirSync(sessionDirectory, { recursive: true })
    const records = [
      {
        timestamp: '2026-07-15T19:01:00Z',
        type: 'session_meta',
        payload: {
          id: 'sol-session',
          timestamp: '2026-07-15T19:01:00Z',
          cwd: temporaryRoot,
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: 'parent-thread', agent_path: '/root/sol_1' },
            },
          },
        },
      },
      { type: 'event_msg', payload: { type: 'task_started' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100_000,
              cached_input_tokens: 85_000,
              output_tokens: 2_000,
              reasoning_output_tokens: 1_200,
              total_tokens: 102_000,
            },
          },
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete' } },
      { type: 'event_msg', payload: { type: 'task_started' } },
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 120_000,
              cached_input_tokens: 100_000,
              output_tokens: 3_000,
              reasoning_output_tokens: 1_500,
              total_tokens: 123_000,
            },
          },
        },
      },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ]
    writeFileSync(
      join(sessionDirectory, 'rollout-sol.jsonl'),
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    )

    const result = collectCodexSessionUsage(
      {
        reviewers: [
          {
            reviewerId: 'sol-1',
            modelApplied: 'gpt-5.6-sol',
            reasoningApplied: 'high',
            continuityChecks: [{ round: 1, verified: true, tokenUsage: null }],
            rounds: [{ phase: 'initial', round: 1, findingIds: [], tokenUsage: null }],
          },
        ],
      },
      {
        sessionsRoot,
        startedAt: '2026-07-15T19:00:00Z',
        endedAt: '2026-07-15T19:02:00Z',
        repoRoot: temporaryRoot,
      },
    )

    assert.equal(result.collection.status, 'complete')
    assert.equal(result.collection.collectedCount, 1)
    assert.deepEqual(result.summary.reviewers[0].sessionTokenUsage, {
      inputTokens: 120_000,
      cachedInputTokens: 100_000,
      outputTokens: 3_000,
      reasoningOutputTokens: 1_500,
      totalTokens: 123_000,
    })

    const markdown = renderUsageTable(deriveMetrics(result.summary))
    assert.match(
      markdown,
      /\| Sol1 \(high\) \| 120,000 \| 100,000 \| 3,000 \| 1,500 \| 123,000 \| \$0\.2400 \|/,
    )
    assert.match(
      markdown,
      /\| \*\*Total\*\* \| \*\*120,000\*\* \| \*\*100,000\*\* \| \*\*3,000\*\* \| \*\*1,500\*\* \| \*\*123,000\*\* \| \*\*\$0\.2400\*\* \|/,
    )
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('keeps reviewer model unknown when applied routing is unavailable', () => {
  const derived = deriveMetrics({
    reviewers: [
      {
        reviewerId: 'unverified-reviewer',
        modelRequested: 'gpt-5.6-sol',
        rounds: [{ phase: 'initial', round: 1, findingIds: ['F1'], tokenUsage: null }],
      },
    ],
    findings: [{ findingId: 'F1', classification: 'valid' }],
  })

  assert.equal(derived.modelComparison.byModel[0].model, 'unknown')
  assert.deepEqual(derived.modelComparison.byModel[0].reviewerIds, ['unverified-reviewer'])
})

test('assigns fallback reviewer IDs before filtering reviewers with findings', () => {
  const derived = deriveMetrics({
    reviewers: [
      { rounds: [{ phase: 'initial', round: 1, findingIds: [] }] },
      { rounds: [{ phase: 'initial', round: 1, findingIds: ['F1'] }] },
    ],
  })
  assert.deepEqual(derived.reviewersWhoFoundIssues, ['reviewer-2'])
})
