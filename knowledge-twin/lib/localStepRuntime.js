// ---------------------------------------------------------------------------
// localStepRuntime.js — execute a step's logic.js LOCALLY against a mock
// Edison runtime, without splice/deploy.
//
// Why: the pipeline's current test cycle is
//   generateCode → harness → splice → activate → POST scenarios
// which takes 30-90s per iteration. The agent loop needs sub-second feedback
// or its inner-loop budget is gone before Claude can learn.
//
// What we mock (tracks the real @onereach/flow-sdk/step.js surface):
//   this.data              — populated from the scenario's inputs
//   this.log.*             — 7 levels (fatal/error/vital/warn/info/debug/trace)
//                             plus uppercase optional variants and
//                             setFlowLogLevel / setLocalLogLevel / isEnabled
//   this.exitStep(id, payload)   — captured as the step's outcome; throws a
//                                   sentinel to unwind the runStep() call
//   this.end / this.exitFlow     — same sentinel, with reserved exit ids
//   this.get / set / unset / getset / getMergeField  — merge-field-aware KV,
//                                   accepts string | string[] | IMergeField keys
//   this.getShared / setShared / getGlobal / setGlobal  — in-memory backing,
//                                   library steps call these on `this` with a
//                                   typeof guard and we honor that
//   this.triggers.*        — structurally complete; individual methods throw
//                             a clear 'not supported in local runtime' error
//                             (and record into globalThis.__localStepUnsupported)
//   this.on / once / off   — no-op, chainable (lifecycle hook registration)
//   this.mergeFields[...]  — deliberately throws (violates §3.1); Symbol and
//                             then/catch/finally lookups return undefined so
//                             async/await thenable checks don't trip the guard
//   this.state             — BaseThreadState shape (name/phase/step/ended/…)
//   this.step              — stub IStepData (id/label/type/exits/template/…)
//   this.thread            — routes this.thread.* to thread-level stubs (task,
//                             getShared, emit*, emitHttp, fork, waitBroadcast,
//                             callExit, …); anything unsupported throws clearly
//   Identity getters: this.id / label / type / template / exits / dataOut /
//     currentStep / currentStepId / event
//   Lifecycle stubs: initData / run / runBefore / runAfter / runHandle /
//     resolveDataIn / resolveSettings
//
// The scenario opts may override:
//   opts.mockStorage     — { collection: { authId: creds } } for or-sdk/storage
//   opts.kvInitial       — seed for this.get / this.set (session-scope merge fields)
//   opts.sharedInitial   — seed for this.getShared / setShared
//   opts.globalInitial   — seed for this.getGlobal / setGlobal
//   opts.stepMeta        — merged into this.step (id/label/type/exits/template/…)
//   opts.state           — merged into this.state (name/phase/step/ended/…)
//   opts.settings        — assigned to this.settings
//   opts.config          — merged into this.config (accountId, botId, flowId, …)
//   opts.timeoutsAuto    — if true, auto-fire this.triggers.timeout(ms, cb)
//                           callbacks (simulates Edison's timer scheduler).
//                           Default: false (callbacks captured in __timers for
//                           inspection by tests).
//   opts.sdkMocks        — { 'or-sdk/users': factoryExpr, 'or-sdk/files': …}
//                           each value is a JS expression string that replaces
//                           require('or-sdk/<pkg>') / await import('or-sdk/<pkg>').
//                           Evaluated at step load time with access to
//                           globalThis.__localStep*. Keep each expression
//                           self-contained (no outer refs).
//
// Limitations (documented, acceptable):
//   - No support for gateway steps that drive behavior via this.triggers.on(...)
//     or this.thread.fork(...) — those paths throw clear 'not supported' errors
//   - or-sdk packages other than or-sdk/storage are not stubbed; steps that
//     import them must declare them in modules[] and the runtime must supply
//     them (not available locally)
//   - Node 20+ required (async top-level import, ESM dynamic import)
//   - Code is evaluated in a child process for isolation (no VM sandbox
//     escape, each scenario is fresh)
// ---------------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// runStepCodeLocally — main entry.
//
// Input:
//   code       — the logic.js source (full file, including the Step class wrapper)
//   className  — the class name to instantiate (e.g. 'WeatherAnomalyGSX')
//   data       — initial this.data (inputs for this scenario)
//   opts       — {
//                  timeoutMs = 10000
//                  mockStorage = {}           // { collection: { authId: creds } }
//                  kvInitial = {}             // initial this.get/set KV
//                  log = console.log          // progress log
//                }
//
// Output:
//   {
//     ok: bool,                    // did the step complete without unhandled throw
//     exitId: string | null,       // the id passed to this.exitStep()
//     exitPayload: any,            // the second arg to this.exitStep()
//     logs: [{level, msg, data}],  // captured this.log.* calls
//     error: string | null,        // caught exception message
//     durationMs,
//   }
// ---------------------------------------------------------------------------
async function runStepCodeLocally({ code, className, data = {}, opts = {} } = {}) {
  if (typeof code !== 'string' || !code) throw new Error('code is required');
  if (typeof className !== 'string' || !className) throw new Error('className is required');
  const timeoutMs = Number(opts.timeoutMs) || 10_000;

  // Write the step code + harness to a temp .mjs file, run it in a child.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'localStep-'));
  const codeFile = path.join(tmpDir, 'step.mjs');
  const harnessFile = path.join(tmpDir, 'harness.mjs');
  const contextFile = path.join(tmpDir, 'context.json');

  try {
    const rewritten = _rewriteStepCode(code, opts.sdkMocks || {});
    fs.writeFileSync(codeFile, rewritten, 'utf8');
    fs.writeFileSync(contextFile, JSON.stringify({
      className,
      data,
      mockStorage: opts.mockStorage || {},
      kvInitial: opts.kvInitial || {},
      sharedInitial: opts.sharedInitial || {},
      globalInitial: opts.globalInitial || {},
      stepMeta: opts.stepMeta || {},
      state: opts.state || {},
      settings: opts.settings || {},
      config: opts.config || {},
      timeoutsAuto: Boolean(opts.timeoutsAuto),
      sdkMocks: opts.sdkMocks || {},
    }), 'utf8');
    fs.writeFileSync(harnessFile, HARNESS_SOURCE, 'utf8');

    const startMs = Date.now();
    const result = await runChild(harnessFile, [codeFile, contextFile], timeoutMs);
    return {
      ok: result.ok,
      exitId: result.exitId,
      exitPayload: result.exitPayload,
      logs: result.logs || [],
      unsupported: result.unsupported || [],
      timers: result.timers || [],
      error: result.error || null,
      durationMs: Date.now() - startMs,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// _rewriteStepCode — substitute user-supplied or-sdk/* mocks into the step
// source before writing it to disk. Done in the parent process (where regex
// escape is simple) rather than inside HARNESS_SOURCE (where nested template-
// literal escaping gets hairy).
//
// sdkMocks = { 'or-sdk/users': "function(_t) { return { get: id => Promise.resolve({id}) }; }", ... }
// Each value is a JS expression string that evaluates to the module's default
// export. Whitespace variants of require(...) / (await import(...)).then(...) /
// await import(...) are all rewritten.
// ---------------------------------------------------------------------------
function _rewriteStepCode(code, sdkMocks) {
  let out = String(code);
  for (const [pkg, expr] of Object.entries(sdkMocks)) {
    const safePkg = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const factory = '(' + expr + ')';
    const requireRe   = new RegExp('require\\(\\s*[\'"]' + safePkg + '[\'"]\\s*\\)', 'g');
    const awaitThenRe = new RegExp('\\(\\s*await\\s+import\\(\\s*[\'"]' + safePkg + '[\'"]\\s*\\)\\.then\\([^)]*\\)\\s*\\)', 'g');
    const awaitRe     = new RegExp('await\\s+import\\(\\s*[\'"]' + safePkg + '[\'"]\\s*\\)', 'g');
    out = out.replace(requireRe,   factory);
    out = out.replace(awaitThenRe, factory);
    out = out.replace(awaitRe,     '{ default: ' + factory + ' }');
  }
  return out;
}

function runChild(script, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: `timed out after ${timeoutMs}ms`, stderr });
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stdout.trim().length === 0) {
        resolve({ ok: false, error: `child exited ${code} with no stdout`, stderr: stderr.slice(0, 2000) });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim().split('\n').pop());
        resolve(parsed);
      } catch (err) {
        resolve({ ok: false, error: `failed to parse child output: ${err.message}`, stdout: stdout.slice(0, 2000), stderr: stderr.slice(0, 2000) });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// The harness script that runs inside the child process. Receives the code
// + context via argv, imports the code as a module, instantiates the class,
// invokes runStep() against a mocked `this`, and prints a JSON result.
//
// Stored as a constant (written to disk at runtime) rather than a separate
// file in the repo so it ships with lib/localStepRuntime.js atomically.
//
// The shim shape tracks the real flow-sdk Step class closely — see the top
// of this file for the property/method inventory.
// ---------------------------------------------------------------------------
const HARNESS_SOURCE = `
import fs from 'node:fs';

const [,, codeFile, ctxFile] = process.argv;
const ctx = JSON.parse(fs.readFileSync(ctxFile, 'utf8'));

// Mocks the injected shim and rewritten step code will read.
globalThis.__localStepMockStorage = ctx.mockStorage || {};
globalThis.__localStepKV          = { ...(ctx.kvInitial     || {}) };
globalThis.__localStepShared      = { ...(ctx.sharedInitial || {}) };
globalThis.__localStepGlobal      = { ...(ctx.globalInitial || {}) };
globalThis.__localStepLogs        = [];
globalThis.__localStepUnsupported = [];
globalThis.__localStepTimers      = [];      // [{ ms, callback }]
globalThis.__localStepTimeoutsAuto = Boolean(ctx.timeoutsAuto);
globalThis.__localStepConfig      = { ...(ctx.config || {}) };

// -----------------------------------------------------------------------
// Source rewriting: redirect Edison imports to our injected shim so the
// step's own \`await import('@onereach/flow-sdk/step.js')\` (or the
// compiler-rewritten require form) reads from a data URI carrying our
// mock Step class.
// -----------------------------------------------------------------------
let stepCode = fs.readFileSync(codeFile, 'utf8');

// Canonical generator form.
stepCode = stepCode.replace(
  /await\\s+import\\(\\s*['"]@onereach\\/flow-sdk\\/step\\.js['"]\\s*\\)/g,
  'await import("data:text/javascript," + encodeURIComponent(globalThis.__STEP_SHIM_SRC))'
);

// Compiler-rewritten require form: (await import('...').then(mod => mod.default || mod)).
stepCode = stepCode.replace(
  /\\(\\s*await\\s+import\\(\\s*['"]@onereach\\/flow-sdk\\/step\\.js['"]\\s*\\)\\.then\\([^)]*\\)\\s*\\)/g,
  '(await import("data:text/javascript," + encodeURIComponent(globalThis.__STEP_SHIM_SRC))).default'
);

// Raw require (pre-compile form).
stepCode = stepCode.replace(
  /require\\(\\s*['"]@onereach\\/flow-sdk\\/step\\.js['"]\\s*\\)/g,
  '(await import("data:text/javascript," + encodeURIComponent(globalThis.__STEP_SHIM_SRC))).default'
);

// or-sdk/storage — stub with the mock in all known import shapes.
const mockStorageExpr = '(function MockStorageCtor(_this) { return { get(collection, id) { const c = globalThis.__localStepMockStorage[collection] || {}; return Promise.resolve(c[id] || null); } }; })';
stepCode = stepCode.replace(
  /require\\(\\s*['"]or-sdk\\/storage['"]\\s*\\)/g,
  mockStorageExpr
);
stepCode = stepCode.replace(
  /\\(\\s*await\\s+import\\(\\s*['"]or-sdk\\/storage['"]\\s*\\)\\.then\\([^)]*\\)\\s*\\)/g,
  mockStorageExpr
);
stepCode = stepCode.replace(
  /await\\s+import\\(\\s*['"]or-sdk\\/storage['"]\\s*\\)/g,
  '{ default: ' + mockStorageExpr + ' }'
);

// Pluggable or-sdk/* mocks — each package registered via opts.sdkMocks has
// already been substituted into the code by the parent process (see
// _rewriteStepCode below). Nothing to do here; the code on disk is ready.

// -----------------------------------------------------------------------
// The Step shim — closely mirrors @onereach/flow-sdk/step.js. Written as
// source text so the step code can import it via data: URI.
// -----------------------------------------------------------------------
globalThis.__STEP_SHIM_SRC = \`
  // Record a call to an API we don't simulate locally, then throw a clear
  // 'not supported' error. Code that relies on gateway/channel/HTTP-emit
  // semantics fails loudly rather than silently returning undefined.
  function __notSupported(api) {
    return function () {
      globalThis.__localStepUnsupported.push(api);
      throw new Error('this.' + api + ' is not supported in the local step runtime');
    };
  }

  // Accepts string | string[] | IMergeField (real merge-field key shape).
  function __normKey(k) {
    if (typeof k === 'string') return k;
    if (Array.isArray(k)) return k.join('.');
    if (k && typeof k === 'object') {
      if (typeof k.name === 'string') return k.name;
      if (Array.isArray(k.path)) return k.path.join('.');
      if (typeof k.path === 'string') return k.path;
    }
    return String(k);
  }

  // 7-level logger matching ILogger (flow-sdk/src/types/logger.ts).
  function __makeLogger(bucket) {
    const mk = function (level) {
      return function (msg, data) {
        const entry = { level: level, msg: msg, data: data };
        bucket.push(entry);
        globalThis.__localStepLogs.push(entry);
      };
    };
    return {
      fatal: mk('fatal'), error: mk('error'), vital: mk('vital'),
      warn:  mk('warn'),  info:  mk('info'),  debug: mk('debug'), trace: mk('trace'),
      FATAL: mk('fatal'), ERROR: mk('error'), VITAL: mk('vital'),
      WARN:  mk('warn'),  INFO:  mk('info'),  DEBUG: mk('debug'), TRACE: mk('trace'),
      isEnabled:        function () { return true; },
      setFlowLogLevel:  function () {},
      setLocalLogLevel: function () {},
      context: {},
    };
  }

  // Sentinel thrown by the exit-family methods so the harness can unwind
  // runStep deterministically.
  function __throwExit(self, id, payload) {
    self.__exitId = id;
    self.__exitPayload = payload;
    const e = new Error('__LOCAL_STEP_EXIT__');
    e.__localStepExit = true;
    throw e;
  }

  // Thread-level proxy (reached via this.thread.*). Mirrors IThread surface;
  // unsupported APIs throw, supported ones run against the in-memory backing.
  function __makeThread(self) {
    return {
      get id() { return 'local-thread'; },
      log: self.log,
      syslog: self.log,
      config: self.config,
      flow: self.flow,
      process: self.process,
      session: self.session,
      helpers: self.helpers,
      reporter: self.reporter,
      mergeFields: self.mergeFields,
      get state() { return self.state; },
      set state(v) { self.state = v; },
      local: {},
      waits: {},
      get: function (k, d) {
        const key = __normKey(k);
        const v = globalThis.__localStepKV[key];
        return Promise.resolve(v === undefined ? d : v);
      },
      getset: function (k, valueOrFn) {
        const key = __normKey(k);
        if (globalThis.__localStepKV[key] === undefined) {
          globalThis.__localStepKV[key] = typeof valueOrFn === 'function' ? valueOrFn() : valueOrFn;
        }
        return Promise.resolve(globalThis.__localStepKV[key]);
      },
      set: function (k, v) {
        globalThis.__localStepKV[__normKey(k)] = v;
        return Promise.resolve(v);
      },
      unset: function (k) {
        delete globalThis.__localStepKV[__normKey(k)];
        return Promise.resolve();
      },
      getMergeField: function (k) {
        const n = __normKey(k);
        return { name: n, path: [n], type: 'session' };
      },
      getShared: function (path, def) {
        const v = globalThis.__localStepShared[path];
        return Promise.resolve(v === undefined ? def : v);
      },
      setShared: function (path, value) {
        globalThis.__localStepShared[path] = value;
        return Promise.resolve(value);
      },
      getGlobal: function (path, def) {
        const v = globalThis.__localStepGlobal[path];
        return Promise.resolve(v === undefined ? def : v);
      },
      setGlobal: function (path, value) {
        globalThis.__localStepGlobal[path] = value;
        return Promise.resolve(value);
      },
      getDataOut: function (def) { return Promise.resolve(self.__dataOut === undefined ? def : self.__dataOut); },
      setDataOut: function (v)   { self.__dataOut = v; return Promise.resolve(); },
      end:        function (r)   { __throwExit(self, '__end__', r); },
      exitFlow:   function (r)   { __throwExit(self, '__exitFlow__', r); },
      exitState:  __notSupported('thread.exitState'),
      gotoState:  __notSupported('thread.gotoState'),
      exitStep:   function (id, payload) { return self.exitStep(id, payload); },
      callExit:   __notSupported('thread.callExit'),
      callState:  __notSupported('thread.callState'),
      jumpTo:     __notSupported('thread.jumpTo'),
      emit:              __notSupported('thread.emit'),
      emitSync:          __notSupported('thread.emitSync'),
      emitAsync:         __notSupported('thread.emitAsync'),
      emitQueue:         __notSupported('thread.emitQueue'),
      emitMultiple:      __notSupported('thread.emitMultiple'),
      emitMultipleSync:  __notSupported('thread.emitMultipleSync'),
      emitMultipleAsync: __notSupported('thread.emitMultipleAsync'),
      emitMultipleQueue: __notSupported('thread.emitMultipleQueue'),
      emitHttp:          __notSupported('thread.emitHttp'),
      waitBroadcast:     __notSupported('thread.waitBroadcast'),
      fork:              __notSupported('thread.fork'),
      task: async function (promise, throwError) {
        try { return await promise; }
        catch (err) { if (throwError) throw err; return { error: err }; }
      },
      on:   function () { return this; },
      once: function () { return this; },
      off:  function () { return this; },
    };
  }

  // Triggers proxy. Structurally complete; timeout and deadline are real
  // (via setTimeout when globalThis.__localStepTimeoutsAuto is true, or
  // captured into globalThis.__localStepTimers for inspection otherwise).
  // Event-oriented methods (on/once/off/local/hook/otherwise/add/handle/match)
  // throw 'not supported' — they need a real event manager.
  function __makeTriggers() {
    let _hasTimeout = false;
    const _scheduleTimeout = function (ms, callback) {
      const entry = { ms: Number(ms) || 0, callback: callback || null, scheduledAt: Date.now() };
      globalThis.__localStepTimers.push(entry);
      _hasTimeout = true;
      if (globalThis.__localStepTimeoutsAuto && typeof callback === 'function') {
        const t = setTimeout(function () {
          try { callback(); } catch (e) { /* swallow — tests can inspect logs */ }
        }, entry.ms);
        if (t && typeof t.unref === 'function') t.unref();
      }
      return entry;
    };
    return {
      on:             __notSupported('triggers.on'),
      once:           __notSupported('triggers.once'),
      off:            __notSupported('triggers.off'),
      local:          __notSupported('triggers.local'),
      hook:           __notSupported('triggers.hook'),
      otherwise:      __notSupported('triggers.otherwise'),
      timeout:        function (ms, cb) {
        // Real signature: triggers.timeout(ms, cb?) OR triggers.timeout(cb).
        if (typeof ms === 'function' && cb === undefined) return _scheduleTimeout(0, ms);
        return _scheduleTimeout(ms, cb);
      },
      deadline:       function (epochMs, cb) {
        const remaining = Math.max(0, Number(epochMs) - Date.now());
        return _scheduleTimeout(remaining, cb);
      },
      hasTimeout:     function () { return _hasTimeout; },
      refreshAll:     function () {},
      refreshTimeout: function (ms) { return _scheduleTimeout(ms, null); },
      add:            __notSupported('triggers.add'),
      flush:          async function () {},
      handle:         __notSupported('triggers.handle'),
      match:          __notSupported('triggers.match'),
      config:         function (c) { return c; },
    };
  }

  export default class Step {
    constructor() {
      this.__exitId      = null;
      this.__exitPayload = null;
      this.__logs        = [];
      this.__dataOut     = undefined;
      this.__event       = undefined;

      this.data = {};
      this.settings = {};
      this.step = {
        id: 'local-step',
        label: 'Local Step',
        type: 'local',
        exits: [],
        template: { id: 'local-template', label: 'Local Template', version: '0.0.0' },
        dataOut: undefined,
      };

      // BaseThreadState shape (flow-sdk/src/types/thread.ts:118).
      this.state = {
        name: undefined, phase: undefined, step: 'local-step',
        ended: false, ending: false, waits: {}, current: undefined, result: undefined,
      };

      this.log = __makeLogger(this.__logs);
      this.syslog = this.log;

      // Minimal stubs for service surfaces library code may reference.
      // this.config is seeded from ctx.config so steps can read accountId /
      // botId / flowId / stage without silently getting undefined.
      this.config = { ...(globalThis.__localStepConfig || {}) };
      this.flow = {};
      this.process = {};
      this.session = { id: 'local-session' };
      this.helpers = {
        formatError: function (err) { return (err && err.stack) || String(err); },
      };
      this.reporter = {
        fire: function () {},
        write: function () {},
      };
      this.local = {};
      this.waits = {};

      // mergeFields — forbidden per §3.1. Symbol and thenable lookups return
      // undefined so async/await's thenable check doesn't trip the guard.
      this.mergeFields = new Proxy({}, {
        get(_t, prop) {
          if (typeof prop === 'symbol') return undefined;
          if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined;
          throw new Error('this.mergeFields[' + String(prop) + '] — violates platform rule 3.1 (read inputs from this.data instead)');
        },
      });

      const self = this;

      // Merge-field API. In the real SDK these resolve to thread/session/shared/
      // global based on key type; here we treat string keys as a flat session
      // KV, and honor IMergeField objects via __normKey.
      this.get = function (key, def) {
        const k = __normKey(key);
        const v = globalThis.__localStepKV[k];
        return Promise.resolve(v === undefined ? def : v);
      };
      this.getset = function (key, valueOrFn) {
        const k = __normKey(key);
        if (globalThis.__localStepKV[k] === undefined) {
          globalThis.__localStepKV[k] = typeof valueOrFn === 'function' ? valueOrFn() : valueOrFn;
        }
        return Promise.resolve(globalThis.__localStepKV[k]);
      };
      this.set = function (key, val) {
        globalThis.__localStepKV[__normKey(key)] = val;
        return Promise.resolve(val);
      };
      this.unset = function (key) {
        delete globalThis.__localStepKV[__normKey(key)];
        return Promise.resolve();
      };
      this.getMergeField = function (key) {
        const n = __normKey(key);
        return { name: n, path: [n], type: 'session' };
      };

      // Shared/global — typed as thread-only but library steps call these on
      // \\\`this\\\` with typeof guards and the Edison runtime proxy exposes them.
      // Back with separate in-memory maps so scoping is observable.
      this.getShared = function (path, def) {
        const v = globalThis.__localStepShared[path];
        return Promise.resolve(v === undefined ? def : v);
      };
      this.setShared = function (path, value) {
        globalThis.__localStepShared[path] = value;
        return Promise.resolve(value);
      };
      this.getGlobal = function (path, def) {
        const v = globalThis.__localStepGlobal[path];
        return Promise.resolve(v === undefined ? def : v);
      };
      this.setGlobal = function (path, value) {
        globalThis.__localStepGlobal[path] = value;
        return Promise.resolve(value);
      };

      // DataOut accessors.
      this.getDataOut = function (def) {
        return Promise.resolve(self.__dataOut === undefined ? def : self.__dataOut);
      };
      this.setDataOut = function (v) { self.__dataOut = v; return Promise.resolve(); };

      // Flow-level navigation. end / exitFlow throw sentinels the harness
      // unwinds; exitState / gotoState aren't simulable locally.
      this.end       = function (r) { __throwExit(self, '__end__', r); };
      this.exitFlow  = function (r) { __throwExit(self, '__exitFlow__', r); };
      this.exitState = __notSupported('exitState');
      this.gotoState = __notSupported('gotoState');

      // Exit-id helpers backed by this.exits.
      this.getExitStepId = function (labelOrId) {
        const list = self.exits || [];
        const m = list.find(function (e) { return e && (e.id === labelOrId || e.label === labelOrId); });
        return m ? m.stepId : undefined;
      };
      this.getExitStepLabel = function (labelOrId) {
        const list = self.exits || [];
        const m = list.find(function (e) { return e && (e.id === labelOrId || e.label === labelOrId); });
        return m ? m.label : undefined;
      };

      // Triggers — structurally complete; individual methods throw cleanly.
      this.triggers = __makeTriggers();

      // Step hook registration (this.on/once/off). No-op, chainable.
      this.on   = function () { return self; };
      this.once = function () { return self; };
      this.off  = function () { return self; };

      // Thread proxy — this.thread.* routes to thread-level stubs.
      this.thread = __makeThread(self);
    }

    // Identity getters.
    get id()             { return this.step.id; }
    get label()          { return this.step.label; }
    get type()           { return this.step.type; }
    get template()       { return this.step.template; }
    get exits()          { return this.step.exits; }
    get dataOut()        { return this.step.dataOut; }
    get currentStep()    { return this; }
    get currentStepId()  { return this.step.id; }
    get event()          { return this.__event; }
    set event(v)         { this.__event = v; }

    // Lifecycle stubs — the real runtime calls these around runStep; local
    // runner invokes runStep directly, but tests and library code sometimes
    // reference them.
    async initData()        {}
    async runBefore()       {}
    async runAfter()        {}
    async runHandle()       {}
    async run()             { return this.runStep(this.__event); }
    async resolveDataIn()   { return this.data; }
    async resolveSettings() { return this.settings; }

    async exitStep(id, payload) {
      __throwExit(this, id, payload);
    }

    async runStep() { throw new Error('subclass must implement runStep'); }
  }
\`;

// -----------------------------------------------------------------------
// Execute the rewritten step code. Instantiate the class, apply context
// overrides (stepMeta / state / settings), run runStep, and emit a JSON
// result on stdout.
// -----------------------------------------------------------------------
const dataUri = 'data:text/javascript,' + encodeURIComponent(stepCode);
try {
  const mod = await import(dataUri);
  const Cls = globalThis[ctx.className] || mod.step || mod.default || mod[ctx.className];
  if (!Cls) throw new Error('step class "' + ctx.className + '" not found in module exports');

  const instance = new Cls();
  instance.data = ctx.data || {};
  if (ctx.stepMeta && typeof ctx.stepMeta === 'object') Object.assign(instance.step, ctx.stepMeta);
  if (ctx.state    && typeof ctx.state    === 'object') Object.assign(instance.state, ctx.state);
  if (ctx.settings && typeof ctx.settings === 'object') instance.settings = ctx.settings;

  const emit = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');

  try {
    await instance.runStep();
    emit({
      ok: true,
      exitId: instance.__exitId,
      exitPayload: instance.__exitPayload,
      logs: instance.__logs,
      unsupported: globalThis.__localStepUnsupported,
      timers: globalThis.__localStepTimers.map(function (t) { return { ms: t.ms, hasCallback: typeof t.callback === 'function' }; }),
    });
  } catch (err) {
    if (err && err.__localStepExit) {
      emit({
        ok: true,
        exitId: instance.__exitId,
        exitPayload: instance.__exitPayload,
        logs: instance.__logs,
        unsupported: globalThis.__localStepUnsupported,
        timers: globalThis.__localStepTimers.map(function (t) { return { ms: t.ms, hasCallback: typeof t.callback === 'function' }; }),
      });
    } else {
      emit({
        ok: false,
        exitId: null,
        exitPayload: null,
        error: err.message,
        errorStack: err.stack ? err.stack.split('\\n').slice(0, 5).join('\\n') : null,
        logs: instance.__logs,
        unsupported: globalThis.__localStepUnsupported,
        timers: globalThis.__localStepTimers.map(function (t) { return { ms: t.ms, hasCallback: typeof t.callback === 'function' }; }),
      });
    }
  }
} catch (err) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: 'module load failed: ' + err.message,
    errorStack: err.stack ? err.stack.split('\\n').slice(0, 5).join('\\n') : null,
    logs: [],
    unsupported: globalThis.__localStepUnsupported,
  }) + '\\n');
}
`;

// ---------------------------------------------------------------------------
// runScenarios — convenience wrapper for running a list of scenarios against
// the same code. Returns { passed, failed, results[] }.
// ---------------------------------------------------------------------------
async function runScenarios({ code, className, scenarios, opts = {} }) {
  const results = [];
  let passed = 0, failed = 0;
  for (const sc of scenarios) {
    const r = await runStepCodeLocally({ code, className, data: sc.inputs, opts: { ...opts, ...(sc.opts || {}) } });
    const ok = evaluateScenario(r, sc);
    if (ok) passed++; else failed++;
    results.push({ scenario: sc.name, ok, runtime: r });
  }
  return { passed, failed, total: scenarios.length, results };
}

function evaluateScenario(runtime, scenario) {
  if (!runtime.ok) return false;
  if (scenario.expectExit !== undefined && runtime.exitId !== scenario.expectExit) return false;
  if (scenario.expectCode !== undefined) {
    const actualCode = runtime.exitPayload && runtime.exitPayload.code;
    if (scenario.expectCode !== actualCode) {
      if (Array.isArray(scenario.expectCode) && !scenario.expectCode.includes(actualCode)) return false;
      if (!Array.isArray(scenario.expectCode)) return false;
    }
  }
  return true;
}

module.exports = { runStepCodeLocally, runScenarios };
