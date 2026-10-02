---
name: local-browser
description: Share a local Chromium browser for development previews, UI checks, screenshots, and web debugging, with separate task state and automatic process cleanup.
---

# Local browser

Use the bundled helper for local browser checks. It shares one dedicated Chromium
process across concurrent coding agents on this computer. Every `run` receives
its own temporary context, cookies, storage, and page. Contexts close when the
task finishes, fails, times out, or its client disconnects. The browser and helper
exit after five minutes with no tasks. This is resource sharing, not a security
boundary between agents.

Resolve `scripts/browser.mjs` relative to this skill's directory. Run it from the
project workspace so relative screenshots and other outputs land in that project.
The helper requires macOS or Linux and Node.js 20 or newer.
If dependencies are missing, run `pnpm install --ignore-workspace --frozen-lockfile`
in the skill directory, then `pnpm exec playwright install chromium` there.
Dependencies belong to the skill; don't add them to the user's application.

## Run a browser task

Group related interactions in one `run`. The helper executes an async JavaScript
body with `page` and `context` available; use Playwright locators and normal awaits.
Print findings with `console.log`, or return a JSON-compatible result.

```bash
node /absolute/path/to/local-browser/scripts/browser.mjs run <<'JS'
await page.goto('http://localhost:3000');
console.log(await page.locator('body').ariaSnapshot());
await page.getByRole('button', { name: 'Save', exact: true }).click();
await page.screenshot({ path: '.context/saved.png', fullPage: true });
return { url: page.url(), title: await page.title() };
JS
```

The default task deadline is two minutes. For a known longer interaction, use
`run --timeout-ms 300000`. Use `run --headed` when seeing the window helps; concurrent
tasks must use the same display mode. Headless is the default. To change mode,
finish the current tasks, run `stop`, then start the next task in the desired mode.

Each invocation creates a fresh context; state does not survive between runs.
For an authenticated local flow, establish the test login within that run, or load
an explicitly supplied test storage-state file with `--storage-state PATH`.
For several tabs, use `context.newPage()` within the same task. Save screenshots
under `.context/` when working in Conductor.

## Ownership and cleanup

- Use the helper rather than launching a standalone browser for ordinary local
  previews. Existing automated test suites and explicitly requested browser or
  device comparisons can continue using their required runner.
- Keep all browser work inside the `run` body; don't detach subprocesses or
  schedule browser actions to outlive it. The helper owns lifecycle management.
- Do not attach to the user's personal Chrome profile, close other agents' pages,
  or use broad process kills such as `pkill Chrome` or `killall Chromium`.
- Check `status` for active task IDs, browser PID, and mode. `stop` closes only this
  helper's browser and refuses while tasks are active. `status` and `stop` never
  start a browser. The helper launches Chromium on demand; it doesn't adopt or
  clean up browsers previously launched by other tools.

The helper is automatically discoverable as a skill, but cannot intercept another
tool's browser launch. Agents must use this workflow for its guarantees to apply.

Playwright's [browser contexts](https://playwright.dev/docs/browser-contexts) provide
the separate task state; the bundled helper adds sharing and lifecycle ownership.
