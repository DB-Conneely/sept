import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "../../src/durable/index.js";
import { validateRequest } from "../../src/ingress/index.js";
import {
  decideRollover,
  initialRolloverEvidence,
  loadRolloverEvidence,
  providerContextTokens,
  recordUnusableSample,
  recordUsableSample,
  saveRolloverEvidence,
} from "../../src/pi-integration/index.js";

function store() {
  const root = mkdtempSync(join(tmpdir(), "sept-rollover-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return RunStore.create(
    join(root, "runs"),
    validateRequest({ task: "roll over safely", workspace }, "0.85.1"),
  );
}

test("adaptive arithmetic has exact boundaries across 128k, 272k, and approximately 1M windows", () => {
  const cases = [
    { window: 128_000, headroom: 28_672, at: 99_328 },
    { window: 272_000, headroom: 59_840, at: 212_160 },
    { window: 1_048_576, headroom: 212_338, at: 836_238 },
  ];
  for (const value of cases) {
    const before = decideRollover(value.at - 1, value.window, []);
    assert.equal(before.headroomTokens, value.headroom);
    assert.equal(before.rotate, false);
    assert.equal(decideRollover(value.at, value.window, []).rotate, true);
  }
});

test("ordinary and tool-heavy growth use the largest of the last three positive deltas without a cap", () => {
  const ordinary = decideRollover(100_000, 272_000, [4_000, 6_000]);
  assert.equal(ordinary.nextTurnReserveTokens, 16_320);
  assert.equal(ordinary.confidenceMarginTokens, 8_160);
  assert.equal(ordinary.confidence, "high");

  const heavy = decideRollover(700_000, 1_048_576, [10_000, 200_000, 20_000]);
  assert.equal(heavy.recentGrowthTokens, 200_000);
  assert.equal(heavy.nextTurnReserveTokens, 300_000);
  assert.equal(heavy.headroomTokens, 396_994);
  assert.equal(heavy.rotate, true);
  assert.equal(heavy.reason, "required_headroom_reached");
});

test("evidence keeps only positive growth, rejects regression, defers unusable usage, and scopes restart state", () => {
  const run = store();
  let evidence = initialRolloverEvidence("provider", "model", "session-one", 128_000);
  evidence = recordUsableSample(evidence, 10_000).evidence;
  evidence = recordUsableSample(evidence, 10_000).evidence;
  evidence = recordUsableSample(evidence, 15_000).evidence;
  evidence = recordUsableSample(evidence, 17_000).evidence;
  evidence = recordUsableSample(evidence, 18_000).evidence;
  assert.deepEqual(evidence.growthTokens, [5_000, 2_000, 1_000]);
  assert.throws(() => recordUsableSample(evidence, 17_999), /regressed/);
  evidence = recordUnusableSample(
    recordUnusableSample(recordUnusableSample(recordUnusableSample(evidence))),
  );
  assert.equal(evidence.unusableSamples, 3);
  saveRolloverEvidence(run, evidence);
  assert.deepEqual(
    loadRolloverEvidence(run, "provider", "model", "session-one", 128_000),
    evidence,
  );
  assert.equal(
    loadRolloverEvidence(run, "provider", "model", "session-two", 128_000).lastTokens,
    undefined,
  );
});

test("only complete positive provider usage can become context evidence", () => {
  const calculate = (value: never): number => (value as { totalTokens: number }).totalTokens;
  assert.equal(
    providerContextTokens(
      { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6 },
      calculate,
    ),
    6,
  );
  assert.equal(
    providerContextTokens(
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      calculate,
    ),
    undefined,
  );
  assert.equal(
    providerContextTokens(
      { input: 4, output: -1, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
      calculate,
    ),
    undefined,
  );
  assert.equal(providerContextTokens(undefined, calculate), undefined);
});
