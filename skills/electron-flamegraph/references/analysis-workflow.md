# CPU Profile Analysis

## Validate the capture

Confirm the file exists, parses as JSON, and contains `nodes`, `samples`, and `timeDeltas`. Require more than 200 ms of sampled duration and confirm the user reproduced the reported behavior; an idle or very short capture is not diagnostic.

## Run the analyzer

```bash
node <skill-dir>/scripts/analyze-cpuprofile.mjs <path-to-cpuprofile>
```

Options:

- `--top=N`: number of hot functions, default 20.
- `--sampling-gap-threshold-ms=N`: interval between samples reported as an irregular gap, default 50.
- `--json`: machine-readable output.

The deprecated `--stall-threshold-ms=N` spelling remains an alias, but never interpret its name as evidence that a sampling gap is a stall.

The report includes self and total time, runtime-category distribution, large sampling gaps, and heuristic warnings for synchronous filesystem calls, JSON work, module loading, GC, and other common costs.

## Interpret the evidence

- Prioritize **self time** to identify where cycles are spent; use total time to locate the dominant call path.
- Discount module loading, compilation, and warmup unless startup is the measured problem.
- Treat heavy native frames as evidence to call the native operation less or request less data, not automatically to optimize surrounding JavaScript.
- Treat `timeDeltas` only as intervals between samples. A large gap can have several causes and does not prove event-loop blockage or that the following stack occupied the interval. Use tracing, event-loop delay instrumentation, or scoped timing for responsiveness questions.
- If bundled names are unreadable, enable source maps in the development build and capture again.
- If the capture shows no clear main-process CPU hotspot, say so. Renderer work, I/O, scheduling, or UX feedback may require different evidence.

## Report findings

For each actionable finding, provide:

1. the measured self/total time or distribution;
2. the likely cause tied to concrete code when possible;
3. the specific file, line, or architectural change;
4. a verification step that repeats the same capture scope.

Do not dump analyzer output without interpretation or recommend vague optimization.
