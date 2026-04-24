// test/localStepRuntime.test.js — prove the local runtime actually executes
// real step code against mocked this/this.data without splice.

'use strict';

const { runStepCodeLocally, runScenarios } = require('../lib/localStepRuntime');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// Representative step code: validates input, reads this.data, exits with payload.
const SIMPLE_STEP = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class WeatherAnomalyGSX extends Step {
  async runStep() {
    const { location, threshold } = this.data;
    if (!location) {
      return this.exitStep('__error__', { code: 'MISSING_INPUT', message: 'location required' });
    }
    this.log.info('Processing location', { location });
    const isAnomaly = (threshold || 0) > 1.0;
    return this.exitStep('next', { location, isAnomaly, score: threshold });
  }
}
globalThis.WeatherAnomalyGSX = WeatherAnomalyGSX;
`;

(async () => {
  console.log('\n== runStepCodeLocally — happy path ==');

  await test('step runs, exits via next with payload', async () => {
    const r = await runStepCodeLocally({
      code: SIMPLE_STEP,
      className: 'WeatherAnomalyGSX',
      data: { location: 'London', threshold: 1.5 },
    });
    assert(r.ok, 'step should complete: ' + JSON.stringify(r));
    assertEq(r.exitId, 'next');
    assertEq(r.exitPayload.location, 'London');
    assertEq(r.exitPayload.isAnomaly, true);
  });

  await test('log.info captured into logs array', async () => {
    const r = await runStepCodeLocally({
      code: SIMPLE_STEP,
      className: 'WeatherAnomalyGSX',
      data: { location: 'Paris', threshold: 0.5 },
    });
    assert(r.ok);
    assert(r.logs.some((l) => l.level === 'info' && l.msg.includes('Processing location')), 'should have info log');
  });

  await test('missing input triggers __error__ exit', async () => {
    const r = await runStepCodeLocally({
      code: SIMPLE_STEP,
      className: 'WeatherAnomalyGSX',
      data: {},
    });
    assert(r.ok);
    assertEq(r.exitId, '__error__');
    assertEq(r.exitPayload.code, 'MISSING_INPUT');
  });

  await test('step completes in < 2s (baseline speed)', async () => {
    const r = await runStepCodeLocally({
      code: SIMPLE_STEP,
      className: 'WeatherAnomalyGSX',
      data: { location: 'x', threshold: 0.5 },
    });
    assert(r.ok);
    assert(r.durationMs < 2000, `expected <2s, got ${r.durationMs}ms`);
  });

  console.log('\n== runStepCodeLocally — error paths ==');

  await test('syntax error surfaces with error message', async () => {
    const r = await runStepCodeLocally({
      code: `const broken syntax here = )`,
      className: 'X',
      data: {},
    });
    assertEq(r.ok, false);
    assert(r.error, 'should have error: ' + JSON.stringify(r));
  });

  await test('unhandled throw in runStep surfaces', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class X extends Step {
  async runStep() {
    throw new Error('boom in runStep');
  }
}
globalThis.X = X;
`;
    const r = await runStepCodeLocally({ code, className: 'X', data: {} });
    assertEq(r.ok, false);
    assert(r.error.includes('boom in runStep'), 'error should include thrown message');
  });

  await test('mergeFields access throws (platform rule 3.1)', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class X extends Step {
  async runStep() {
    const bad = this.mergeFields['httpCall'];  // forbidden
    return this.exitStep('next', { bad });
  }
}
globalThis.X = X;
`;
    const r = await runStepCodeLocally({ code, className: 'X', data: {} });
    assertEq(r.ok, false);
    assert(/mergeFields.*platform rule/.test(r.error || ''), 'should mention platform rule: ' + r.error);
  });

  console.log('\n== runStepCodeLocally — storage mock ==');

  await test('storage.get returns mocked credential', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class AuthStep extends Step {
  async runStep() {
    const Storage = require('or-sdk/storage');
    const storage = new Storage(this);
    const creds = await storage.get('__authorization_service_Anthropic', 'test-id');
    return this.exitStep('next', { apiKey: creds && creds.apiKey });
  }
}
globalThis.AuthStep = AuthStep;
`;
    const r = await runStepCodeLocally({
      code, className: 'AuthStep', data: {},
      opts: {
        mockStorage: {
          '__authorization_service_Anthropic': {
            'test-id': { apiKey: 'sk-ant-mock-xyz' },
          },
        },
      },
    });
    assert(r.ok, JSON.stringify(r));
    assertEq(r.exitPayload.apiKey, 'sk-ant-mock-xyz');
  });

  console.log('\n== runScenarios ==');

  await test('runs multiple scenarios, returns pass/fail counts', async () => {
    const { passed: p, failed: f, total, results } = await runScenarios({
      code: SIMPLE_STEP,
      className: 'WeatherAnomalyGSX',
      scenarios: [
        { name: 'missing location', inputs: {}, expectExit: '__error__', expectCode: 'MISSING_INPUT' },
        { name: 'happy path', inputs: { location: 'London', threshold: 2.0 }, expectExit: 'next' },
        { name: 'low threshold', inputs: { location: 'London', threshold: 0.5 }, expectExit: 'next' },
      ],
    });
    assertEq(total, 3);
    assertEq(p, 3);
    assertEq(f, 0);
  });

  await test('failed scenario is reported', async () => {
    const { passed: p, failed: f, results } = await runScenarios({
      code: SIMPLE_STEP,
      className: 'WeatherAnomalyGSX',
      scenarios: [
        { name: 'wrong-expect', inputs: {}, expectExit: 'next' },  // actually exits __error__
      ],
    });
    assertEq(p, 0);
    assertEq(f, 1);
    assertEq(results[0].ok, false);
  });

  console.log('\n== integration with textEditorTool files ==');

  await test('round-trip: textEditor-built code runs in localRuntime', async () => {
    // Simulate the agent loop: Claude creates a file, then we run it.
    const { dispatchTool } = require('../lib/textEditorTool');
    let state = { files: {}, undoStack: {} };
    state = dispatchTool({
      command: 'create',
      path: 'step.js',
      file_text: SIMPLE_STEP,
    }, state);
    assertEq(state.is_error, false);
    // Run the code from the file dict
    const r = await runStepCodeLocally({
      code: state.files['step.js'],
      className: 'WeatherAnomalyGSX',
      data: { location: 'Tokyo', threshold: 1.5 },
    });
    assert(r.ok);
    assertEq(r.exitId, 'next');
    assertEq(r.exitPayload.location, 'Tokyo');
  });

  console.log('\n== runStepCodeLocally — new-surface parity with real Step class ==');

  await test('all 7 log levels captured (fatal/error/vital/warn/info/debug/trace)', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class LL extends Step {
  async runStep() {
    this.log.fatal('fatal ok');
    this.log.error('error ok');
    this.log.vital('vital ok');
    this.log.warn('warn ok');
    this.log.info('info ok');
    this.log.debug('debug ok');
    this.log.trace('trace ok');
    return this.exitStep('next', {});
  }
}
globalThis.LL = LL;
`;
    const r = await runStepCodeLocally({ code, className: 'LL', data: {} });
    assert(r.ok, JSON.stringify(r));
    const levels = new Set(r.logs.map(l => l.level));
    for (const want of ['fatal','error','vital','warn','info','debug','trace']) {
      assert(levels.has(want), `missing level ${want}: ${[...levels]}`);
    }
  });

  await test('shared/global storage — on this AND on this.thread — backs real state', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class SG extends Step {
  async runStep() {
    await this.setShared('a', 1);
    await this.thread.setShared('b', 2);
    await this.setGlobal('c', 3);
    await this.thread.setGlobal('d', 4);
    const vals = [await this.getShared('a'), await this.thread.getShared('b'),
                  await this.getGlobal('c'), await this.thread.getGlobal('d')];
    return this.exitStep('next', { vals });
  }
}
globalThis.SG = SG;
`;
    const r = await runStepCodeLocally({ code, className: 'SG', data: {} });
    assert(r.ok, JSON.stringify(r));
    assertEq(JSON.stringify(r.exitPayload.vals), '[1,2,3,4]');
  });

  await test('merge-field key objects accepted by this.get / this.set', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class MF extends Step {
  async runStep() {
    const mf = this.getMergeField('tester');
    await this.getset(mf, 'init-val');
    const v = await this.get(mf);
    return this.exitStep('next', { v, mf });
  }
}
globalThis.MF = MF;
`;
    const r = await runStepCodeLocally({ code, className: 'MF', data: {} });
    assert(r.ok, JSON.stringify(r));
    assertEq(r.exitPayload.v, 'init-val');
    assertEq(r.exitPayload.mf.name, 'tester');
    assertEq(r.exitPayload.mf.type, 'session');
  });

  await test('identity getters reflect stepMeta override', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class ID extends Step {
  async runStep() {
    return this.exitStep('next', { id: this.id, label: this.label, type: this.type, exits: this.exits });
  }
}
globalThis.ID = ID;
`;
    const r = await runStepCodeLocally({
      code, className: 'ID', data: {},
      opts: { stepMeta: { id: 's1', label: 'Test', type: 'custom', exits: [{ id: 'next' }] } },
    });
    assert(r.ok, JSON.stringify(r));
    assertEq(r.exitPayload.id, 's1');
    assertEq(r.exitPayload.label, 'Test');
    assertEq(r.exitPayload.type, 'custom');
    assertEq(r.exitPayload.exits.length, 1);
  });

  await test('this.config seeded from opts.config', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class CFG extends Step {
  async runStep() {
    return this.exitStep('next', { config: this.config });
  }
}
globalThis.CFG = CFG;
`;
    const r = await runStepCodeLocally({
      code, className: 'CFG', data: {},
      opts: { config: { accountId: 'acct-1', botId: 'bot-1', flowId: 'flow-1' } },
    });
    assert(r.ok, JSON.stringify(r));
    assertEq(r.exitPayload.config.accountId, 'acct-1');
    assertEq(r.exitPayload.config.botId, 'bot-1');
  });

  await test('triggers.timeout captured into timers[], hasTimeout() returns true', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class T extends Step {
  async runStep() {
    this.triggers.timeout(5000, () => {});
    const has = this.triggers.hasTimeout();
    return this.exitStep('next', { has });
  }
}
globalThis.T = T;
`;
    const r = await runStepCodeLocally({ code, className: 'T', data: {} });
    assert(r.ok, JSON.stringify(r));
    assertEq(r.exitPayload.has, true);
    assertEq(r.timers.length, 1);
    assertEq(r.timers[0].ms, 5000);
    assertEq(r.timers[0].hasCallback, true);
  });

  await test('hooks registration — this.on/once/off are no-op chainable', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class H extends Step {
  async runStep() {
    const chain = this.on('end', () => {}).once('error', () => {}).off('start', () => {});
    return this.exitStep('next', { chained: chain === this });
  }
}
globalThis.H = H;
`;
    const r = await runStepCodeLocally({ code, className: 'H', data: {} });
    assert(r.ok, JSON.stringify(r));
    assertEq(r.exitPayload.chained, true);
  });

  await test('this.thread.task handles happy and error paths', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class TSK extends Step {
  async runStep() {
    const ok  = await this.thread.task(Promise.resolve(99));
    const bad = await this.thread.task(Promise.reject(new Error('nope')));
    return this.exitStep('next', { ok, badMsg: bad && bad.error && bad.error.message });
  }
}
globalThis.TSK = TSK;
`;
    const r = await runStepCodeLocally({ code, className: 'TSK', data: {} });
    assert(r.ok, JSON.stringify(r));
    assertEq(r.exitPayload.ok, 99);
    assertEq(r.exitPayload.badMsg, 'nope');
  });

  await test('unsupported API calls are recorded, not silently swallowed', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class U extends Step {
  async runStep() {
    try { this.triggers.on('x', () => {}); } catch (e) { /* expected */ }
    return this.exitStep('next', {});
  }
}
globalThis.U = U;
`;
    const r = await runStepCodeLocally({ code, className: 'U', data: {} });
    assert(r.ok, JSON.stringify(r));
    assert(r.unsupported.includes('triggers.on'), `unsupported should include triggers.on: ${JSON.stringify(r.unsupported)}`);
  });

  await test('opts.sdkMocks substitutes custom or-sdk packages', async () => {
    const code = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
class USR extends Step {
  async runStep() {
    const Users = require('or-sdk/users');
    const client = new Users(this);
    const u = await client.get('user-1');
    return this.exitStep('next', { u });
  }
}
globalThis.USR = USR;
`;
    const r = await runStepCodeLocally({
      code, className: 'USR', data: {},
      opts: {
        sdkMocks: {
          'or-sdk/users': "function UsersCtor(_t) { return { get(id) { return Promise.resolve({ id, email: 'x@y' }); } }; }",
        },
      },
    });
    assert(r.ok, JSON.stringify(r));
    assertEq(r.exitPayload.u.id, 'user-1');
    assertEq(r.exitPayload.u.email, 'x@y');
  });

  console.log('\n---');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
