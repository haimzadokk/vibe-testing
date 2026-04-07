/**
 * onboarding.js — VIBE.TESTING Onboarding + Agent Visualization
 *
 * Part 1: 5-step first-time onboarding overlay
 * Part 2: Always-on agent team panel (reads S.runtime, S.phaseHealth, S.agentLogs)
 *
 * WRAP principle: injects new elements only. Zero existing IDs/functions changed.
 * Load order: stitch.js → agents.js → runtime.js → onboarding.js
 */
(function () {
  'use strict';

  /* ══════════════════════════════════════════════════════════════════
     §1  CONSTANTS
  ══════════════════════════════════════════════════════════════════ */
  var LS_KEY      = 'vibe_onboarding_seen';
  var TOTAL_STEPS = 5;

  var FLOW_NODES = [
    { label:'Observe', icon:'◈', color:'#06b6d4', delay:.05 },
    { label:'Infer',   icon:'⟳', color:'#8b5cf6', delay:.17 },
    { label:'Risk',    icon:'◭', color:'#f59e0b', delay:.29 },
    { label:'Design',  icon:'◇', color:'#00e5a0', delay:.41 },
    { label:'Execute', icon:'▷', color:'#00e5a0', delay:.53 },
    { label:'Learn',   icon:'◉', color:'#8b5cf6', delay:.65 },
  ];

  var PIPELINE = [
    {
      code:'STP', color:'#06b6d4',
      name:'Structured Test Plan',
      desc:'Maps your product into a prioritized test tree with risk scoring per area.',
    },
    {
      code:'STD', color:'#8b5cf6',
      name:'Test Scenario Design',
      desc:'Generates detailed test cases with full coverage matrix and assumption tracking.',
    },
    {
      code:'RUN', color:'#00e5a0',
      name:'Automated Execution',
      desc:'Runs all scenarios and captures pass/fail results with evidence tags.',
    },
    {
      code:'STR', color:'#f59e0b',
      name:'Summary Report',
      desc:'Go/No-Go recommendation, root cause analysis, and durable lessons learned.',
    },
  ];

  var AGENTS = [
    {
      id:'discovery', name:'Discovery', icon:'◈',
      role:'Maps test scope & extracts requirements from product docs',
      phases:[1], color:'#06b6d4', rgb:'6,182,212',
    },
    {
      id:'risk', name:'Risk', icon:'◭',
      role:'Scores risk areas & identifies coverage gaps',
      phases:[1], color:'#f59e0b', rgb:'245,158,11',
    },
    {
      id:'design', name:'Test Design', icon:'◇',
      role:'Generates test cases & builds the scenario matrix',
      phases:[2], color:'#8b5cf6', rgb:'139,92,246',
    },
    {
      id:'execution', name:'Execution', icon:'▷',
      role:'Runs scenarios & captures pass/fail with evidence',
      phases:[3], color:'#00e5a0', rgb:'0,229,160',
    },
    {
      id:'insight', name:'Insight', icon:'◉',
      role:'Analyzes failures & produces Go/No-Go recommendation',
      phases:[4], color:'#f43f5e', rgb:'244,63,94',
    },
  ];

  var PHASE_NAMES = ['', 'STP', 'STD', 'RUN', 'STR'];

  /* ══════════════════════════════════════════════════════════════════
     §2  ONBOARDING — DOM BUILDERS
  ══════════════════════════════════════════════════════════════════ */
  var _curStep = 1;

  function buildOnboarding() {
    var overlay = document.createElement('div');
    overlay.id = 'vt-onboarding';
    overlay.setAttribute('dir', 'ltr');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'VIBE.TESTING onboarding');

    var card = document.createElement('div');
    card.className = 'ob-card';

    card.appendChild(_step1());
    card.appendChild(_step2());
    card.appendChild(_step3());
    card.appendChild(_step4());
    card.appendChild(_step5());
    overlay.appendChild(card);

    // progress dots
    var nav = document.createElement('div');
    nav.className = 'ob-nav';

    var dots = document.createElement('div');
    dots.className = 'ob-dots';
    dots.id = 'ob-dots';
    for (var i = 1; i <= TOTAL_STEPS; i++) {
      (function (n) {
        var d = document.createElement('button');
        d.className = 'ob-dot';
        d.setAttribute('aria-label', 'Step ' + n);
        d.setAttribute('data-ob-step', String(n));
        dots.appendChild(d);
      })(i);
    }
    nav.appendChild(dots);

    var skip = document.createElement('button');
    skip.className = 'ob-skip';
    skip.textContent = 'Skip intro';
    skip.setAttribute('data-ob-step', String(TOTAL_STEPS));
    nav.appendChild(skip);

    overlay.appendChild(nav);

    // event delegation for all data-ob-step buttons
    overlay.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-ob-step]');
      if (!btn) return;
      var n = parseInt(btn.getAttribute('data-ob-step'), 10);
      if (n === 0) { closeOnboarding(); } else { goStep(n); }
    });

    // keyboard navigation
    overlay.addEventListener('keydown', function (e) {
      if (e.key === 'Escape')      { closeOnboarding(); }
      if (e.key === 'ArrowRight' && _curStep < TOTAL_STEPS) { goStep(_curStep + 1); }
      if (e.key === 'ArrowLeft'  && _curStep > 1)           { goStep(_curStep - 1); }
    });

    return overlay;
  }

  /* ── Step builders ── */
  function _step1() {
    var s = _mkStep(1);
    s.innerHTML =
      '<div class="ob-logo-icon">VT</div>' +
      '<div class="ob-welcome-title">VIBE<em>.</em>TESTING</div>' +
      '<div class="ob-welcome-sub">' +
        'Your AI QA Agent that understands your product ' +
        'and works like an intelligent testing team.' +
      '</div>' +
      '<div class="ob-tags">' +
        '<span class="ob-tag">Multi-Agent</span>' +
        '<span class="ob-tag">Evidence-Based</span>' +
        '<span class="ob-tag">Go / No-Go</span>' +
        '<span class="ob-tag">Memory-Driven</span>' +
      '</div>' +
      _btns([{ label:'Show me how it works ›', step:2, primary:true }]);
    return s;
  }

  function _step2() {
    var s = _mkStep(2);

    var flowHtml = '<div class="ob-flow">';
    FLOW_NODES.forEach(function (n, i) {
      var bg  = n.color + '12';
      var del = n.delay.toFixed(2);
      flowHtml +=
        '<div class="ob-flow-node" style="animation-delay:' + del + 's">' +
          '<div class="ob-flow-dot" style="border-color:' + n.color + ';color:' + n.color + ';background:' + bg + '">' +
            n.icon +
          '</div>' +
          '<div class="ob-flow-lbl" style="color:' + n.color + '">' + n.label + '</div>' +
        '</div>';
      if (i < FLOW_NODES.length - 1) {
        var nextColor = FLOW_NODES[i + 1].color;
        var arrowDel  = (n.delay + 0.08).toFixed(2);
        flowHtml +=
          '<div class="ob-flow-arrow" style="' +
            'background:linear-gradient(90deg,' + n.color + '70,' + nextColor + '70);' +
            'animation-delay:' + arrowDel + 's' +
          '"></div>';
      }
    });
    flowHtml += '</div>';

    s.innerHTML =
      '<div class="ob-eyebrow">How it thinks</div>' +
      flowHtml +
      '<div class="ob-flow-desc">' +
        'Six reasoning stages run inside every agent on every phase. ' +
        'The system observes your product, infers structure, scores risk, designs coverage, ' +
        'executes tests, and learns from each run to improve the next.' +
      '</div>' +
      _btns([
        { label:'‹ Back', step:1, primary:false },
        { label:'Next ›', step:3, primary:true  },
      ]);
    return s;
  }

  function _step3() {
    var s = _mkStep(3);

    var pipeHtml = '<div class="ob-pipeline">';
    PIPELINE.forEach(function (ph, i) {
      var del = (i * 0.1).toFixed(1);
      pipeHtml +=
        '<div class="ob-phase-card" style="--pc:' + ph.color + ';animation-delay:' + del + 's">' +
          '<div class="ob-phase-code" style="color:' + ph.color + '">' + ph.code + '</div>' +
          '<div class="ob-phase-name">' + _esc(ph.name) + '</div>' +
          '<div class="ob-phase-desc">'  + _esc(ph.desc) + '</div>' +
        '</div>';
      if (i < PIPELINE.length - 1) {
        pipeHtml += '<div class="ob-pipe-arrow">›</div>';
      }
    });
    pipeHtml += '</div>';

    s.innerHTML =
      '<div class="ob-eyebrow">The pipeline</div>' +
      pipeHtml +
      _btns([
        { label:'‹ Back', step:2, primary:false },
        { label:'Next ›', step:4, primary:true  },
      ]);
    return s;
  }

  function _step4() {
    var s = _mkStep(4);

    var gridHtml = '<div class="ob-agents-grid">';
    AGENTS.forEach(function (a, i) {
      var del = (i * 0.09).toFixed(2);
      gridHtml +=
        '<div class="ob-agent-card" style="--ac:' + a.color + ';animation-delay:' + del + 's">' +
          '<div class="ob-agent-icon" style="color:' + a.color + '">' + a.icon + '</div>' +
          '<div class="ob-agent-name" style="color:' + a.color + '">' + _esc(a.name) + '</div>' +
          '<div class="ob-agent-role">' + _esc(a.role) + '</div>' +
        '</div>';
    });
    gridHtml += '</div>';

    s.innerHTML =
      '<div class="ob-eyebrow">Your AI team</div>' +
      gridHtml +
      '<div class="ob-flow-desc" style="margin-top:18px">' +
        'Five specialized agents collaborate on every run. ' +
        'Each focuses on a specific reasoning domain — their outputs become the next agent\'s context.' +
      '</div>' +
      _btns([
        { label:'‹ Back', step:3, primary:false },
        { label:'Next ›', step:5, primary:true  },
      ]);
    return s;
  }

  function _step5() {
    var s = _mkStep(5);
    s.innerHTML =
      '<div class="ob-check-ring">' +
        '<svg class="ob-check-svg" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">' +
          '<path class="ob-check-path" d="M8 20 L16 28 L30 12"/>' +
        '</svg>' +
      '</div>' +
      '<div class="ob-ready-title">You\'re <em>all set.</em></div>' +
      '<div class="ob-ready-sub">' +
        'Upload a PRD, spec, or any product document.<br>' +
        'Hit Generate and watch your agents work.' +
      '</div>' +
      '<button class="ob-btn ob-btn-large ob-btn-start" data-ob-step="0">Start your first run →</button>';
    return s;
  }

  function _mkStep(n) {
    var el = document.createElement('div');
    el.className = 'ob-step' + (n === 1 ? ' ob-active' : '');
    el.id = 'ob-step-' + n;
    return el;
  }

  function _btns(defs) {
    var html = '<div class="ob-btn-row">';
    defs.forEach(function (d) {
      html +=
        '<button class="ob-btn' + (d.primary ? '' : ' ob-btn-outline') + '" data-ob-step="' + d.step + '">' +
          _esc(d.label) +
        '</button>';
    });
    html += '</div>';
    return html;
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }


  /* ══════════════════════════════════════════════════════════════════
     §3  ONBOARDING — STEP NAVIGATION
  ══════════════════════════════════════════════════════════════════ */
  function goStep(n) {
    if (n < 1 || n > TOTAL_STEPS) return;

    var curEl  = document.getElementById('ob-step-' + _curStep);
    var nextEl = document.getElementById('ob-step-' + n);
    if (!nextEl) return;

    if (curEl) curEl.classList.remove('ob-active');

    _curStep = n;

    // Re-trigger child animations (for revisiting steps)
    var animated = nextEl.querySelectorAll(
      '.ob-flow-node, .ob-flow-arrow, .ob-phase-card, .ob-agent-card'
    );
    animated.forEach(function (el) {
      el.style.animationName = 'none';
      el.style.opacity = '0';
    });
    // Force reflow, then restore
    nextEl.offsetHeight;
    animated.forEach(function (el) {
      el.style.animationName = '';
      el.style.opacity = '';
    });

    nextEl.classList.add('ob-active');

    // Update dots
    document.querySelectorAll('.ob-dot').forEach(function (d, i) {
      d.classList.toggle('ob-dot-active', i + 1 === _curStep);
    });
  }

  function closeOnboarding() {
    try { localStorage.setItem(LS_KEY, '1'); } catch (e) {}
    var overlay = document.getElementById('vt-onboarding');
    if (!overlay) return;
    overlay.style.transition = 'opacity .3s ease';
    overlay.style.opacity = '0';
    overlay.style.pointerEvents = 'none';
    setTimeout(function () {
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 320);
  }


  /* ══════════════════════════════════════════════════════════════════
     §4  AGENT PANEL — STATE READERS
  ══════════════════════════════════════════════════════════════════ */

  /** Returns 'active' | 'done' | 'degraded' | 'idle' for a given agent definition */
  function _agentStatus(agent) {
    var S = window.S;
    if (!S) return 'idle';

    // Running: any of the agent's phases currently has status 'run'
    for (var i = 0; i < agent.phases.length; i++) {
      var ph = agent.phases[i];
      if (S.status && S.status[ph] === 'run') return 'active';
    }

    // Completed or degraded: check phaseHealth
    for (var j = 0; j < agent.phases.length; j++) {
      var ph2 = agent.phases[j];
      var h   = S.phaseHealth && S.phaseHealth[ph2];
      if (h) {
        if (h.health === 'degraded' || h.health === 'low') return 'degraded';
        if (h.health === 'good'     || h.health === 'medium') return 'done';
      }
    }

    return 'idle';
  }

  /** Confidence string (e.g. "87%") or null if phase not completed */
  function _agentConfidence(agent) {
    var S = window.S;
    if (!S || !S.phaseHealth) return null;
    for (var i = 0; i < agent.phases.length; i++) {
      var h = S.phaseHealth[agent.phases[i]];
      if (h && h.confidence > 0) {
        return Math.round(h.confidence * 100) + '%';
      }
    }
    return null;
  }

  /** Most recent meaningful log action for the agent's phases */
  function _agentAction(agent) {
    var S = window.S;
    if (!S || !S.agentLogs || !S.agentLogs.length) return null;
    var SKIP = { input_summary:1, memory_injected:1, prereq_warning:1, start:1 };
    for (var i = 0; i < S.agentLogs.length; i++) {
      var log = S.agentLogs[i];
      if (agent.phases.indexOf(log.phase) === -1) continue;
      if (SKIP[log.event]) continue;
      var lbl = log.event.replace(/_/g, ' ');
      // Prefer specific detail fields
      if (log.action)  return log.action.replace(/_/g, ' ');
      if (log.status)  return lbl + ': ' + log.status;
      if (log.health)  return lbl + ': ' + log.health;
      return lbl;
    }
    return null;
  }

  /** Current pipeline phase name string, or null */
  function _activePhaseName() {
    var S = window.S;
    if (!S) return null;
    // Check S.status for running phase
    for (var ph = 1; ph <= 4; ph++) {
      if (S.status && S.status[ph] === 'run') return PHASE_NAMES[ph];
    }
    // Fall back to S.runtime.currentPhase for last-run reference
    if (S.runtime && S.runtime.currentPhase) return PHASE_NAMES[S.runtime.currentPhase] || null;
    return null;
  }

  /** True if any phase is currently running */
  function _isRunning() {
    var S = window.S;
    if (!S || !S.status) return false;
    for (var ph = 1; ph <= 4; ph++) {
      if (S.status[ph] === 'run') return true;
    }
    return false;
  }


  /* ══════════════════════════════════════════════════════════════════
     §5  AGENT PANEL — RENDER
  ══════════════════════════════════════════════════════════════════ */
  function _renderCard(agent) {
    var status     = _agentStatus(agent);
    var confidence = _agentConfidence(agent);
    var action     = _agentAction(agent);

    var stateClass = {
      active:   'vap-active',
      done:     'vap-done',
      degraded: 'vap-degraded',
      idle:     'vap-idle',
    }[status] || 'vap-idle';

    var statusLabel = {
      active:   'active',
      done:     'done',
      degraded: 'warning',
      idle:     'idle',
    }[status] || 'idle';

    return (
      '<div class="vap-card ' + stateClass + '" ' +
           'style="--vc:' + agent.color + ';--vc-rgb:' + agent.rgb + '">' +
        '<div class="vap-accent"></div>' +
        '<div class="vap-icon" style="color:' + agent.color + '">' + agent.icon + '</div>' +
        '<div class="vap-name">'   + _esc(agent.name)     + '</div>' +
        '<div class="vap-status-row">' +
          '<div class="vap-dot"></div>' +
          '<span class="vap-status-lbl">' + statusLabel + '</span>' +
        '</div>' +
        '<div class="vap-confidence">' + (confidence || '—') + '</div>' +
        (action
          ? '<div class="vap-action">' + _esc(action) + '</div>'
          : '') +
      '</div>'
    );
  }

  /** Diff-aware update: only rebuild innerHTML if state actually changed */
  var _panelStateKey = '';

  function updateAgentPanel() {
    var body     = document.getElementById('vap-body');
    var phasePill = document.getElementById('vap-phase-pill');
    if (!body) return;

    // Build a compact state fingerprint to avoid unnecessary DOM writes
    var S = window.S;
    var key = '';
    if (S) {
      key += (S.status ? JSON.stringify(S.status) : '');
      key += (S.phaseHealth ? JSON.stringify(S.phaseHealth) : '');
      key += (S.agentLogs ? (S.agentLogs.length + (S.agentLogs[0] ? S.agentLogs[0].id : '')) : '');
    }

    if (key === _panelStateKey) return; // nothing changed
    _panelStateKey = key;

    // Rebuild cards
    var html = '';
    AGENTS.forEach(function (a) { html += _renderCard(a); });
    body.innerHTML = html;

    // Update phase pill
    if (phasePill) {
      var ph = _activePhaseName();
      if (ph) {
        phasePill.textContent = 'Phase: ' + ph;
        phasePill.classList.toggle('vap-running', _isRunning());
      } else {
        phasePill.textContent = '— idle';
        phasePill.classList.remove('vap-running');
      }
    }
  }

  function buildAgentPanel() {
    var outScroll = document.getElementById('out-scroll');
    if (!outScroll || document.getElementById('vt-agent-panel')) return;

    var panel = document.createElement('div');
    panel.id = 'vt-agent-panel';

    // Header
    var header = document.createElement('div');
    header.className = 'vap-header';
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', 'true');
    header.setAttribute('tabindex', '0');
    header.innerHTML =
      '<span class="vap-title">◉ Agent Team</span>' +
      '<span class="vap-phase-pill" id="vap-phase-pill">— idle</span>' +
      '<button class="vap-toggle-btn" id="vap-toggle-btn" aria-label="Toggle agent panel">▾</button>';

    var _collapsed = false;
    function _toggle() {
      var body = document.getElementById('vap-body');
      var btn  = document.getElementById('vap-toggle-btn');
      if (!body) return;
      _collapsed = !_collapsed;
      body.classList.toggle('vap-collapsed', _collapsed);
      if (btn) btn.textContent = _collapsed ? '▸' : '▾';
      header.setAttribute('aria-expanded', String(!_collapsed));
    }

    header.addEventListener('click', _toggle);
    header.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _toggle(); }
    });

    // Body
    var body = document.createElement('div');
    body.id        = 'vap-body';
    body.className = 'vap-body';

    panel.appendChild(header);
    panel.appendChild(body);

    // Insert before the first child of out-scroll
    outScroll.insertBefore(panel, outScroll.firstChild);

    // Initial render
    updateAgentPanel();
  }


  /* ══════════════════════════════════════════════════════════════════
     §6  INIT
  ══════════════════════════════════════════════════════════════════ */
  function init() {

    /* ── Agent panel (always, regardless of onboarding) ── */
    (function tryPanel() {
      if (document.getElementById('out-scroll')) {
        buildAgentPanel();
        setInterval(updateAgentPanel, 700);
      } else {
        setTimeout(tryPanel, 250);
      }
    })();

    /* ── Onboarding (first-time users only) ── */
    var seen = false;
    try { seen = !!localStorage.getItem(LS_KEY); } catch (e) {}
    if (seen) return;

    // Short delay so main app is visually settled before overlay appears
    setTimeout(function () {
      var overlay = buildOnboarding();
      document.body.appendChild(overlay);
      goStep(1); // initializes dots + first step
      overlay.focus();
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
