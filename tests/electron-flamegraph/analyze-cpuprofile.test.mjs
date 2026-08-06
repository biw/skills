import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const analyzer = join(repoRoot, "skills/electron-flamegraph/scripts/analyze-cpuprofile.mjs");

test("reports long time deltas as sampling gaps rather than proven stalls", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "cpuprofile-"));
  const profilePath = join(temporaryRoot, "fixture.cpuprofile");

  try {
    writeFileSync(
      profilePath,
      JSON.stringify({
        startTime: 0,
        endTime: 101_000,
        nodes: [
          {
            id: 1,
            callFrame: { functionName: "(root)", url: "", lineNumber: -1 },
            children: [2],
          },
          {
            id: 2,
            callFrame: { functionName: "work", url: "file:///app/main.js", lineNumber: 9 },
          },
        ],
        samples: [2, 2],
        timeDeltas: [1_000, 100_000],
      }),
    );

    const report = execFileSync("node", [analyzer, profilePath, "--sampling-gap-threshold-ms=50"], {
      encoding: "utf8",
    });
    assert.match(report, /Large sampling gaps/);
    assert.match(report, /sampling gap — sample after gap/);
    assert.match(report, /not proof of a main-thread stall/);
    assert.doesNotMatch(report, /Event loop was not blocked/);

    const json = JSON.parse(
      execFileSync("node", [analyzer, profilePath, "--sampling-gap-threshold-ms=50", "--json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(json.samplingGaps.length, 1);
    assert.equal(json.samplingGaps[0].durationUs, 100_000);
    assert.equal("stalls" in json, false);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
