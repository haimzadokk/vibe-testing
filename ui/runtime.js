/**
 * runtime.js — VIBE.TESTING Agent Runtime Layer v1.0
 *
 * Sits between the UI/phase actions and the Claude call pipeline.
 * Wraps runGen() to add: pre-flight checks, execution logging,
 * decision logic, validation surfacing, and next-phase annotations.
 *
 * Load order: stitch.js → agents.js → runtime.js
 * WRAP principle: zero existing IDs, functions, or pipeline altered.
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     §1  STATE EXTENSIONS
  ═══════════════════════════════════════════════════════════════════ */
  function initRuntimeState() {
    if (!window.S) return false;

    // Structured execution log — capped at MAX_LOGS entries
    if (!S.agentLogs)          S.agentLogs          = [];

    // Per-phase health: { health, confidence, warnings }
    if (!S.phaseHealth)        S.phaseHealth        = { 1: null, 2: null, 3: null, 4: null };

    // Runtime annotations injected into next-phase prompts
    if (!S.runtimeAnnotations) S.runtimeAnnotations = {};

    return true;
  }


  /* ═══════════════════════════════════════════════════════════════════
     §2  EXECUTION LOGGER
  ═══════════════════════════════════════════════════════════════════ */
  var MAX_LOGS   = 60;
  var PHASE_NAMES = ['', 'STP', 'STD', 'RUN', 'STR'];

  var LOG_ICONS = {
    start:              '▶',
    complete:           '✓',
    artifact_extracted: '◆',
    artifact_failed:    '⚠',
    prereq_warning:     '⚠',
    decision:           '◈',
    memory_injected:    '↓ MEM',
    memory_updated:     '↑ MEM',
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
     §3  DECISION ENGINE
     Bounded, explicit rules — no uncontrolled autonomy.
  ═══════════════════════════════════════════════════════════════════ */
  function computeDecision(phaseId, artifact) {
    if (!artifact) {
      return { health: 'degraded', confidence: 0, warnings: ['JSON artifact not parsed — next phase uses raw text context (graceful fallback active)'] };
    }

    var warnings  = [];
    var health    = 'good';
    var score     = artifact.confidenceScore || 0;
    var pct       = Math.round(score * 100);

    // ── Confidence thresholds ────────────────────────────────────────
    if (score < 0.4) {
      health = 'low';
      warnings.push('Low confidence ' + pct + '% — input lacks sufficient product detail. Add more context before proceeding.');
    } else if (score < 0.65) {
      health = 'medium';
      warnings.push('Moderate confidence ' + pct + '% — review [ASSUMED] items in the output before running the next phase.');
    }

    // ── RUN: rejected assumptions ────────────────────────────────────
    if (phaseId === 3 && artifact.assumptionUpdates) {
      var rejected = artifact.assumptionUpdates.filter(function (u) { return u.newTag === '[REJECTED]'; });
      if (rejected.length > 0) {
        warnings.push(rejected.length + ' assumption(s) REJECTED — STR Insight Agent will analyze root cause');
        if (health === 'good') health = 'medium';
      }
    }

    // ── RUN: critical blockers ────────────────────────────────────────
    if (phaseId === 3 && artifact.failures) {
      var blockers = artifact.failures.filter(function (f) { return f.severity === 'Critical'; });
      if (blockers.length > 0) {
        warnings.push(blockers.length + ' BLOCKER(s) found — Go/No-Go likely Conditional or NO-GO');
        if (health === 'good') health = 'medium';
      }
    }

    // ── RUN: validator inconsistency ─────────────────────────────────
    if (phaseId === 3 && artifact.validationResult && artifact.validationResult.isConsistentWithSTD === false) {
      warnings.push('Execution Validator flagged inconsistency with STD (score: ' +
        (artifact.validationResult.consistencyScore || '?') + '/100)');
      if (health === 'good') health = 'medium';
    }

    // ── STR: NO-GO ────────────────────────────────────────────────────
    if (phaseId === 4 && artifact.goNoGo === 'NO-GO') {
      warnings.push('Release recommendation: NO-GO — do not ship without addressing blockers');
      if (health === 'good') health = 'low';
    }

    // ── STR: report validator flags ───────────────────────────────────
    if (phaseId === 4 && artifact.validationConsistency && !artifact.validationConsistency.isConsistent) {
      warnings.push('STR Report Validator flagged numerical inconsistency — review flagged sections');
      if (health === 'good') health = 'medium';
    }

    // ── STP: zero test items ──────────────────────────────────────────
    if (phaseId === 1 && artifact.testTree && artifact.testTree.totalItems === 0) {
      warnings.push('STP test tree is empty — check that file content was uploaded correctly');
      health = 'degraded';
    }

    return { health: health, confidence: score, warnings: warnings };
  }


  /* ═══════════════════════════════════════════════════════════════════
     §4  NEXT-PHASE ANNOTATION
     Stores high-signal context items for injection into next prompt.
  ═══════════════════════════════════════════════════════════════════ */
  function buildAnnotations(phaseId, artifact, decision) {
    if (!window.S || !artifact) return;
    if (!S.runtimeAnnotations) S.runtimeAnnotations = {};

    var lines = [];

    // High-severity risks from STP (for STD to prioritize)
    if (phaseId === 1 && artifact.riskMap && artifact.riskMap.length) {
      var hot = artifact.riskMap.filter(function (r) { return (r.score || 0) >= 15; });
      if (hot.length) {
        lines.push('PRIORITIZE THESE HIGH-RISK AREAS (score≥15): ' +
          hot.map(function (r) { return r.id + ' [' + r.area + ']'; }).join(' | '));
      }
    }

    // Coverage gaps from STD (for RUN to handle carefully)
    if (phaseId === 2 && artifact.coverageMatrix && artifact.coverageMatrix.gaps && artifact.coverageMatrix.gaps.length) {
      lines.push('STD COVERAGE GAPS NOTED: ' + artifact.coverageMatrix.gaps.slice(0, 5).join('; '));
    }

    // Rejected assumptions from RUN (for STR root cause)
    if (phaseId === 3 && artifact.assumptionUpdates) {
      var rej = artifact.assumptionUpdates.filter(function (u) { return u.newTag === '[REJECTED]'; });
      if (rej.length) {
        lines.push('REJECTED IN EXECUTION: ' +
          rej.map(function (u) { return u.id + ' — ' + (u.evidence || 'see RUN log'); }).join('; '));
      }
    }

    // Phase health annotation
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
     §5  PREREQ CHECKER
  ═══════════════════════════════════════════════════════════════════ */
  function checkPrerequisites(phaseId) {
    if (!window.S) return null;
    if (phaseId === 2 && !S.data[1]) return 'STD launched without STP — context will be minimal. Generate STP first for best results.';
    if (phaseId === 3 && !S.data[2]) return 'RUN launched without STD — test case list is unknown. Execution will be simulated.';
    if (phaseId === 4 && !S.data[3]) return 'STR launched without RUN results — summary will have incomplete execution data.';
    return null;
  }


  /* ═══════════════════════════════════════════════════════════════════
     §6  WARNING SURFACE
     Injects visible warnings above the output card content.
  ═══════════════════════════════════════════════════════════════════ */
  function clearWarnings() {
    var bar = document.getElementById('agent-warning-bar');
    if (bar) { bar.innerHTML = ''; bar.style.display = 'none'; }
  }

  function surfaceWarning(phaseId, message, level) {
    var bar = document.getElementById('agent-warning-bar');
    if (!bar) return;

    var colorMap = { error: '#f43f5e', warn: '#f59e0b', info: '#06b6d4' };
    var color = colorMap[level] || colorMap.warn;
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
      '<span style="color:' + color + ';font-size:9px;font-weight:700;font-family:JetBrains Mono,monospace;letter-spacing:1px;flex-shrink:0;padding-top:1px">' + phaseName + '</span>' +
      '<span style="font-size:11px;color:var(--text);line-height:1.45">' + escHtml(message) + '</span>';

    bar.appendChild(item);
    bar.style.display = 'block';
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }


  /* ═══════════════════════════════════════════════════════════════════
     §7  PHASE HEALTH BADGE (on phase tabs)
  ═══════════════════════════════════════════════════════════════════ */
  function applyTabHealth(phaseId, health) {
    var tab = document.querySelector('.ph-tab[data-phase="' + phaseId + '"]');
    if (!tab) return;
    tab.classList.remove('ph-health-good', 'ph-health-medium', 'ph-health-low', 'ph-health-degraded');
    if (health) tab.classList.add('ph-health-' + health);
  }


  /* ═══════════════════════════════════════════════════════════════════
     §8  RUNTIME WRAP OF runGen
     This is the primary integration point. Adds pre/post orchestration
     around the real phase execution without changing internal logic.
  ═══════════════════════════════════════════════════════════════════ */
  function patchRunGen() {
    var _orig = typeof runGen === 'function' ? runGen : null;
    if (!_orig) {
      console.warn('[runtime] runGen not found — runtime layer inactive');
      return;
    }

    window.runGen = async function (phaseId) {
      if (!window.S) { return _orig(phaseId); }

      // Ensure state is initialised (safe to re-call)
      initRuntimeState();

      var phaseName = PHASE_NAMES[phaseId] || ('P' + phaseId);
      var t0 = Date.now();

      // ── Pre-flight ───────────────────────────────────────────────
      clearWarnings();

      var prereq = checkPrerequisites(phaseId);
      if (prereq) {
        logEvent(phaseId, 'prereq_warning', { message: prereq });
        surfaceWarning(phaseId, prereq, 'warn');
      }

      if (S.memory && S.memory.productName) {
        logEvent(phaseId, 'memory_injected', {
          productName:    S.memory.productName,
          lessonsLearned: (S.memory.lessonsLearned || []).length,
          techStack:      (S.memory.techStack || []).join(', ') || '—',
        });
      }

      logEvent(phaseId, 'start', { phaseName: phaseName });

      // ── Execute original runGen (all streaming, showOut, etc.) ───
      // agents.js hooks (buildPrompt, getContext, showOut) fire inside here.
      await _orig(phaseId);

      var elapsed = ((Date.now() - t0) / 1000).toFixed(1) + 's';

      // ── Post-execution ───────────────────────────────────────────
      var artifact = (S.artifacts && S.artifacts[phaseId]) ? S.artifacts[phaseId] : null;
      var succeeded = S.status[phaseId] === 'done';

      if (!succeeded) {
        // Error or user-abort — log and exit cleanly
        if (S.status[phaseId] === 'error') {
          logEvent(phaseId, 'error', { elapsed: elapsed, note: 'Generation failed — see output for details' });
        } else {
          logEvent(phaseId, 'complete', { elapsed: elapsed, note: 'Stopped by user' });
        }
        return;
      }

      if (artifact) {
        // ── Artifact extracted successfully ──────────────────────
        logEvent(phaseId, 'artifact_extracted', {
          phaseName:       phaseName,
          confidenceScore: artifact.confidenceScore,
          totalItems:      artifact.testTree ? artifact.testTree.totalItems : undefined,
          goNoGo:          artifact.goNoGo,
          elapsed:         elapsed,
        });

        // ── Decision engine ──────────────────────────────────────
        var decision = computeDecision(phaseId, artifact);
        S.phaseHealth[phaseId] = decision;
        applyTabHealth(phaseId, decision.health);

        decision.warnings.forEach(function (w) {
          var level = decision.health === 'low' || decision.health === 'degraded' ? 'error' : 'warn';
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

        // ── Next-phase context annotation ────────────────────────
        if (phaseId < 4) {
          buildAnnotations(phaseId, artifact, decision);
        }

        // ── Memory update log (STR only, fired by agents.js already) ─
        if (phaseId === 4 && S.memory && S.memory.productName) {
          logEvent(phaseId, 'memory_updated', {
            productName: S.memory.productName,
            passRate:    S.memory.previousPassRate != null
                           ? Math.round(S.memory.previousPassRate * 100) + '%'
                           : '—',
          });
        }

      } else if (S.data[phaseId]) {
        // ── Output exists but JSON artifact not found ────────────
        logEvent(phaseId, 'artifact_failed', {
          elapsed: elapsed,
          note:    'No JSON artifact block — fallback to raw text context active',
        });
        var degraded = { health: 'degraded', confidence: 0, warnings: ['JSON artifact not extracted — next phase uses raw text (graceful fallback)'] };
        S.phaseHealth[phaseId] = degraded;
        applyTabHealth(phaseId, 'degraded');
        surfaceWarning(phaseId, degraded.warnings[0], 'warn');
      }

      logEvent(phaseId, 'complete', { elapsed: elapsed, status: S.status[phaseId] });
      _refreshLogPanel();
    };
  }


  /* ═══════════════════════════════════════════════════════════════════
     §9  CONTEXT ENRICHMENT
     Wraps the getContext already overridden by agents.js to inject
     runtime annotations from prior phases.
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
     §10  LOG PANEL UI
  ═══════════════════════════════════════════════════════════════════ */
  var _logPanelInjected = false;

  function injectRuntimeUI() {
    if (_logPanelInjected) return;

    // ── Warning bar (inserted inside out-card, above out-content) ──
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

    // ── Log panel (appended to out-scroll) ──────────────────────────
    var outScroll = document.getElementById('out-scroll');
    if (outScroll) {
      var logPanel = document.createElement('div');
      logPanel.id        = 'agent-log-panel';
      logPanel.className = 'agent-log-panel';
      logPanel.style.display = 'none';
      logPanel.innerHTML =
        '<div class="alp-header" onclick="var b=document.getElementById(\'alp-body\');b.classList.toggle(\'alp-collapsed\');this.querySelector(\'.alp-toggle\').textContent=b.classList.contains(\'alp-collapsed\')?\'▸\':\'▾\'">' +
          '<span class="alp-title">◉ AGENT RUNTIME LOG</span>' +
          '<span class="alp-toggle">▾</span>' +
        '</div>' +
        '<div class="alp-body alp-collapsed" id="alp-body"><div class="alp-empty">No events yet.</div></div>';
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
    S.agentLogs.slice(0, 25).forEach(function (e) {
      var icon  = LOG_ICONS[e.event]  || '·';
      var color = LOG_COLORS[e.event] || '#7a9abf';
      var time  = e.ts ? e.ts.split('T')[1].slice(0, 8) : '';

      var detail = '';
      if (e.elapsed)         detail = e.elapsed;
      if (e.message)         detail = e.message.slice(0, 90);
      if (e.note)            detail = e.note.slice(0, 90);
      if (e.error)           detail = e.error.slice(0, 90);
      if (e.warning)         detail = e.warning.slice(0, 90);
      if (e.preview)         detail = e.preview;
      if (e.event === 'artifact_extracted') {
        detail = 'confidence ' + Math.round((e.confidenceScore || 0) * 100) + '%' +
                 (e.totalItems != null ? ' · ' + e.totalItems + ' items' : '') +
                 ' · ' + (e.elapsed || '');
      }
      if (e.event === 'decision') {
        detail = e.health + ' · ' + (e.confidence || '—') + (e.note ? ' · ' + e.note : '');
      }
      if (e.event === 'memory_injected') {
        detail = (e.productName || '—') + ' · ' + (e.lessonsLearned || 0) + ' lessons';
      }
      if (e.event === 'memory_updated') {
        detail = (e.productName || '—') + ' pass ' + (e.passRate || '—');
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
     §11  INIT
  ═══════════════════════════════════════════════════════════════════ */
  function init() {
    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;

      if (!window.S && attempts < 60) return;
      clearInterval(poll);

      if (!window.S) {
        console.warn('[runtime] S state object not found — aborting runtime init');
        return;
      }

      initRuntimeState();
      patchRunGen();
      patchGetContext();

      // Inject UI as soon as the output card exists
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
