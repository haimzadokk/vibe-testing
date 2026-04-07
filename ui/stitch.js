/**
 * stitch.js — VIBE.TESTING Production Enhancement Layer
 * WRAP principle: adds UI without touching existing IDs or logic.
 * Runs after DOM is ready, hooks into existing state via window.S.
 */
(function () {
  'use strict';

  /* ─── §1  REPORTS STAT CARDS ─────────────────────────────────────── */
  var STAT_BAR_ID = 'stitch-stat-bar';

  function buildStatBar() {
    var bar = document.createElement('div');
    bar.id = STAT_BAR_ID;
    bar.style.cssText = [
      'display:flex', 'gap:10px', 'margin-bottom:14px',
      'flex-wrap:wrap', 'animation:stitch-slide-up .24s ease both'
    ].join(';');
    return bar;
  }

  function statCard(label, value, color) {
    var card = document.createElement('div');
    card.style.cssText = [
      'display:flex', 'flex-direction:column', 'gap:3px',
      'padding:10px 16px',
      'background:' + color + '08',
      'border:1px solid ' + color + '28',
      'border-radius:8px',
      'min-width:90px', 'flex:1',
      'transition:box-shadow .2s'
    ].join(';');

    var val = document.createElement('div');
    val.style.cssText = 'font-size:22px;font-weight:800;color:' + color + ';font-family:JetBrains Mono,monospace;line-height:1';
    val.textContent = value;

    var lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:9px;letter-spacing:2px;color:var(--muted);text-transform:uppercase;margin-top:2px';
    lbl.textContent = label;

    card.appendChild(val);
    card.appendChild(lbl);

    card.addEventListener('mouseenter', function () {
      card.style.boxShadow = '0 0 12px ' + color + '28';
    });
    card.addEventListener('mouseleave', function () {
      card.style.boxShadow = 'none';
    });

    return card;
  }

  function updateStatBar() {
    var panel = document.getElementById('reports-panel');
    var list  = document.getElementById('reports-list');
    if (!panel || !list) return;

    // Grab or create bar
    var bar = document.getElementById(STAT_BAR_ID);
    if (!bar) {
      bar = buildStatBar();
      // Insert before reports-list
      panel.insertBefore(bar, list);
    }

    // Read data from S.runReports (global state)
    var reports = (window.S && window.S.runReports) ? window.S.runReports : [];
    var total   = reports.length;
    var pass    = 0, fail = 0, pending = 0, skip = 0;

    reports.forEach(function (r) {
      pass    += (r.pass_count  || 0);
      fail    += (r.fail_count  || 0);
      skip    += (r.skip_count  || 0);
      if (r.status === 'pending') pending++;
    });

    // Build cards
    bar.innerHTML = '';
    bar.appendChild(statCard('הרצות', total,   '#06b6d4'));
    bar.appendChild(statCard('עברו',   pass,    '#00e5a0'));
    if (fail > 0)
      bar.appendChild(statCard('נכשלו',  fail,    '#f43f5e'));
    if (skip > 0)
      bar.appendChild(statCard('דולגו',  skip,    '#f59e0b'));
    if (pending > 0)
      bar.appendChild(statCard('ממתין',  pending, '#7a9abf'));

    // Show / hide based on data
    bar.style.display = total > 0 ? 'flex' : 'none';
  }

  /* ─── §2  HOOK INTO loadReports / renderReportsList ─────────────── */
  function patchReports() {
    // Wrap renderReportsList to trigger stat update after render
    var orig = window.renderReportsList;
    if (typeof orig === 'function') {
      window.renderReportsList = function () {
        orig.apply(this, arguments);
        updateStatBar();
      };
    }

    // Also watch #reports-count for text changes (covers all paths)
    var countEl = document.getElementById('reports-count');
    if (countEl && window.MutationObserver) {
      new MutationObserver(function () {
        // Small delay to let S.runReports populate
        setTimeout(updateStatBar, 50);
      }).observe(countEl, { childList: true, characterData: true, subtree: true });
    }
  }

  /* ─── §3  SIDEBAR PHASE COUNTER RING ────────────────────────────── */
  function updateSidebarDones() {
    var S = window.S;
    if (!S) return;
    [1, 2, 3, 4, 5].forEach(function (i) {
      var dot = document.getElementById('vtd-' + i);
      var item = document.querySelector('.vts-item[data-vt-phase="' + i + '"]');
      if (!dot || !item) return;
      var isDone = S.status && S.status[i] === 'done';
      dot.classList.toggle('show', !!isDone);
      item.classList.toggle('done-phase', !!isDone);
    });
  }

  /* ─── §4  LIGHT MODE: SIDEBAR SMOOTHING ─────────────────────────── */
  function applyLightSidebarFix() {
    var isLight = document.body.classList.contains('light-mode');
    var sidebar = document.getElementById('vt-sidebar');
    if (!sidebar) return;
    sidebar.style.borderInlineEndColor = isLight ? '#e2e8f0' : '';
  }

  /* ─── §5  MOBILE NAV ACTIVE SYNC ────────────────────────────────── */
  function syncVtsSidebarActive() {
    var S = window.S;
    if (!S) return;
    document.querySelectorAll('.vts-item[data-vt-phase]').forEach(function (el) {
      el.classList.toggle('active', +el.dataset.vtPhase === S.ap);
    });
  }

  /* ─── §6  KEYBOARD SHORTCUT: Alt+G = Generate ───────────────────── */
  function addKeyboardShortcuts() {
    document.addEventListener('keydown', function (e) {
      // Alt+G — trigger generate if button is enabled
      if (e.altKey && e.key === 'g') {
        var btn = document.getElementById('gen-btn');
        if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
      }
      // Alt+L — toggle light mode
      if (e.altKey && e.key === 'l') {
        e.preventDefault();
        if (typeof applyTheme === 'function') {
          applyTheme(document.body.classList.contains('light-mode') ? 'dark' : 'light');
        }
      }
    });
  }

  /* ─── §7  PHASE LABEL TOOLTIP ON HOVER ──────────────────────────── */
  function addPhaseTooltips() {
    var TIPS = { 1: 'STP — עץ בדיקות', 2: 'STD — תסריטי בדיקה', 3: 'RUN — הרצה אוטומטית', 4: 'STR — דוח סיכום', 5: 'דוחות — היסטוריה' };
    document.querySelectorAll('.ph-tab[data-phase]').forEach(function (tab) {
      var ph = tab.dataset.phase;
      if (TIPS[ph]) tab.title = TIPS[ph];
    });
  }

  /* ─── §8  INIT ───────────────────────────────────────────────────── */
  function init() {
    patchReports();
    addKeyboardShortcuts();
    addPhaseTooltips();
    applyLightSidebarFix();

    // Poll for S readiness, then sync sidebar
    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;
      if (window.S && window.S.ap) {
        syncVtsSidebarActive();
        clearInterval(poll);
      }
      if (attempts > 40) clearInterval(poll); // give up after 4s
    }, 100);

    // Watch for theme changes to fix sidebar border
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        if (m.attributeName === 'class') applyLightSidebarFix();
      });
    }).observe(document.body, { attributes: true });

    // Watch for phase changes to sync sidebar active state
    if (window.MutationObserver) {
      var phaseBar = document.querySelector('.phase-bar');
      if (phaseBar) {
        new MutationObserver(function () {
          syncVtsSidebarActive();
          updateSidebarDones();
        }).observe(phaseBar, { attributes: true, subtree: true, attributeFilter: ['class'] });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
