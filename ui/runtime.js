/**
 * runtime.js — VIBE.TESTING Agent Runtime Layer v3.0
 *
 * v1 → observability wrapper (logEvent, warnings, tab health)
 * v2 → structured state (S.runtime, buildPhaseContext, buildPhaseResult,
 *       updateRuntimeState, finalizePipelineRun)
 * v3 → explicit runAgentPhase() as the runtime execution owner.
 *       runGen now delegates post-execution entirely to runAgentPhase.
 *       All v1/v2 functions are UNCHANGED.
 *
 * Load order: stitch.js → agents.js → runtime.js
 * WRAP principle: zero existing IDs, functions, or pipeline altered.
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     §1  CONSTANTS & MODULE-LEVEL EXECUTION REFERENCE
  ═══════════════════════════════════════════════════════════════════ */
  var PHASE_NAMES = ['', 'STP', 'STD', 'RUN', 'STR'];

  /**
   * _execFn — registered by patchRunGen() to the ORIGINAL runGen from
   * index.html. runAgentPhase calls it to trigger the real Claude
   * streaming pipeline (buildPrompt / getContext / streamClaude / showOut).
   * Never called directly outside patchRunGen or runAgentPhase.
   */
  var _execFn = null;


  /* ═══════════════════════════════════════════════════════════════════
     §2  STATE EXTENSIONS  (v1/v2 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function initRuntimeState() {
    if (!window.S) return false;
    if (!S.agentLogs)          S.agentLogs          = [];
    if (!S.phaseHealth)        S.phaseHealth        = { 1: null, 2: null, 3: null, 4: null };
    if (!S.runtimeAnnotations) S.runtimeAnnotations = {};
    if (!S.runtime)            S.runtime            = _freshRuntime();
    return true;
  }

  function _freshRuntime() {
    return {
      currentPhase:    null,
      phaseResults:    {},
      flags:           [],
      warnings:        [],
      decisions:       [],
      degradedPhases:  [],
      lastPipelineRun: null,
    };
  }

  function resetRuntimeForNewPipeline() {
    if (!window.S) return;
    var last = S.runtime ? S.runtime.lastPipelineRun : null;
    S.runtime = _freshRuntime();
    S.runtime.lastPipelineRun = last;
    if (S.runtimeAnnotations) S.runtimeAnnotations = {};
  }


  /* ═══════════════════════════════════════════════════════════════════
     §3  EXECUTION LOGGER  (v1 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  var MAX_LOGS = 60;

  var LOG_ICONS = {
    start:              '▶',
    complete:           '✓',
    artifact_extracted: '◆',
    artifact_failed:    '⚠',
    prereq_warning:     '⚠',
    decision:           '◈',
    memory_injected:    '↓ MEM',
    memory_updated:     '↑ MEM',
    pipeline_summary:   '═',
    input_summary:      '⋮',
    error:              '✕',
    annotation:         '→',
  };

  var LOG_COLORS = {
    start:              '#06b6d4',
    complete:           '#00e5a0',
    artifact_extracted: '#8b5cf6',
    artifact_failed:    '#f59e0b',
    prereq_warning:     '#f59e0b',
    decision:           '#06b6d4',
    memory_injected:    '#7a9abf',
    memory_updated:     '#00e5a0',
    pipeline_summary:   '#00e5a0',
    input_summary:      '#7a9abf',
    error:              '#f43f5e',
    annotation:         '#7a9abf',
  };

  function logEvent(phaseId, event, data) {
    if (!window.S) return;
    if (!S.agentLogs) S.agentLogs = [];

    var entry = Object.assign({
      id:        Date.now() + '-' + phaseId + '-' + event,
      phase:     phaseId,
      phaseName: PHASE_NAMES[phaseId] || ('P' + phaseId),
      event:     event,
      ts:        new Date().toISOString(),
    }, data || {});

    S.agentLogs.unshift(entry);
    if (S.agentLogs.length > MAX_LOGS) S.agentLogs.length = MAX_LOGS;

    _refreshLogPanel();
  }


  /* ═══════════════════════════════════════════════════════════════════
     §4  BUILD PHASE CONTEXT  (v2 — unchanged)
     Audit snapshot of what was structurally available before execution.
     Distinct from the actual prompt string built by getContext() chain.
  ═══════════════════════════════════════════════════════════════════ */
  function buildPhaseContext(phaseId) {
    var ctx = {
      phase:               phaseId,
      phaseName:           PHASE_NAMES[phaseId] || ('P' + phaseId),
      hasMemory:           !!(S.memory && S.memory.productName),
      artifactsAvailable:  {},
      runtimeAnnotations:  [],
      rejectedAssumptions: [],
      highPriorityRisks:   [],
    };

    if (phaseId >= 2 && S.artifacts && S.artifacts[1]) {
      var stp = S.artifacts[1];
      ctx.artifactsAvailable.STP = {
        confidence:      stp.confidenceScore || 0,
        testItemCount:   stp.testTree ? (stp.testTree.totalItems || 0) : null,
        riskCount:       stp.riskMap  ? stp.riskMap.length : null,
        assumptionCount: stp.assumptions ? stp.assumptions.length : null,
      };
    }
    if (phaseId >= 3 && S.artifacts && S.artifacts[2]) {
      var std = S.artifacts[2];
      ctx.artifactsAvailable.STD = {
        confidence:    std.confidenceScore || 0,
        testCaseCount: std.testCases ? std.testCases.length : null,
        coverageGaps:  std.coverageMatrix ? (std.coverageMatrix.gaps || []) : [],
      };
    }
    if (phaseId >= 4 && S.artifacts && S.artifacts[3]) {
      var run = S.artifacts[3];
      ctx.artifactsAvailable.RUN = {
        confidence:               run.confidenceScore || 0,
        passRate:                 run.summary ? (run.summary.passRate || null) : null,
        failureCount:             run.failures ? run.failures.length : null,
        rejectedAssumptionCount:  run.assumptionUpdates
          ? run.assumptionUpdates.filter(function (u) { return u.newTag === '[REJECTED]'; }).length
          : 0,
      };
    }

    for (var ph = 1; ph < phaseId; ph++) {
      if (S.runtimeAnnotations && S.runtimeAnnotations[ph] && S.runtimeAnnotations[ph].length) {
        ctx.runtimeAnnotations = ctx.runtimeAnnotations.concat(S.runtimeAnnotations[ph]);
      }
    }

    if (S.assumptions) {
      ctx.rejectedAssumptions = S.assumptions
        .filter(function (a) { return a.tag === '[REJECTED]'; })
        .map(function (a) { return { id: a.id, text: a.text, phase: a.phase }; });
    }

    if (S.artifacts && S.artifacts[1] && S.artifacts[1].riskMap) {
      ctx.highPriorityRisks = S.artifacts[1].riskMap
        .filter(function (r) { return (r.score || 0) >= 15; })
        .map(function (r) { return { id: r.id, area: r.area, score: r.score }; });
    }

    return ctx;
  }


  /* ═══════════════════════════════════════════════════════════════════
     §5  NORMALIZED PHASE RESULT  (v2 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function buildPhaseResult(phaseId, artifact, decision, ctxSnapshot, elapsed) {
    var phaseName = PHASE_NAMES[phaseId] || ('P' + phaseId);
    var statusAfter = S.status ? (S.status[phaseId] || 'unknown') : 'unknown';

    var validation = {
      confidence:          artifact ? (artifact.confidenceScore || 0) : 0,
      artifactParsed:      !!artifact,
      inconsistencies:     [],
      missingCriticalData: [],
      rejectedAssumptions: [],
    };

    if (!artifact) {
      validation.missingCriticalData.push(
        'JSON artifact absent — raw output preserved in S.data[' + phaseId + ']'
      );
    }

    if (artifact) {
      if (artifact.validationResult) {
        if (artifact.validationResult.isConsistentWithSTD === false) {
          validation.inconsistencies.push(
            'Execution not consistent with STD — score: ' +
            (artifact.validationResult.consistencyScore || '?') + '/100'
          );
        }
        (artifact.validationResult.unexplainedFailures || []).forEach(function (f) {
          validation.inconsistencies.push('Unexplained failure: ' + String(f).slice(0, 80));
        });
      }
      if (artifact.validationConsistency && !artifact.validationConsistency.isConsistent) {
        (artifact.validationConsistency.flags || []).forEach(function (f) {
          validation.inconsistencies.push('STR flag: ' + String(f).slice(0, 80));
        });
      }
      if (artifact.assumptionUpdates) {
        validation.rejectedAssumptions = artifact.assumptionUpdates
          .filter(function (u) { return u.newTag === '[REJECTED]'; })
          .map(function (u) { return { id: u.id, evidence: u.evidence || '' }; });
      }
      if (phaseId === 1 && (!artifact.riskMap || !artifact.riskMap.length))
        validation.missingCriticalData.push('Risk map empty — add product detail');
      if (phaseId === 2 && (!artifact.testCases || !artifact.testCases.length))
        validation.missingCriticalData.push('Test cases array empty');
      if (phaseId === 3 && !artifact.summary)
        validation.missingCriticalData.push('Execution summary object missing');
      if (phaseId === 4 && !artifact.goNoGo)
        validation.missingCriticalData.push('Go/No-Go recommendation not found');
    }

    var decisions = { flags: [], priorities: [] };

    if (decision) {
      if (decision.health === 'low' || decision.health === 'degraded')
        decisions.flags.push({ type: 'HEALTH_' + decision.health.toUpperCase(), phase: phaseName });
      if (decision.confidence < 0.5)
        decisions.flags.push({ type: 'LOW_CONFIDENCE', value: Math.round(decision.confidence * 100) + '%', phase: phaseName });
    }
    if (phaseId === 4 && artifact && artifact.goNoGo)
      decisions.flags.push({ type: 'GO_NOGO', value: artifact.goNoGo, phase: 'STR' });
    if (phaseId === 3 && artifact && artifact.summary && artifact.summary.passRate < 0.65)
      decisions.flags.push({ type: 'LOW_PASS_RATE', value: Math.round(artifact.summary.passRate * 100) + '%', phase: 'RUN' });

    if (phaseId === 1 && artifact && artifact.riskMap) {
      artifact.riskMap.filter(function (r) { return (r.score || 0) >= 15; }).forEach(function (r) {
        decisions.priorities.push({ id: r.id, area: r.area, score: r.score, targetPhase: 'STD' });
      });
    }
    if (phaseId === 3 && artifact && artifact.failures) {
      artifact.failures.filter(function (f) { return f.severity === 'Critical'; }).forEach(function (f) {
        decisions.priorities.push({ id: f.tcId, title: (f.title || '').slice(0, 60), severity: 'Critical', targetPhase: 'STR' });
      });
    }

    // Explicit status — finer-grained than S.status
    var resultStatus = statusAfter === 'done'
      ? (artifact ? 'completed' : 'completed_degraded')
      : (statusAfter === 'error' ? 'error' : 'aborted');

    return {
      phase:       phaseId,
      phaseName:   phaseName,
      artifact:    artifact || null,
      rawTextRef:  'S.data[' + phaseId + ']',
      contextUsed: {
        snapshot:         ctxSnapshot || null,
        // Actual prompt content was built by getContext() chain:
        // runtime.js §15 → agents.js override → original index.html version
        // Full output of that chain is NOT stored here (already in S.data)
        promptBuiltBy:    'getContext() chain (runtime → agents.js → index.html)',
      },
      validation:  validation,
      decisions:   decisions,
      status:      resultStatus,
      elapsed:     elapsed,
      timestamp:   new Date().toISOString(),
    };
  }


  /* ═══════════════════════════════════════════════════════════════════
     §6  UPDATE RUNTIME STATE  (v2 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function updateRuntimeState(phaseId, phaseResult, decision) {
    if (!window.S || !S.runtime) return;
    var rt = S.runtime;

    rt.currentPhase = phaseId;
    rt.phaseResults[phaseId] = phaseResult;

    (phaseResult.decisions.flags || []).forEach(function (f) {
      var dup = rt.flags.some(function (x) { return x.type === f.type && x.phase === f.phase; });
      if (!dup) rt.flags.push(f);
    });

    if (decision && decision.warnings) {
      decision.warnings.forEach(function (msg) {
        var dup = rt.warnings.some(function (x) { return x.message === msg; });
        if (!dup) rt.warnings.push({ phase: phaseId, message: msg, health: decision.health, ts: new Date().toISOString() });
      });
    }

    if (decision) {
      rt.decisions.push({
        phase:        phaseId,
        phaseName:    PHASE_NAMES[phaseId] || ('P' + phaseId),
        health:       decision.health,
        confidence:   decision.confidence,
        warningCount: (decision.warnings || []).length,
        ts:           new Date().toISOString(),
      });
    }

    if (decision && (decision.health === 'degraded' || decision.health === 'low')) {
      if (rt.degradedPhases.indexOf(phaseId) === -1) rt.degradedPhases.push(phaseId);
    }
  }


  /* ═══════════════════════════════════════════════════════════════════
     §7  DECISION ENGINE  (v1 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function computeDecision(phaseId, artifact) {
    if (!artifact) {
      return { health: 'degraded', confidence: 0,
               warnings: ['JSON artifact not parsed — next phase uses raw text context (graceful fallback active)'] };
    }

    var warnings = [];
    var health   = 'good';
    var score    = artifact.confidenceScore || 0;
    var pct      = Math.round(score * 100);

    if (score < 0.4) {
      health = 'low';
      warnings.push('Low confidence ' + pct + '% — input lacks sufficient product detail. Add more context before proceeding.');
    } else if (score < 0.65) {
      health = 'medium';
      warnings.push('Moderate confidence ' + pct + '% — review [ASSUMED] items in the output before running the next phase.');
    }

    if (phaseId === 3 && artifact.assumptionUpdates) {
      var rejected = artifact.assumptionUpdates.filter(function (u) { return u.newTag === '[REJECTED]'; });
      if (rejected.length > 0) {
        warnings.push(rejected.length + ' assumption(s) REJECTED — STR Insight Agent will analyze root cause');
        if (health === 'good') health = 'medium';
      }
    }
    if (phaseId === 3 && artifact.failures) {
      var blockers = artifact.failures.filter(function (f) { return f.severity === 'Critical'; });
      if (blockers.length > 0) {
        warnings.push(blockers.length + ' BLOCKER(s) found — Go/No-Go likely Conditional or NO-GO');
        if (health === 'good') health = 'medium';
      }
    }
    if (phaseId === 3 && artifact.validationResult && artifact.validationResult.isConsistentWithSTD === false) {
      warnings.push('Execution Validator flagged inconsistency with STD (score: ' +
        (artifact.validationResult.consistencyScore || '?') + '/100)');
      if (health === 'good') health = 'medium';
    }
    if (phaseId === 4 && artifact.goNoGo === 'NO-GO') {
      warnings.push('Release recommendation: NO-GO — do not ship without addressing blockers');
      if (health === 'good') health = 'low';
    }
    if (phaseId === 4 && artifact.validationConsistency && !artifact.validationConsistency.isConsistent) {
      warnings.push('STR Report Validator flagged numerical inconsistency — review flagged sections');
      if (health === 'good') health = 'medium';
    }
    if (phaseId === 1 && artifact.testTree && artifact.testTree.totalItems === 0) {
      warnings.push('STP test tree is empty — check that file content was uploaded correctly');
      health = 'degraded';
    }

    return { health: health, confidence: score, warnings: warnings };
  }


  /* ═══════════════════════════════════════════════════════════════════
     §8  NEXT-PHASE ANNOTATION  (v1 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function buildAnnotations(phaseId, artifact, decision) {
    if (!window.S || !artifact) return;
    if (!S.runtimeAnnotations) S.runtimeAnnotations = {};

    var lines = [];

    if (phaseId === 1 && artifact.riskMap && artifact.riskMap.length) {
      var hot = artifact.riskMap.filter(function (r) { return (r.score || 0) >= 15; });
      if (hot.length) {
        lines.push('PRIORITIZE THESE HIGH-RISK AREAS (score≥15): ' +
          hot.map(function (r) { return r.id + ' [' + r.area + ']'; }).join(' | '));
      }
    }
    if (phaseId === 2 && artifact.coverageMatrix && artifact.coverageMatrix.gaps && artifact.coverageMatrix.gaps.length) {
      lines.push('STD COVERAGE GAPS NOTED: ' + artifact.coverageMatrix.gaps.slice(0, 5).join('; '));
    }
    if (phaseId === 3 && artifact.assumptionUpdates) {
      var rej = artifact.assumptionUpdates.filter(function (u) { return u.newTag === '[REJECTED]'; });
      if (rej.length) {
        lines.push('REJECTED IN EXECUTION: ' +
          rej.map(function (u) { return u.id + ' — ' + (u.evidence || 'see RUN log'); }).join('; '));
      }
    }
    if (decision.health !== 'good' && decision.warnings.length) {
      lines.push('PRIOR PHASE HEALTH ' + decision.health.toUpperCase() + ': ' + decision.warnings[0]);
    }

    if (lines.length) {
      S.runtimeAnnotations[phaseId] = lines;
      logEvent(phaseId, 'annotation', { count: lines.length, preview: lines[0].slice(0, 80) });
    } else {
      S.runtimeAnnotations[phaseId] = [];
    }
  }


  /* ═══════════════════════════════════════════════════════════════════
     §9  PIPELINE SUMMARY  (v2 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function finalizePipelineRun() {
    if (!window.S || !S.runtime) return;
    var rt = S.runtime;

    var completedNums = Object.keys(rt.phaseResults).map(Number).filter(function (k) {
      return rt.phaseResults[k] && rt.phaseResults[k].status === 'completed';
    });
    if (!completedNums.length) return;

    var sum = completedNums.reduce(function (acc, ph) {
      return acc + (rt.phaseResults[ph].validation.confidence || 0);
    }, 0);
    var overallConfidence = Math.round((sum / completedNums.length) * 100) / 100;

    var goNoGo = null;
    if (rt.phaseResults[4] && rt.phaseResults[4].artifact)
      goNoGo = rt.phaseResults[4].artifact.goNoGo || null;

    var keyWarnings = rt.warnings
      .filter(function (w) { return w.health === 'low' || w.health === 'degraded'; })
      .map(function (w) { return '[' + (PHASE_NAMES[w.phase] || w.phase) + '] ' + w.message; })
      .slice(0, 5);

    var keyFlags = rt.flags.map(function (f) {
      return f.type + (f.value ? ':' + f.value : '') + '@' + (f.phase || '?');
    });

    rt.lastPipelineRun = {
      completedAt:       new Date().toISOString(),
      completedPhases:   completedNums.map(function (ph) { return PHASE_NAMES[ph]; }),
      degradedPhases:    rt.degradedPhases.map(function (ph) { return PHASE_NAMES[ph]; }),
      overallConfidence: overallConfidence,
      goNoGo:            goNoGo,
      keyFlags:          keyFlags,
      keyWarnings:       keyWarnings,
      totalWarnings:     rt.warnings.length,
    };

    logEvent(0, 'pipeline_summary', {
      completedPhases:   rt.lastPipelineRun.completedPhases.join(' → '),
      overallConfidence: Math.round(overallConfidence * 100) + '%',
      goNoGo:            goNoGo || '—',
      degradedCount:     rt.degradedPhases.length,
    });
  }


  /* ═══════════════════════════════════════════════════════════════════
     §10  PREREQ CHECKER  (v1 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function checkPrerequisites(phaseId) {
    if (!window.S) return null;
    if (phaseId === 2 && !S.data[1]) return 'STD launched without STP — context will be minimal. Generate STP first for best results.';
    if (phaseId === 3 && !S.data[2]) return 'RUN launched without STD — test case list is unknown. Execution will be simulated.';
    if (phaseId === 4 && !S.data[3]) return 'STR launched without RUN results — summary will have incomplete execution data.';
    return null;
  }


  /* ═══════════════════════════════════════════════════════════════════
     §11  WARNING SURFACE  (v1 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function clearWarnings() {
    var bar = document.getElementById('agent-warning-bar');
    if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; }
  }

  function surfaceWarning(phaseId, message, level) {
    var bar = document.getElementById('agent-warning-bar');
    if (!bar) return;

    var colorMap = { error: '#f43f5e', warn: '#f59e0b', info: '#06b6d4' };
    var color    = colorMap[level] || colorMap.warn;
    var phaseName = PHASE_NAMES[phaseId] || ('P' + phaseId);

    var item = document.createElement('div');
    item.className = 'awt-item awt-' + level;
    item.style.cssText = [
      'display:flex', 'align-items:flex-start', 'gap:8px',
      'padding:6px 10px', 'margin-bottom:3px',
      'border-inline-start:2px solid ' + color,
      'border-radius:0 4px 4px 0',
      'background:' + color + '0a',
      'animation:agent-fade-in .2s ease both',
    ].join(';');
    item.innerHTML =
      '<span style="color:' + color + ';font-size:9px;font-weight:700;' +
      'font-family:JetBrains Mono,monospace;letter-spacing:1px;flex-shrink:0;padding-top:1px">' +
      phaseName + '</span>' +
      '<span style="font-size:11px;color:var(--text);line-height:1.45">' +
      escHtml(message) + '</span>';

    bar.appendChild(item);
    bar.style.display = 'block';
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }


  /* ═══════════════════════════════════════════════════════════════════
     §12  PHASE HEALTH BADGE  (v1 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function applyTabHealth(phaseId, health) {
    var tab = document.querySelector('.ph-tab[data-phase="' + phaseId + '"]');
    if (!tab) return;
    tab.classList.remove('ph-health-good', 'ph-health-medium', 'ph-health-low', 'ph-health-degraded');
    if (health) tab.classList.add('ph-health-' + health);
  }


  /* ═══════════════════════════════════════════════════════════════════
     §13  INPUT SUMMARY HELPER  (v3 — new)
     Produces a compact audit string of what was structurally available
     when a phase started. Stored in the 'start' log entry.
     No secrets — only counts, confidence %, phase names.
  ═══════════════════════════════════════════════════════════════════ */
  function _buildInputSummary(phaseId, ctxSnapshot) {
    var parts = [];

    if (ctxSnapshot.hasMemory) {
      // Only log that memory is present; never log the content itself
      parts.push('MEM:active');
    }

    var avail = ctxSnapshot.artifactsAvailable || {};
    if (avail.STP) {
      parts.push('STP:' + Math.round((avail.STP.confidence || 0) * 100) + '%' +
                 (avail.STP.testItemCount != null ? '/' + avail.STP.testItemCount + 'items' : ''));
    }
    if (avail.STD) {
      parts.push('STD:' + Math.round((avail.STD.confidence || 0) * 100) + '%' +
                 (avail.STD.testCaseCount != null ? '/' + avail.STD.testCaseCount + 'tc' : ''));
    }
    if (avail.RUN) {
      parts.push('RUN:' + Math.round((avail.RUN.confidence || 0) * 100) + '%' +
                 (avail.RUN.passRate != null ? '/' + Math.round(avail.RUN.passRate * 100) + '%pass' : ''));
    }

    var annotCount = (ctxSnapshot.runtimeAnnotations || []).length;
    if (annotCount) parts.push(annotCount + ' annotations');

    var rejCount = (ctxSnapshot.rejectedAssumptions || []).length;
    if (rejCount) parts.push(rejCount + ' rejected-assumptions');

    var hotCount = (ctxSnapshot.highPriorityRisks || []).length;
    if (hotCount) parts.push(hotCount + ' hot-risks');

    return parts.length ? parts.join(' | ') : 'fresh-start';
  }


  /* ═══════════════════════════════════════════════════════════════════
     §14  runAgentPhase  (v3 — new)
     The runtime execution owner for a single phase.
     Called by the slimmed runGen wrapper (§15) after pre-flight.
     Also callable directly for testing / programmatic pipeline use.

     Responsibilities:
       1. Set S.runtime.currentPhase
       2. Snapshot context (audit) via buildPhaseContext()
       3. Log input summary (what was available at execution time)
       4. Log phase start
       5. Call _execFn(phaseId) — the real Claude streaming pipeline
       6. Determine exec status (completed / completed_degraded / error / aborted)
       7. computeDecision on artifact
       8. buildPhaseResult (normalized contract)
       9. updateRuntimeState (flags / warnings / decisions / degradedPhases)
      10. applyTabHealth, surfaceWarnings
      11. buildAnnotations for next phase
      12. Log memory update (STR only)
      13. finalizePipelineRun (STR only)
      14. Log complete
      15. Return phaseResult

     @param {number} phaseId  1=STP 2=STD 3=RUN 4=STR
     @param {object} [options] reserved for future use
     @returns {Promise<object>} normalized PhaseResult
  ═══════════════════════════════════════════════════════════════════ */
  async function runAgentPhase(phaseId, options) {
    if (!window.S || !_execFn) {
      console.warn('[runtime] runAgentPhase: S or _execFn not ready');
      return null;
    }

    // §14.1  Set current phase
    if (S.runtime) S.runtime.currentPhase = phaseId;

    var t0 = Date.now();

    // §14.2  Context snapshot (AUDIT — separate from actual prompt content)
    var ctxSnapshot = buildPhaseContext(phaseId);

    // §14.3  Log what was available at execution time
    var inputSummary = _buildInputSummary(phaseId, ctxSnapshot);
    logEvent(phaseId, 'input_summary', { summary: inputSummary });

    // §14.4  Log phase start
    logEvent(phaseId, 'start', { phaseName: PHASE_NAMES[phaseId] || ('P' + phaseId) });

    // §14.5  Execute — actual prompt is built inside here by:
    //   getContext() chain (runtime §16 → agents.js override → index.html original)
    //   + buildPrompt() (agents.js AGENT_PROMPTS.X)
    //   + streamClaude() → showOut() → agents.js showOut hook (extractArtifact etc.)
    //
    //   NOTE: The prompt content is NOT duplicated into phaseResult.
    //   Full output lives in S.data[phaseId]. Artifact is in S.artifacts[phaseId].
    try {
      await _execFn(phaseId);
    } catch (execErr) {
      // _execFn (original runGen) catches its own errors internally.
      // This catch handles any unexpected throw that escapes it.
      logEvent(phaseId, 'error', { message: execErr.message || String(execErr) });
    }

    var elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';

    // §14.6  Determine execution status
    var rawStatus   = S.status ? (S.status[phaseId] || 'unknown') : 'unknown';
    var succeeded   = rawStatus === 'done';
    var errored     = rawStatus === 'error';
    // 'idle' means user stopped BEFORE any output was captured
    var aborted     = !succeeded && !errored;

    // §14.7  Artifact and decision
    var artifact = (S.artifacts && S.artifacts[phaseId]) ? S.artifacts[phaseId] : null;
    var decision = computeDecision(phaseId, artifact);

    // §14.8  Build normalized phase result
    var phaseResult = buildPhaseResult(phaseId, artifact, decision, ctxSnapshot, elapsed);

    // Override status with finer-grained value when not succeeded
    if (!succeeded) {
      phaseResult.status = errored ? 'error' : 'aborted';
      if (errored) {
        phaseResult.validation.missingCriticalData.push('Phase ended in error state — check console');
      }
      // Even for aborted/errored phases: write to phaseResults so pipeline knows what happened
      if (S.runtime) S.runtime.phaseResults[phaseId] = phaseResult;
      logEvent(phaseId, 'complete', { elapsed: elapsed, status: phaseResult.status });
      _refreshLogPanel();
      return phaseResult;
    }

    // §14.9  Update S.runtime (only on success path)
    S.phaseHealth[phaseId] = decision;
    applyTabHealth(phaseId, decision.health);
    updateRuntimeState(phaseId, phaseResult, decision);

    // §14.10  Surface warnings to UI + log decisions
    if (artifact) {
      logEvent(phaseId, 'artifact_extracted', {
        confidenceScore: artifact.confidenceScore,
        totalItems:      artifact.testTree ? artifact.testTree.totalItems : undefined,
        goNoGo:          artifact.goNoGo,
        elapsed:         elapsed,
      });

      decision.warnings.forEach(function (w) {
        var level = (decision.health === 'low' || decision.health === 'degraded') ? 'error' : 'warn';
        surfaceWarning(phaseId, w, level);
        logEvent(phaseId, 'decision', {
          health:     decision.health,
          confidence: Math.round((decision.confidence || 0) * 100) + '%',
          warning:    w.slice(0, 100),
        });
      });

      if (!decision.warnings.length) {
        logEvent(phaseId, 'decision', {
          health:     decision.health,
          confidence: Math.round((decision.confidence || 0) * 100) + '%',
          note:       'All checks passed',
        });
      }

    } else if (S.data[phaseId]) {
      // Completed but artifact missing — output still usable via raw text fallback
      logEvent(phaseId, 'artifact_failed', {
        elapsed: elapsed,
        note:    'No JSON block found — raw text in S.data[' + phaseId + '] will be used as context',
      });
      surfaceWarning(phaseId,
        'JSON artifact not extracted — next phase falls back to raw text context',
        'warn'
      );
    }

    // §14.11  Build annotations for next phase (1→2, 2→3, 3→4 only)
    if (phaseId < 4) buildAnnotations(phaseId, artifact, decision);

    // §14.12  Memory update log (agents.js fires the actual update; we only log)
    if (phaseId === 4 && S.memory && S.memory.productName) {
      logEvent(phaseId, 'memory_updated', {
        productName: S.memory.productName,
        passRate: S.memory.previousPassRate != null
          ? Math.round(S.memory.previousPassRate * 100) + '%' : '—',
      });
    }

    // §14.13  Pipeline summary (only after STR)
    if (phaseId === 4) finalizePipelineRun();

    // §14.14  Log completion
    logEvent(phaseId, 'complete', { elapsed: elapsed, status: phaseResult.status });
    _refreshLogPanel();

    // §14.15  Return normalized result
    return phaseResult;
  }


  /* ═══════════════════════════════════════════════════════════════════
     §15  patchRunGen  (v3 — slimmed to pre-flight + delegate)
     All post-execution logic now lives in runAgentPhase.
     runGen remains the public entry point: gen-btn → runGen → runAgentPhase.
  ═══════════════════════════════════════════════════════════════════ */
  function patchRunGen() {
    var _orig = typeof runGen === 'function' ? runGen : null;
    if (!_orig) {
      console.warn('[runtime] runGen not found — runtime layer inactive');
      return;
    }

    // Register execution function with runAgentPhase
    _execFn = _orig;

    window.runGen = async function (phaseId) {
      // Safety: if S isn't ready, fall back to original immediately
      if (!window.S) { return _orig(phaseId); }

      initRuntimeState();

      // ── Pre-flight ───────────────────────────────────────────────────
      if (phaseId === 1) resetRuntimeForNewPipeline();

      clearWarnings();

      var prereq = checkPrerequisites(phaseId);
      if (prereq) {
        logEvent(phaseId, 'prereq_warning', { message: prereq });
        surfaceWarning(phaseId, prereq, 'warn');
      }

      if (S.memory && S.memory.productName) {
        // Log memory availability WITHOUT logging memory content
        logEvent(phaseId, 'memory_injected', {
          productName:    S.memory.productName,
          lessonsLearned: (S.memory.lessonsLearned || []).length,
          hasTechStack:   !!(S.memory.techStack && S.memory.techStack.length),
        });
      }

      // ── Delegate all execution + post-processing to runAgentPhase ────
      return await runAgentPhase(phaseId);
    };
  }


  /* ═══════════════════════════════════════════════════════════════════
     §16  CONTEXT ENRICHMENT  (v1 — unchanged)
     Wraps getContext (already overridden by agents.js) to append
     runtime annotations from prior phases into the prompt.
     This is the actual context injected — separate from ctxSnapshot.
  ═══════════════════════════════════════════════════════════════════ */
  function patchGetContext() {
    var _prev = typeof window.getContext === 'function' ? window.getContext : null;
    if (!_prev) return;

    window.getContext = function (p) {
      var base = _prev(p);

      if (!window.S || !S.runtimeAnnotations) return base;

      var lines = [];
      for (var ph = 1; ph < p; ph++) {
        if (S.runtimeAnnotations[ph] && S.runtimeAnnotations[ph].length) {
          lines = lines.concat(S.runtimeAnnotations[ph]);
        }
      }

      if (lines.length) {
        base += '\n\n=== RUNTIME INTELLIGENCE (from prior phase analysis) ===\n' + lines.join('\n');
      }

      return base;
    };
  }


  /* ═══════════════════════════════════════════════════════════════════
     §17  LOG PANEL UI  (v1 — input_summary row added)
  ═══════════════════════════════════════════════════════════════════ */
  var _logPanelInjected = false;

  function injectRuntimeUI() {
    if (_logPanelInjected) return;

    var outCard    = document.getElementById('out-card');
    var outContent = document.getElementById('out-content');
    var confBar    = document.getElementById('agent-confidence-bar');

    if (outCard && outContent) {
      var warningBar = document.createElement('div');
      warningBar.id = 'agent-warning-bar';
      warningBar.style.cssText = 'display:none;padding:6px 12px 3px;border-bottom:1px solid var(--border)';
      var insertRef = (confBar && confBar.nextSibling) ? confBar.nextSibling : outContent;
      outCard.insertBefore(warningBar, insertRef);
    }

    var outScroll = document.getElementById('out-scroll');
    if (outScroll) {
      var logPanel = document.createElement('div');
      logPanel.id        = 'agent-log-panel';
      logPanel.className = 'agent-log-panel';
      logPanel.style.display = 'none';
      logPanel.innerHTML =
        '<div class="alp-header" onclick="var b=document.getElementById(\'alp-body\');' +
        'b.classList.toggle(\'alp-collapsed\');' +
        'this.querySelector(\'.alp-toggle\').textContent=' +
        'b.classList.contains(\'alp-collapsed\')?\'▸\':\'▾\'">' +
          '<span class="alp-title">◉ AGENT RUNTIME LOG</span>' +
          '<span class="alp-toggle">▾</span>' +
        '</div>' +
        '<div class="alp-body alp-collapsed" id="alp-body">' +
          '<div class="alp-empty">No events yet.</div>' +
        '</div>';
      outScroll.appendChild(logPanel);
    }

    _logPanelInjected = true;
  }

  function _refreshLogPanel() {
    var panel = document.getElementById('agent-log-panel');
    var body  = document.getElementById('alp-body');
    if (!panel || !body || !window.S || !S.agentLogs || !S.agentLogs.length) return;

    panel.style.display = 'block';

    var html = '';
    S.agentLogs.slice(0, 30).forEach(function (e) {
      var icon  = LOG_ICONS[e.event]  || '·';
      var color = LOG_COLORS[e.event] || '#7a9abf';
      var time  = e.ts ? e.ts.split('T')[1].slice(0, 8) : '';

      var detail = '';
      if (e.elapsed)  detail = String(e.elapsed).slice(0, 40);
      if (e.message)  detail = String(e.message).slice(0, 90);
      if (e.note)     detail = String(e.note).slice(0, 90);
      if (e.error)    detail = String(e.error).slice(0, 90);
      if (e.warning)  detail = String(e.warning).slice(0, 90);
      if (e.preview)  detail = String(e.preview).slice(0, 90);
      if (e.summary)  detail = String(e.summary).slice(0, 90);

      if (e.event === 'input_summary') detail = String(e.summary || '').slice(0, 90);
      if (e.event === 'artifact_extracted') {
        detail = 'confidence ' + Math.round((e.confidenceScore || 0) * 100) + '%' +
                 (e.totalItems != null ? ' · ' + e.totalItems + ' items' : '') +
                 (e.elapsed ? ' · ' + e.elapsed : '');
      }
      if (e.event === 'decision') {
        detail = (e.health || '') + ' · ' + (e.confidence || '—') + (e.note ? ' · ' + e.note : '');
      }
      if (e.event === 'memory_injected') {
        detail = (e.productName || '—') + ' · ' + (e.lessonsLearned || 0) + ' lessons';
      }
      if (e.event === 'memory_updated') {
        detail = (e.productName || '—') + ' · pass ' + (e.passRate || '—');
      }
      if (e.event === 'pipeline_summary') {
        detail = (e.completedPhases || '') + ' · ' + (e.overallConfidence || '—') +
                 ' · GoNoGo:' + (e.goNoGo || '—');
      }

      html +=
        '<div class="alp-row">' +
          '<span class="alp-icon" style="color:' + color + '">' + icon + '</span>' +
          '<span class="alp-phase" style="color:' + color + '">' + (e.phaseName || '') + '</span>' +
          '<span class="alp-event">' + (e.event || '').replace(/_/g, ' ') + '</span>' +
          (detail ? '<span class="alp-detail">' + escHtml(detail) + '</span>' : '') +
          '<span class="alp-time">' + time + '</span>' +
        '</div>';
    });

    body.innerHTML = html;
  }


  /* ═══════════════════════════════════════════════════════════════════
     §18  INIT  (v1 — unchanged)
  ═══════════════════════════════════════════════════════════════════ */
  function init() {
    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;
      if (!window.S && attempts < 60) return;
      clearInterval(poll);

      if (!window.S) {
        console.warn('[runtime] S state object not found — aborting');
        return;
      }

      initRuntimeState();
      patchRunGen();       // registers _execFn; slims window.runGen
      patchGetContext();   // appends runtime annotations to prompt context

      (function tryUI() {
        if (document.getElementById('out-card') && document.getElementById('out-scroll')) {
          injectRuntimeUI();
        } else {
          setTimeout(tryUI, 300);
        }
      })();
    }, 80);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
