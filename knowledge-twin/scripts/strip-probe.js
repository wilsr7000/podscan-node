#!/usr/bin/env node
// strip-probe.js — remove step-probe injection from generated step code.
//
// Usage:
//   node scripts/strip-probe.js <file.mjs>           # strip in place
//   node scripts/strip-probe.js <file.mjs> --check   # assert no probe left (CI)
//
// Removes every region fenced by `// @probe-begin ... // @probe-end` comments.
// Used for Level 3 opt-out: ship a step template with the probe completely
// removed, no env flag or runtime decision required.
//
// Idempotent — running it on already-stripped code is a no-op. Exits with
// code 0 on success, 1 if --check finds leftover probe markers.
'use strict';

const fs = require('fs');
const path = require('path');

function stripProbe(src) {
  const re = /\/\/\s*@probe-begin[\s\S]*?\/\/\s*@probe-end\s*/g;
  const out = src.replace(re, '');
  return { code: out, stripped: src.length - out.length };
}

function main() {
  const file = process.argv[2];
  const check = process.argv.includes('--check');
  if (!file) {
    console.error('usage: strip-probe.js <file> [--check]');
    process.exit(1);
  }
  const abs = path.resolve(file);
  const src = fs.readFileSync(abs, 'utf8');

  if (check) {
    if (/\/\/\s*@probe-begin/.test(src) || /\/\/\s*@probe-end/.test(src)) {
      console.error(`✗ ${file} contains probe markers — run strip-probe.js without --check`);
      process.exit(1);
    }
    if (/\b_probe_(state|enabled|kv_|start|mark|done)\b/.test(src)) {
      console.error(`✗ ${file} contains probe symbols — strip was incomplete`);
      process.exit(1);
    }
    console.log(`✓ ${file} is probe-free`);
    return;
  }

  const { code, stripped } = stripProbe(src);
  if (stripped === 0) {
    console.log(`${file}: no probe regions found — nothing to strip`);
    return;
  }
  fs.writeFileSync(abs, code);
  console.log(`${file}: stripped ${stripped} probe chars`);
}

if (require.main === module) main();

module.exports = { stripProbe };
