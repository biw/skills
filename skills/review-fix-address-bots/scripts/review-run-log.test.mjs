import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { appendEvent, deriveMetrics, finishRun, sanitizeRemote, startRun } from './review-run-log.mjs'

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
            rounds: [
              { phase: 'initial', round: 1, findingIds: ['F1', 'F2'], tokenUsage: null },
              { phase: 'remediation', round: 1, findingIds: ['F4'], tokenUsage: null },
            ],
          },
          {
            reviewerId: 'reviewer-3',
            rounds: [{ phase: 'initial', round: 1, findingIds: ['F2', 'F5'], tokenUsage: null }],
          },
        ],
        githubReviewBots: [{ login: 'claude[bot]' }, { login: 'devin-ai-integration[bot]' }],
        reviewBotLoopCount: 2,
      },
    })

    const derived = finished.data.derived
    assert.equal(derived.reviewerSessionCount, 3)
    assert.equal(derived.reviewerInvocationCount, 5)
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
  assert.equal(
    sanitizeRemote('https://token:secret@github.com/biw/skills.git?credential=bad', 'fallback'),
    'github.com/biw/skills',
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
