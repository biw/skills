---
name: codex-multi-model-delegation
description: Delegate Codex multi-agent work across GPT-5.6 Sol, Terra, and Luna with explicit routing, bounded tasks, and evidence-based integration.
metadata:
  source: "biw/skills"
  homepage: "https://github.com/biw/skills"
---

# Codex Multi-Model Delegation

Use explicit model routing only for independently valuable subtasks. The primary agent owns the plan, task boundaries, workspace mutations, integration, and final validation.

## Configure once

1. Confirm Multi-Agent v2 is enabled before relying on per-subagent model selection:

   ```toml
   [features.multi_agent_v2]
   enabled = true
   expose_spawn_agent_model_overrides = true
   ```

2. Keep `tool_namespace = "agents"` when a stable `agents.spawn_agent` surface is required. Set the concurrency cap in `[agents]`; do not raise it merely to launch a larger cohort.
3. Start a fresh Codex session after changing configuration. Confirm the spawn control exposes the requested model and record the applied model when the runtime provides it.

## Route deliberately

| Model           | Prefer for                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `gpt-5.6-sol`   | Architecture, difficult debugging, high-risk reviews, and final synthesis of disputed evidence.           |
| `gpt-5.6-terra` | Primary implementation, general-purpose investigation, and focused test or refactor work.                 |
| `gpt-5.6-luna`  | High-volume, bounded reconnaissance, independent review passes, narrow test cases, and mechanical checks. |

Use the task's risk and expected judgment—not model labels alone—to choose a route. Keep expensive or high-reasoning agents for work that benefits from deeper judgment. Do not substitute a model silently when an exact model was requested or policy requires one.

## Delegate safely

1. Split only work with a clear question, scope, expected deliverable, and ownership boundary. Keep dependent work with the primary agent or sequence it after the prerequisite result.
2. Set the model and reasoning level explicitly at launch. Give every worker the minimum context needed for its task, the applicable repository instructions, and whether it is read-only or may edit specific files.
3. Launch independent tasks concurrently up to the configured cap. Use stable task names and retain handles so workers can be steered, interrupted, or resumed without replacement.
4. Keep mutating work disjoint. When two tasks must touch the same files, use read-only analysis first and let the primary agent perform the integrated edit.
5. Verify material conclusions against repository state, tests, and primary evidence. Treat every subagent result as advisory until checked; deduplicate overlapping findings and resolve disagreements by evidence, not vote count.
6. Run focused validation after integration, then report the model mix, applied controls, work completed, verification, and remaining uncertainty.
