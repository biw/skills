# Persistent Reviewer Sessions

Use this cohort for every initial and remediation pass:

| Reviewer ID | Model | Reasoning |
| --- | --- | --- |
| `sol-1` | `gpt-5.6-sol` | `high` |
| `terra-1` | `gpt-5.6-terra` | `high` |
| `terra-2` | `gpt-5.6-terra` | `high` |
| `luna-1` | `gpt-5.6-luna` | `high` |
| `luna-2` | `gpt-5.6-luna` | `high` |

Keep the raw review prompt, target fingerprint, reviewer role boundary, reasoning level, and any configurable service tier identical across the cohort. A runtime concurrency limit may require batches. Queue reviewers without editing the target, and do not start remediation until all five initial reports and continuity handshakes finish.

## Choose a persistent launcher

Prefer the native subagent launcher when it exposes exact model selection, high reasoning, and a stable session handle that accepts follow-up turns. Verify the applied settings from runtime evidence for every reviewer; requested arguments alone are not proof when the runtime does not confirm them.

If a Codex native `spawn_agent` schema hides `model`, `reasoning_effort`, `agent_type`, or `service_tier`, check whether the user already configured the MultiAgent V2 routing-field workaround:

```toml
[features.multi_agent_v2]
hide_spawn_agent_metadata = false
tool_namespace = "agents"
```

Do not change user-level Codex configuration without explicit authorization. The setting applies only to fresh Codex sessions, so never claim the current session gained routing fields after editing configuration. In a fresh session, verify that the actual launcher schema exposes the required controls before using it.

When the native launcher lacks an exact model, reasoning control, or resumable handle, use a persistent Codex CLI session only if the runtime can verify the applied controls. Launch each cohort member with its assigned model using the equivalent of:

```bash
codex exec \
  --model "$REVIEWER_MODEL" \
  -c 'model_reasoning_effort="high"' \
  -c 'approval_policy="never"' \
  --strict-config \
  --sandbox read-only \
  --json -
```

Supply the shared review prompt on stdin. Never pass `--ephemeral` to an initial or follow-up reviewer command. Capture each `thread.started.thread_id` immediately.

## Record and verify continuity

Before fixes, write a gitignored `.context/reviewer-sessions.json` operational ledger containing, for each reviewer:

- stable reviewer ID,
- requested and applied model and reasoning,
- launch mechanism and any configured service tier,
- native session handle or CLI thread ID,
- initial target fingerprint,
- continuity status.

Do not store credentials, auth material, full prompts, or review bodies. Copy the non-secret reviewer ID, session identifier, applied controls, and continuity result into the structured run log.

After all five initial reports return, resume every session with the same explicit model and reasoning controls. For a CLI session, use the equivalent of:

```bash
codex exec resume \
  --model "$REVIEWER_MODEL" \
  -c 'model_reasoning_effort="high"' \
  -c 'approval_policy="never"' \
  -c 'sandbox_mode="read-only"' \
  --strict-config \
  --json "$THREAD_ID" -
```

Ask the reviewer to reply only `SESSION_CONTINUITY_OK` while keeping the read-only role boundary in force. Mark continuity successful only after receiving that exact reply from the expected handle with the expected applied controls.

If any handshake fails, discard all five reports and restart the full cohort once against the unchanged fingerprint. If any second-cohort session fails its handshake, stop before editing. For remediation passes, resume these exact five verified handles; never replace one silently or convert it to an ephemeral session.
