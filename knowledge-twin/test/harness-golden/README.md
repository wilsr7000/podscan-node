# Harness Golden Set

This directory contains **target fixture flows** used to cross-validate the Test Harness library step (`library/steps/test-harness/`).

## Purpose

The harness is the trust anchor for the pipeline's behavioral-verification layer. If the harness is buggy, every test-harness we deploy for every target flow is also buggy. We guard against that with a fixture-based differential test:

1. A small set of target flows with **known-correct** behavior (3 fixtures here)
2. A small set of target flows with **known-broken** behavior in specific, documented ways (2 fixtures here)
3. For each fixture + scenario, the "truth" is declared by a human — what verdict should the harness produce?
4. A test script runs the harness against each fixture's scenarios and asserts the harness's verdict matches the declared truth

When the harness template changes, we re-run this suite. If it still produces the declared truth for every fixture, the change is safe. If not, the harness is broken — fix it, don't ship.

## Contents

Each `*.fixture.js` file exports:

```js
module.exports = {
  id: 'fixture-id',
  description: 'What this fixture models',
  serverBehavior: (body, reqNum) => responseBodyOrObject,  // how the mock target responds
  scenarios: [{ name, input, expect }],
  expectedVerdict: 'pass' | 'fail',
  expectedPerScenario: [{ name, ok }],  // ground-truth for each scenario
}
```

The runner (`test/harnessGolden.test.js`) spins up an in-process HTTP server for each fixture, wires it to `serverBehavior`, runs the harness against the fixture's `scenarios`, and checks the output matches `expectedVerdict` + `expectedPerScenario`.

## Versioning

Each fixture file declares which harness version it was validated against in its `validatedAgainst` field. When the harness's major or minor version bumps, fixtures must be re-reviewed by a human and updated. Patch versions are assumed compatible.
