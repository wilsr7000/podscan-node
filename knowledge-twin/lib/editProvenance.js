// ---------------------------------------------------------------------------
// editProvenance.js — durable record of every applied edit.
//
// Each successful edit produces a provenance entry that is:
//   1. Appended to the in-memory session log (for the current run's report)
//   2. Persisted to the playbook KV at playbook.stages.<stage>.edits[]
//      (so post-mortem diagnosis can reconstruct what the pipeline did)
//
// Entry shape:
//   {
//     ts:          ISO timestamp
//     stage:       which pipeline stage triggered the edit
//     file:        path (relative to repo root)
//     defectId:    known-issues id or "adhoc"
//     source:      'deterministic' | 'llm' | 'manual'
//     rationale:   one-line human explanation
//     oldHash:     SHA-256(oldText) truncated — for diffability
//     newHash:     SHA-256(newText) truncated
//     oldFileHash: SHA-256(file BEFORE edit)
//     newFileHash: SHA-256(file AFTER edit)
//     bytesDelta:  newFile.length - oldFile.length
//     verification: 'pending' | 'passed' | 'failed'
//   }
//
// Callers can attach their own verification step (test run, validator pass)
// and update the entry via recordVerification(handle, { passed, ...extras }).
// ---------------------------------------------------------------------------

'use strict';

const crypto = require('node:crypto');

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16);
}

function createSessionLog() {
  const entries = [];
  return {
    add(entry) {
      const full = { ts: new Date().toISOString(), verification: 'pending', ...entry };
      entries.push(full);
      return full;
    },
    recordVerification(index, { passed, note }) {
      if (index < 0 || index >= entries.length) return;
      entries[index].verification = passed ? 'passed' : 'failed';
      if (note) entries[index].verificationNote = note;
    },
    all() { return entries.slice(); },
    forStage(stage) { return entries.filter((e) => e.stage === stage); },
    summary() {
      return {
        total: entries.length,
        bySource: entries.reduce((m, e) => { m[e.source] = (m[e.source] || 0) + 1; return m; }, {}),
        byStage: entries.reduce((m, e) => { m[e.stage] = (m[e.stage] || 0) + 1; return m; }, {}),
        passed: entries.filter((e) => e.verification === 'passed').length,
        failed: entries.filter((e) => e.verification === 'failed').length,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// buildEntry — produce a provenance entry from an Edit primitive result.
//
// editResult is the object returned by applyEdit / applyEditsOneFile.
// Fills in hashes + timestamp; caller supplies stage + defectId + source.
// ---------------------------------------------------------------------------
function buildEntry({ editResult, stage, defectId, source, rationale }) {
  if (!editResult || !editResult.ok) {
    throw new Error('buildEntry: editResult must be a successful edit (ok:true)');
  }
  return {
    ts: new Date().toISOString(),
    stage: stage || 'unknown',
    file: editResult.file,
    defectId: defectId || 'adhoc',
    source: source || 'manual',
    rationale: rationale || editResult.rationale || '',
    oldHash: editResult.oldTextHash,
    newHash: editResult.newTextHash,
    oldFileHash: editResult.oldFileHash,
    newFileHash: editResult.newFileHash,
    linesChanged: editResult.linesChanged,
    bytesDelta: (editResult.newBytes || 0) - (editResult.oldBytes || 0),
    verification: 'pending',
  };
}

// ---------------------------------------------------------------------------
// persistToPlaybook — writes entries under playbook.stages.<stage>.edits[].
//
// Uses the same playbookStore.updateStage() API the rest of the pipeline
// uses, so all writes flow through the same KV-merge semantics. Entries are
// appended (no overwrite) via a patch that reads+extends the current array.
//
// Callers typically invoke this ONCE at the end of a patch session, not per
// entry — batched writes are cheaper and keep the KV entry consistent.
// ---------------------------------------------------------------------------
async function persistToPlaybook(playbookHandle, entries) {
  if (!playbookHandle || !Array.isArray(entries) || entries.length === 0) return { ok: false, reason: 'no handle or no entries' };
  try {
    const { getPlaybook, updateStage } = require('./playbookStore');
    const byStage = new Map();
    for (const e of entries) {
      if (!byStage.has(e.stage)) byStage.set(e.stage, []);
      byStage.get(e.stage).push(e);
    }
    for (const [stage, stageEntries] of byStage) {
      const current = await getPlaybook(playbookHandle).catch(() => null);
      const priorEdits = current?.stages?.[stage]?.data?.edits || [];
      await updateStage(playbookHandle, stage, {
        data: { edits: [...priorEdits, ...stageEntries] },
      });
    }
    return { ok: true, persisted: entries.length };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = {
  createSessionLog,
  buildEntry,
  persistToPlaybook,
  // exposed for testing
  _internal: { shortHash },
};
