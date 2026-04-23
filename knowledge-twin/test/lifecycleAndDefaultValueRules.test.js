// test/lifecycleAndDefaultValueRules.test.js
// Unit tests for the two new validator rules added in fix E:
//   - LIFECYCLE_LOG_FORMAT: runStep() needs a top-of-body info log; catch
//     blocks need log/throw/exitStep error
//   - DEFAULT_VALUE_MISMATCH: code fallback value differs from spec's
//     declared stepInputs[].data.defaultValue

'use strict';

const { validateStep } = require('../lib/stepValidator');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }

function mkStep(code, { inputs = [] } = {}) {
  return {
    id: 'probe',
    name: 'probe',
    label: 'Probe',
    version: '1.0.0',
    description: '',
    template: code,
    form: {},
    formBuilder: {
      stepInputs: inputs.map((i) => ({
        component: i.component || 'formTextInput',
        data: { variable: i.variable, label: i.label || i.variable, defaultValue: i.defaultValue },
      })),
    },
    data: { exits: [{ id: 'next' }, { id: '__error__', condition: 'processError' }], processError: true },
  };
}

function run(step) {
  const v = validateStep(step);
  return v.diagnostics || [];
}

console.log('\n== LIFECYCLE_LOG_FORMAT ==');

test('runStep missing top-of-body info log triggers LIFECYCLE_LOG_FORMAT', () => {
  const code = `
class X {
  async runStep() {
    const { foo } = this.data;
    const result = foo.toUpperCase();
    return this.exitStep('next', { result });
  }
}
`;
  const diags = run(mkStep(code));
  const hits = diags.filter((d) => d.code === 'LIFECYCLE_LOG_FORMAT');
  assert(hits.length > 0, 'should flag missing top log');
  assert(/no this\.log\.info/.test(hits[0].message), 'message mentions missing info log');
});

test('runStep WITH top-of-body info log does NOT trigger', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('X starting', { keys: Object.keys(this.data) });
    const { foo } = this.data;
    return this.exitStep('next', { foo });
  }
}
`;
  const diags = run(mkStep(code));
  const topHits = diags.filter((d) => d.code === 'LIFECYCLE_LOG_FORMAT' && /no this\.log\.info/.test(d.message));
  assert(topHits.length === 0, 'should NOT flag when top log present');
});

test('catch block with no log / no throw / no error-exit triggers', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    try {
      doThing();
    } catch (err) {
      return this.exitStep('next', { ok: false });
    }
    return this.exitStep('next', { ok: true });
  }
}
`;
  const diags = run(mkStep(code));
  const catchHits = diags.filter((d) => d.code === 'LIFECYCLE_LOG_FORMAT' && /catch block/.test(d.message));
  assert(catchHits.length > 0, 'should flag catch that silently swallows');
});

test('catch block with this.log.error does NOT trigger', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    try {
      doThing();
    } catch (err) {
      this.log.error('caught', { message: err.message });
      return this.exitStep('next', { ok: false });
    }
    return this.exitStep('next', { ok: true });
  }
}
`;
  const diags = run(mkStep(code));
  const catchHits = diags.filter((d) => d.code === 'LIFECYCLE_LOG_FORMAT' && /catch block/.test(d.message));
  assert(catchHits.length === 0, 'catch with log.error should not flag');
});

test('catch block with exitStep __error__ does NOT trigger', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    try {
      doThing();
    } catch (err) {
      return this.exitStep('__error__', { code: 'INTERNAL_ERROR', message: err.message });
    }
    return this.exitStep('next', { ok: true });
  }
}
`;
  const diags = run(mkStep(code));
  const catchHits = diags.filter((d) => d.code === 'LIFECYCLE_LOG_FORMAT' && /catch block/.test(d.message));
  assert(catchHits.length === 0, 'catch with exitStep __error__ should not flag');
});

test('catch block with throw does NOT trigger', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    try {
      doThing();
    } catch (err) {
      throw new Error('wrapping: ' + err.message);
    }
    return this.exitStep('next', { ok: true });
  }
}
`;
  const diags = run(mkStep(code));
  const catchHits = diags.filter((d) => d.code === 'LIFECYCLE_LOG_FORMAT' && /catch block/.test(d.message));
  assert(catchHits.length === 0, 'catch with throw should not flag');
});

console.log('\n== DEFAULT_VALUE_MISMATCH ==');

test('code fallback matches spec default — no diagnostic', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    const mode = this.data.mode || 'current';
    return this.exitStep('next', { mode });
  }
}
`;
  const diags = run(mkStep(code, {
    inputs: [{ variable: 'mode', defaultValue: 'current' }],
  }));
  const hits = diags.filter((d) => d.code === 'DEFAULT_VALUE_MISMATCH');
  assert(hits.length === 0, 'matching fallback should not flag; got: ' + JSON.stringify(hits));
});

test('code fallback differs from spec default — triggers', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    const mode = this.data.mode || 'forecast';
    return this.exitStep('next', { mode });
  }
}
`;
  const diags = run(mkStep(code, {
    inputs: [{ variable: 'mode', defaultValue: 'current' }],
  }));
  const hits = diags.filter((d) => d.code === 'DEFAULT_VALUE_MISMATCH');
  assert(hits.length === 1, 'should flag mismatched fallback; got ' + hits.length);
  assert(hits[0].context.variable === 'mode', 'variable correct');
  assert(hits[0].context.codeFallback === 'forecast', 'codeFallback correct');
  assert(hits[0].context.specDefault === 'current', 'specDefault correct');
});

test('?? operator also triggers DEFAULT_VALUE_MISMATCH', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    const mode = this.data.mode ?? 'foo';
    return this.exitStep('next', { mode });
  }
}
`;
  const diags = run(mkStep(code, {
    inputs: [{ variable: 'mode', defaultValue: 'bar' }],
  }));
  const hits = diags.filter((d) => d.code === 'DEFAULT_VALUE_MISMATCH');
  assert(hits.length === 1, 'nullish-coalesce mismatch should flag');
});

test('ternary pattern also triggers', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    const mode = this.data.mode ? this.data.mode : 'alpha';
    return this.exitStep('next', { mode });
  }
}
`;
  const diags = run(mkStep(code, {
    inputs: [{ variable: 'mode', defaultValue: 'beta' }],
  }));
  const hits = diags.filter((d) => d.code === 'DEFAULT_VALUE_MISMATCH');
  assert(hits.length === 1, 'ternary mismatch should flag');
});

test('no fallback in code — no diagnostic (there is nothing to compare)', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    const mode = this.data.mode;
    return this.exitStep('next', { mode });
  }
}
`;
  const diags = run(mkStep(code, {
    inputs: [{ variable: 'mode', defaultValue: 'current' }],
  }));
  const hits = diags.filter((d) => d.code === 'DEFAULT_VALUE_MISMATCH');
  assert(hits.length === 0, 'no fallback → no comparison → no diag');
});

test('spec default wrapped in backticks is normalized before comparison', () => {
  const code = `
class X {
  async runStep() {
    this.log.info('start');
    const region = this.data.region || 'us-east-1';
    return this.exitStep('next', { region });
  }
}
`;
  const diags = run(mkStep(code, {
    inputs: [{ variable: 'region', defaultValue: '`us-east-1`' }],  // the backtick-wrapped form seen in Edison step.json
  }));
  const hits = diags.filter((d) => d.code === 'DEFAULT_VALUE_MISMATCH');
  assert(hits.length === 0, 'backtick-stripped match should not flag');
});

console.log(`\n---\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
