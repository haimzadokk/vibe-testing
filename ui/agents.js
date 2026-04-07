/**
 * agents.js — VIBE.TESTING Multi-Agent Intelligence Layer v2.0
 *
 * Architecture: 8 specialized agents + 1 orchestrator.
 * Principle: Observe → Infer → Score Confidence → Identify Risk → Design → Execute → Validate → Learn
 * WRAP rule: no existing IDs, functions, or pipeline structure altered.
 *
 * Agents (simulated within single Claude calls per phase):
 *   STP: Discovery Agent + Product Inference Agent + Risk Agent
 *   STD: Test Design Agent + Risk Agent
 *   RUN: Execution Agent + Validation Agent
 *   STR: Insight Agent + Validation Agent + Memory/Knowledge Agent
 */
(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     §1  ARTIFACT STORE — extend global S (safe, non-destructive)
  ═══════════════════════════════════════════════════════════════════ */
  function initArtifactStore() {
    if (!window.S) return false;

    // Per-phase structured artifacts
    if (!S.artifacts) S.artifacts = { 1: null, 2: null, 3: null, 4: null };

    // Cross-phase assumption tracker
    if (!S.assumptions) S.assumptions = [];

    // Agent memory — persists across sessions
    if (!S.memory) S.memory = {
      productName:       null,
      productType:       null,
      techStack:         [],
      knownRisks:        [],
      testedModules:     [],
      previousPassRate:  null,
      criticalDefects:   [],
      lessonsLearned:    [],
      lastUpdated:       null,
    };

    return true;
  }


  /* ═══════════════════════════════════════════════════════════════════
     §2  MEMORY PERSISTENCE
  ═══════════════════════════════════════════════════════════════════ */
  var MEMORY_KEY = 'vibe_agent_memory_v2';

  function loadMemory() {
    try {
      var raw = localStorage.getItem(MEMORY_KEY);
      if (raw && window.S && S.memory) {
        var parsed = JSON.parse(raw);
        Object.keys(parsed).forEach(function (k) { S.memory[k] = parsed[k]; });
      }
    } catch (e) { /* swallow */ }
  }

  function saveMemory() {
    try {
      if (!window.S || !S.memory) return;
      S.memory.lastUpdated = new Date().toISOString();
      localStorage.setItem(MEMORY_KEY, JSON.stringify(S.memory));
    } catch (e) { /* swallow */ }
  }

  function persistMemorySupabase() {
    if (typeof workerFetch !== 'function') return;
    (async function () {
      try {
        await workerFetch('POST', '/api/memory', {
          memory: window.S && S.memory,
          run_id: window.S && S.runId,
        });
      } catch (e) { /* fire-and-forget */ }
    })();
  }

  function updateMemoryFromSTR(artifact) {
    if (!window.S || !artifact) return;
    var mem = S.memory;
    var me  = artifact.memoryExtracts || {};
    if (me.productName)    mem.productName    = me.productName;
    if (me.techStack)      mem.techStack      = me.techStack;
    if (me.passRate)       mem.previousPassRate = me.passRate;
    if (me.criticalDefects && me.criticalDefects.length)
      mem.criticalDefects = (mem.criticalDefects || []).concat(me.criticalDefects).slice(-20);
    if (me.lessonsLearned && me.lessonsLearned.length)
      mem.lessonsLearned  = (mem.lessonsLearned  || []).concat(me.lessonsLearned).slice(-30);
    if (artifact.productInference) {
      mem.productType = artifact.productInference.type || mem.productType;
    }
  }


  /* ═══════════════════════════════════════════════════════════════════
     §3  ARTIFACT EXTRACTION
  ═══════════════════════════════════════════════════════════════════ */
  function extractArtifact(text) {
    if (!text) return null;
    var blocks = [];
    var re = /```json\s*([\s\S]*?)```/g;
    var m;
    while ((m = re.exec(text)) !== null) blocks.push(m[1]);
    if (!blocks.length) return null;
    // Use last json block (artifact always appended at end)
    try {
      var parsed = JSON.parse(blocks[blocks.length - 1].trim());
      if (!parsed.phase && parsed.confidenceScore === undefined) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function mergeAssumptions(phaseId, artifact) {
    if (!artifact || !artifact.assumptions || !window.S) return;
    artifact.assumptions.forEach(function (a) {
      // De-duplicate by id
      if (!S.assumptions.find(function (x) { return x.id === a.id; })) {
        S.assumptions.push(a);
      }
    });
  }


  /* ═══════════════════════════════════════════════════════════════════
     §4  MEMORY CONTEXT SNIPPET (injected into prompts)
  ═══════════════════════════════════════════════════════════════════ */
  function memoryContext() {
    if (!window.S || !S.memory || !S.memory.productName) return '';
    var mem = S.memory;
    var lines = ['=== AGENT MEMORY (from prior runs) ==='];
    if (mem.productName)       lines.push('Product: ' + mem.productName);
    if (mem.productType)       lines.push('Type: ' + mem.productType);
    if (mem.techStack && mem.techStack.length)
      lines.push('Tech Stack: ' + mem.techStack.join(', '));
    if (mem.previousPassRate != null)
      lines.push('Last pass rate: ' + Math.round(mem.previousPassRate * 100) + '%');
    if (mem.criticalDefects && mem.criticalDefects.length)
      lines.push('Known critical defects: ' + mem.criticalDefects.slice(-5).join('; '));
    if (mem.lessonsLearned && mem.lessonsLearned.length)
      lines.push('Lessons learned: ' + mem.lessonsLearned.slice(-3).join('; '));
    return '\n\n' + lines.join('\n');
  }


  /* ═══════════════════════════════════════════════════════════════════
     §5  MULTI-AGENT SYSTEM PROMPTS
  ═══════════════════════════════════════════════════════════════════ */

  var AGENT_PROMPTS = {

    /* ── STP: Discovery + Product Inference + Risk ─────────────── */
    STP: function (fileHint, targetUrl) {
      var fh = fileHint ? ' מסוג ' + fileHint : '';
      var urlHint = targetUrl ? '\nTarget URL: ' + targetUrl : '';
      return (
'You are the VIBE.TESTING INTELLIGENT QA ORCHESTRATOR managing three specialized agents for the STP phase.\n' +
'Your core operating principle: Observe → Infer → Score Confidence → Identify Risk → Design\n\n' +

'EVIDENCE CLASSIFICATION — mandatory on every claim:\n' +
'[OBSERVED]  = explicitly present in the provided document/URL/screenshot\n' +
'[INFERRED]  = logically derived from context; always state the reasoning\n' +
'[ASSUMED]   = added as best practice; no direct evidence; MUST be verified in RUN\n' +
'[VALIDATED] = confirmed from multiple independent sources or prior run results\n\n' +

'ABSOLUTE RULES:\n' +
'1. Never present [ASSUMED] items as facts\n' +
'2. Never hallucinate product behavior, URLs, field names, or business rules\n' +
'3. Every [ASSUMED] item must be listed in the assumptions array in the JSON artifact\n' +
'4. Confidence score = ratio of [OBSERVED] to total evidence items (0.0–1.0)\n\n' +

'━━━ AGENT 1 — DISCOVERY ANALYST ━━━\n' +
'Task: Map everything observable in the provided input' + fh + urlHint + '\n' +
'Discover and tag:\n' +
'• All screens, pages, or views [OBSERVED/INFERRED/ASSUMED]\n' +
'• User flows and navigation paths [OBSERVED/INFERRED/ASSUMED]\n' +
'• Forms, fields, and input mechanisms\n' +
'• Data entities the system manages\n' +
'• User roles and permission levels\n' +
'• Integrations, APIs, external services\n' +
'• Error states and recovery flows\n' +
'• Knowledge gaps (what is UNKNOWN about this system — critical for [ASSUMED] tagging)\n\n' +

'━━━ AGENT 2 — PRODUCT INFERENCE AGENT ━━━\n' +
'Task: Infer system purpose, architecture, and behavior patterns\n' +
'Produce:\n' +
'• Product purpose (1 paragraph, confidence score /100)\n' +
'• User roles with primary responsibilities and permissions\n' +
'• Core entities (data objects) with their lifecycle\n' +
'• Main business flows (happy path + alternatives)\n' +
'• Technology stack indicators [OBSERVED/INFERRED]\n' +
'• Assumptions log: every inference that cannot be verified from the input alone\n\n' +

'━━━ AGENT 3 — RISK STRATEGIST ━━━\n' +
'Task: Systematic risk identification across ALL categories\n' +
'Scan each category and rate Severity(1-5) × Probability(1-5):\n' +
'✓ Authentication & Session Management\n' +
'✓ Authorization & Access Control\n' +
'✓ Input Validation & Injection risks\n' +
'✓ State Transitions & Data Integrity\n' +
'✓ CRUD operations & Data Consistency\n' +
'✓ Error Handling & Exception paths\n' +
'✓ Multi-step / Workflow processes\n' +
'✓ External Integrations & APIs\n' +
'✓ Performance & Scalability\n' +
'✓ Security (OWASP Top 10 applicable items)\n' +
'✓ Sensitive data areas & Compliance\n' +
'Tag each risk: [OBSERVED] / [INFERRED] / [ASSUMED]\n\n' +

'━━━ OUTPUT INSTRUCTIONS ━━━\n' +
'1. Produce the complete STP document in Hebrew (format below)\n' +
'2. Evidence tags must appear INLINE throughout the document\n' +
'3. After the document, append the JSON artifact block (MANDATORY)\n' +
'4. The JSON artifact MUST be the final code block in your response\n\n' +

'DOCUMENT FORMAT:\n\n' +
'# תוכנית בדיקות (STP) — [שם המוצר]\n\n' +
'## 0. מדדי בטחון ותגלית\n' +
'| סוכן | משימה | ביטחון | ראיה |\n' +
'|------|-------|--------|------|\n' +
'| Discovery | מיפוי מסכים וזרימות | X/100 | |\n' +
'| Product Inference | הבנת מוצר ועסק | X/100 | |\n' +
'| Risk Strategist | זיהוי סיכונים | X/100 | |\n\n' +
'## 1. מטרות, KPIs ו-Entry/Exit Criteria\n' +
'כל פריט: ציין [OBSERVED/INFERRED/ASSUMED]\n\n' +
'## 2. היקף הבדיקה\n' +
'### בהיקף\n### מחוץ להיקף\n### הנחות שדרושות אימות [ASSUMED items]\n\n' +
'## 3. עץ בדיקות מפורט\n' +
'לכל פריט: [BT-XXX] | P1/P2/P3 | H/M/L | Manual/Auto | זמן | ראיה: [TAG]\n\n' +
'### 3.1 בדיקות פונקציונליות (לפחות 20 פריטים)\n' +
'### 3.2 בדיקות UI/UX ונגישות (לפחות 8 פריטים)\n' +
'### 3.3 בדיקות API ואינטגרציה (לפחות 10 פריטים)\n' +
'### 3.4 בדיקות ביצועים (לפחות 6 פריטים)\n' +
'### 3.5 בדיקות אבטחה — OWASP (לפחות 8 פריטים)\n' +
'### 3.6 Smoke & Regression Suites\n\n' +
'## 4. אסטרטגיית בדיקה\n\n' +
'## 5. מטריצת סיכונים (מ-Agent 3)\n' +
'| Risk-ID | אזור | תיאור | חומרה | הסתברות | ציון | ראיה | מיטיגציה |\n\n' +
'## 6. פנקס הנחות [ASSUMED]\n' +
'| ID | הנחה | בסיס | קריטי | חייב לאמת ב- |\n\n' +
'## 7. Traceability Matrix\n\n' +
'## 8. הערכת מאמץ ולוח זמנים\n\n' +
'## 9. המלצות לשלב STD\n\n' +
'---\n' +
'```json\n' +
'{\n' +
'  "phase": "STP",\n' +
'  "generatedAt": "ISO_TIMESTAMP",\n' +
'  "productInference": {\n' +
'    "name": "...", "purpose": "...", "type": "web-app|api|mobile|desktop|SaaS|unknown",\n' +
'    "primaryUsers": [], "coreFlows": [], "techStack": [], "confidence": 0.0\n' +
'  },\n' +
'  "riskMap": [\n' +
'    {"id":"R-001","area":"auth","description":"...","severity":5,"probability":4,"score":20,\n' +
'     "evidenceTag":"[OBSERVED|INFERRED|ASSUMED]","mitigation":"..."}\n' +
'  ],\n' +
'  "testTree": {"totalItems":0,"byPriority":{"P1":0,"P2":0,"P3":0},\n' +
'    "byCategory":{"functional":0,"security":0,"performance":0,"ux":0,"api":0},\n' +
'    "automationCoverage":0.0},\n' +
'  "assumptions": [\n' +
'    {"id":"A-001","text":"...","tag":"[ASSUMED]","phase":"STP","critical":true}\n' +
'  ],\n' +
'  "confidenceScore": 0.0,\n' +
'  "confidenceBreakdown": {"discovery":0.0,"productInference":0.0,"riskAnalysis":0.0}\n' +
'}\n' +
'```'
      );
    },

    /* ── STD: Test Design + Risk (context-aware) ───────────────── */
    STD: function (context) {
      return (
'You are the VIBE.TESTING INTELLIGENT QA ORCHESTRATOR for the STD (Systematic Test Design) phase.\n\n' +
'You manage two agents that operate sequentially:\n\n' +

'━━━ AGENT 1 — TEST DESIGN ENGINEER ━━━\n' +
'Using the STP artifact and risk map provided in context, design test cases.\n\n' +
'MANDATORY for every test case:\n' +
'• source: [OBSERVED] if TC derives from explicit STP item, [INFERRED] if derived from risk, [ASSUMED] if proactive addition\n' +
'• riskRef: reference the Risk-ID from the STP risk matrix this TC addresses (null if none)\n' +
'• confidenceLevel: HIGH (≥0.8) | MEDIUM (0.5–0.79) | LOW (<0.5)\n' +
'• riskLevel: Critical | High | Medium | Low\n\n' +
'Coverage targets:\n' +
'• 35% functional happy paths\n' +
'• 25% negative / edge cases\n' +
'• 15% integration & API\n' +
'• 10% security (OWASP)\n' +
'• 10% performance indicators\n' +
'• 5% accessibility\n\n' +
'Minimum: 30 detailed test cases. Each must have reproducible steps.\n\n' +

'━━━ AGENT 2 — DESIGN VALIDATOR ━━━\n' +
'After AGENT 1 completes, validate the test suite:\n' +
'• Cross-check TCs against STP Traceability Matrix — identify uncovered requirements\n' +
'• Flag TCs with no riskRef as coverage gaps\n' +
'• Verify priority assignments align with STP risk scores (high-score risks → P1 TCs)\n' +
'• Identify assumption-derived tests that need real execution to validate\n' +
'• Produce a coverage gap report\n\n' +

'EVIDENCE RULES: [OBSERVED] [INFERRED] [ASSUMED] [VALIDATED] inline throughout.\n\n' +

'DOCUMENT FORMAT:\n\n' +
'# מסמך תסריטי בדיקה (STD)\n\n' +
'## 0. סיכום ביצועי סוכנים\n' +
'| Test Design: X תסריטים | Validator: X פערים זוהו | ביטחון כולל: X% |\n\n' +
'## 1. אסטרטגיית כיסוי\n\n' +
'## 2. תסריטי בדיקה מפורטים\n' +
'לכל תסריט:\n' +
'---\n' +
'### TC-[NNN] | [קטגוריה] | [שם]\n' +
'| עדיפות | P1/P2/P3 | סוג | Functional/Negative/... |\n' +
'| מקור | [OBSERVED/INFERRED/ASSUMED] | RiskRef | R-XXX/null |\n' +
'| ביטחון | HIGH/MEDIUM/LOW | Risk Level | Critical/High/Med/Low |\n\n' +
'**תיאור:** [מה הבדיקה בודקת ולמה קריטי]\n' +
'**תנאים מוקדמים:** \n' +
'**נתוני בדיקה:** \n' +
'**צעדים:** \n' +
'**תוצאה צפויה:** \n' +
'**קריטריון PASS/FAIL:** \n' +
'---\n\n' +
'## 3. דוח פערי כיסוי (Agent 2)\n' +
'| דרישה/סיכון שלא מכוסה | עדיפות | המלצה |\n\n' +
'## 4. פנקס הנחות STD\n\n' +
'---\n' +
'```json\n' +
'{\n' +
'  "phase": "STD",\n' +
'  "generatedAt": "ISO_TIMESTAMP",\n' +
'  "testCases": [\n' +
'    {"id":"TC-001","title":"...","priority":"P1","type":"Functional","module":"...","automation":true,\n' +
'     "riskRef":"R-001","evidenceTag":"[OBSERVED]","confidenceLevel":"HIGH","riskLevel":"Critical"}\n' +
'  ],\n' +
'  "coverageMatrix": {"requirementsCovered":0,"totalRequirements":0,"coveragePercent":0.0,"gaps":[]},\n' +
'  "assumptions": [{"id":"A-STD-001","text":"...","tag":"[ASSUMED]","phase":"STD","critical":false}],\n' +
'  "confidenceScore": 0.0,\n' +
'  "designAgentSummary": "...",\n' +
'  "validatorSummary": "..."\n' +
'}\n' +
'```'
      );
    },

    /* ── RUN: Execution + Validation ───────────────────────────── */
    RUN: function (connectionCtx) {
      return (
'You are the VIBE.TESTING INTELLIGENT QA ORCHESTRATOR for the RUN (Test Execution) phase.\n\n' +
(connectionCtx || '') + '\n\n' +

'You manage two agents:\n\n' +

'━━━ AGENT 1 — EXECUTION ENGINE ━━━\n' +
'Execute each test case from the STD using the available connection context.\n\n' +
'EVIDENCE RULES for execution results:\n' +
'• [OBSERVED] — result directly observed from system response (UI behavior, HTTP status, error message)\n' +
'• [INFERRED] — result derived from system behavior patterns (e.g. "login likely fails because...")\n' +
'• [ASSUMED]  — cannot observe directly; using expected behavior as basis\n\n' +
'Realistic distribution: 65-75% PASS ✅ | 18-28% FAIL ❌ | 5-8% SKIP ⚠\n\n' +
'For every FAIL:\n' +
'• Exact error or symptom [OBSERVED/INFERRED]\n' +
'• Root Cause (5-Whys or most likely cause)\n' +
'• Severity: Critical (blocker) | High | Medium | Low\n' +
'• Reproduction steps\n' +
'• Whether this failure was PREDICTED by the STP risk matrix (if yes, cite Risk-ID)\n\n' +
'For every SKIP: state the reason (prerequisite failed, environment issue, blocked by another failure)\n\n' +

'━━━ AGENT 2 — EXECUTION VALIDATOR ━━━\n' +
'Cross-validate AGENT 1\'s results:\n' +
'• Check: every FAIL links to a TC from STD (flag unexplained failures)\n' +
'• Check: statistical plausibility (all P1 passing + all P3 failing = suspicious pattern)\n' +
'• Check: assumption items from STP/STD — were any [ASSUMED] items now confirmed or rejected?\n' +
'• Update evidence tags: [ASSUMED] → [VALIDATED] if confirmed, [ASSUMED] → [REJECTED] if disproven\n' +
'• Compute: isConsistentWithSTD (true/false), consistencyScore (0–100)\n\n' +
'DOCUMENT FORMAT:\n\n' +
'# דוח הרצת בדיקות (RUN)\n\n' +
'## 0. אימות סוכנים\n' +
'| Execution Engine | X PASS / X FAIL / X SKIP | Validator | עקביות: X% |\n\n' +
'## 1. מידע כללי ותנאי הרצה\n\n' +
'## 2. סיכום מהיר\n' +
'| סטטוס | מספר | % |\n\n' +
'## 3. לוג הרצה מלא\n' +
'לכל TC: STATUS | משך | שגיאה (לכישלונות) | BUG-ID | חומרה | ראיה: [TAG]\n\n' +
'## 4. ניתוח כישלונות מעמיק\n' +
'### 4.1 Blockers קריטיים\n' +
'### 4.2 Root Cause Analysis\n' +
'### 4.3 סיכום Defects לפי מודול\n' +
'### 4.4 קישור לסיכוני STP (אילו סיכונים התממשו?)\n\n' +
'## 5. עדכון הנחות\n' +
'| הנחה ID | סטטוס לפני | סטטוס אחרי | ראיה |\n' +
'(עדכן כל [ASSUMED] ל-[VALIDATED] או [REJECTED] לפי הרצה)\n\n' +
'## 6. מדדי איכות\n\n' +
'## 7. Retesting Plan\n\n' +
'---\n' +
'```json\n' +
'{\n' +
'  "phase": "RUN",\n' +
'  "generatedAt": "ISO_TIMESTAMP",\n' +
'  "summary": {"pass":0,"fail":0,"skip":0,"total":0,"passRate":0.0},\n' +
'  "failures": [\n' +
'    {"tcId":"TC-001","title":"...","severity":"Critical|High|Medium|Low",\n' +
'     "errorMessage":"...","rootCause":"...","riskRef":"R-001|null",\n' +
'     "evidenceTag":"[OBSERVED|INFERRED]"}\n' +
'  ],\n' +
'  "assumptionUpdates": [\n' +
'    {"id":"A-001","previousTag":"[ASSUMED]","newTag":"[VALIDATED|REJECTED]","evidence":"..."}\n' +
'  ],\n' +
'  "validationResult": {\n' +
'    "isConsistentWithSTD": true,\n' +
'    "consistencyScore": 0,\n' +
'    "unexplainedFailures": [],\n' +
'    "suspiciousPatterns": [],\n' +
'    "confirmedRisks": [],\n' +
'    "newDiscoveries": []\n' +
'  },\n' +
'  "assumptions": [],\n' +
'  "confidenceScore": 0.0\n' +
'}\n' +
'```'
      );
    },

    /* ── STR: Insight + Validation + Memory ────────────────────── */
    STR: function () {
      return (
'You are the VIBE.TESTING INTELLIGENT QA ORCHESTRATOR for the STR (Summary Test Report) phase.\n\n' +
'You manage three agents:\n\n' +

'━━━ AGENT 1 — INSIGHT ANALYST ━━━\n' +
'Synthesize all phase artifacts into executive intelligence:\n' +
'• Produce Quality Score (0–100) with breakdown by: Functionality, Security, Performance, UX\n' +
'• Determine Go/No-Go (or Conditional) with explicit conditions and criteria\n' +
'• Identify bug clusters (groups of related failures → systemic issues)\n' +
'• Produce Pareto analysis: 20% of causes → 80% of failures\n' +
'• Promote any [INFERRED] items confirmed by RUN results to [VALIDATED]\n' +
'• Identify patterns in [ASSUMED] items across phases (systemic knowledge gaps)\n\n' +

'━━━ AGENT 2 — REPORT VALIDATOR ━━━\n' +
'Verify numerical consistency across all artifacts:\n' +
'• Cross-check: pass/fail/skip counts match between RUN artifact and narrative\n' +
'• Cross-check: Risk Register items correspond to actual RUN failures\n' +
'• Cross-check: Go/No-Go recommendation aligns with configured pass-rate thresholds\n' +
'• Flag any discrepancy as a validation note\n' +
'• Verify coverage: were all STP risk matrix items addressed by at least one test?\n\n' +

'━━━ AGENT 3 — MEMORY CURATOR ━━━\n' +
'Extract learnings for long-term memory:\n' +
'• Product name, type, tech stack (confirmed via [VALIDATED] evidence)\n' +
'• Critical defect patterns to remember for future runs on this product\n' +
'• Pass rate and trend (improvement or regression vs. prior run if memory exists)\n' +
'• Lessons learned: 10 concrete, actionable items\n' +
'• Risk patterns that should be pre-seeded in future STP runs\n' +
'• Automation candidates: top 5 tests to automate first (by ROI)\n\n' +

'DOCUMENT FORMAT:\n\n' +
'# דוח סיכום בדיקות (STR)\n\n' +
'## 0. תקציר מנהלים — מבוסס ראיות\n' +
'[250 מילים לרמת C-Level. ציין בסוף: "ביטחון הניתוח: X%"]\n\n' +
'## 1. מאמת דוחות (Agent 2)\n' +
'| בדיקת עקביות | תוצאה | הערה |\n\n' +
'## 2. KPIs ומדדים\n\n' +
'## 3. Quality Scorecard\n' +
'| קטגוריה | ציון 1-100 | ראיה | Action Required |\n\n' +
'## 4. ניתוח כישלונות ו-Pareto\n\n' +
'## 5. Risk Register מעודכן\n' +
'(כולל עדכון סטטוס לכל סיכון שהופיע ב-STP)\n\n' +
'## 6. עדכון הנחות — ציר הזמן\n' +
'[ASSUMED] → [VALIDATED] / [REJECTED] לאורך כל הפייפליין\n\n' +
'## 7. המלצה סופית: Go / No-Go / Conditional\n' +
'[קריטריונים, הצהרה ברורה, תנאים]\n\n' +
'## 8. Lessons Learned (Agent 3)\n\n' +
'## 9. תוכנית Automation — Top 5 + ROI\n\n' +
'## 10. תוכנית לסבב הבא\n\n' +
'---\n' +
'```json\n' +
'{\n' +
'  "phase": "STR",\n' +
'  "generatedAt": "ISO_TIMESTAMP",\n' +
'  "goNoGo": "GO|NO-GO|CONDITIONAL",\n' +
'  "goNoGoConditions": [],\n' +
'  "qualityScore": 0,\n' +
'  "qualityBreakdown": {"functionality":0,"security":0,"performance":0,"ux":0},\n' +
'  "bugClusters": [{"cluster":"...","count":0,"severity":"Critical|High"}],\n' +
'  "validationConsistency": {"isConsistent":true,"flags":[]},\n' +
'  "memoryExtracts": {\n' +
'    "productName":"...","productType":"...","techStack":[],"passRate":0.0,\n' +
'    "criticalDefects":[],"lessonsLearned":[]\n' +
'  },\n' +
'  "productInference": {"type":"...","confidence":0.0},\n' +
'  "assumptions": [],\n' +
'  "confidenceScore": 0.0\n' +
'}\n' +
'```'
      );
    },
  };


  /* ═══════════════════════════════════════════════════════════════════
     §6  ORCHESTRATOR — overrides buildPrompt + getContext
  ═══════════════════════════════════════════════════════════════════ */
  function patchOrchestrator() {
    // Capture original functions (defined in index.html inline script)
    var _origGetContext  = typeof getContext  === 'function' ? getContext  : function(){ return ''; };
    var _origBuildPrompt = typeof buildPrompt === 'function' ? buildPrompt : function(){ return ''; };

    /* ── getContext override: structured artifacts + fallback ─── */
    window.getContext = function (p) {
      var c = '';

      // STP artifact for phases 2+
      if (p >= 2) {
        if (window.S && S.artifacts && S.artifacts[1]) {
          c += '\n\n=== STP STRUCTURED ARTIFACT ===\n' +
               JSON.stringify(S.artifacts[1], null, 2).slice(0, 6000);
          c += '\n\n=== STP DOCUMENT EXCERPT ===\n' + ((S.data && S.data[1]) || '').slice(0, 2500);
        } else {
          c += _origGetContext(2).slice(0, 8000);
        }
      }

      // STD artifact for phases 3+
      if (p >= 3) {
        if (window.S && S.artifacts && S.artifacts[2]) {
          c += '\n\n=== STD STRUCTURED ARTIFACT ===\n' +
               JSON.stringify(S.artifacts[2], null, 2).slice(0, 5000);
          c += '\n\n=== STD DOCUMENT EXCERPT ===\n' + ((S.data && S.data[2]) || '').slice(0, 2000);
        } else if (window.S && S.data && S.data[2]) {
          c += '\n\n=== STD (תסריטי בדיקה) ===\n' + S.data[2].slice(0, 12000);
        }
      }

      // RUN artifact for phase 4
      if (p >= 4) {
        if (window.S && S.artifacts && S.artifacts[3]) {
          c += '\n\n=== RUN STRUCTURED ARTIFACT ===\n' +
               JSON.stringify(S.artifacts[3], null, 2).slice(0, 5000);
          c += '\n\n=== RUN DOCUMENT EXCERPT ===\n' + ((S.data && S.data[3]) || '').slice(0, 2000);
        } else if (window.S && S.data && S.data[3]) {
          c += '\n\n=== RUN (הרצת בדיקות) ===\n' + S.data[3].slice(0, 12000);
        }
      }

      // Inject agent memory for all phases
      c += memoryContext();

      return c;
    };

    /* ── buildPrompt override: multi-agent system prompts ─────── */
    window.buildPrompt = function (phase, context, ft, targetUrl) {
      var conn = (typeof getConnectionContext === 'function') ? getConnectionContext() : '';

      if (phase === 1) return AGENT_PROMPTS.STP(ft, targetUrl);
      if (phase === 2) return AGENT_PROMPTS.STD(context);
      if (phase === 3) return AGENT_PROMPTS.RUN(conn);
      if (phase === 4) return AGENT_PROMPTS.STR();

      // Fallback to original for any unexpected phase
      return _origBuildPrompt(phase, context, ft, targetUrl);
    };
  }


  /* ═══════════════════════════════════════════════════════════════════
     §7  SHOW-OUT HOOK — artifact extraction + evidence rendering
  ═══════════════════════════════════════════════════════════════════ */
  function patchShowOut() {
    var _origShowOut = typeof showOut === 'function' ? showOut : null;
    if (!_origShowOut) return;

    window.showOut = function (phaseId, text, streaming) {
      _origShowOut(phaseId, text, streaming);

      if (!streaming && text && phaseId >= 1 && phaseId <= 4) {
        // Extract and store artifact
        var artifact = extractArtifact(text);
        if (artifact && window.S) {
          S.artifacts[phaseId] = artifact;
          mergeAssumptions(phaseId, artifact);
          updateConfidenceBadge(phaseId, artifact.confidenceScore || 0);
          updateAssumptionsPanel();

          // Phase 4: update memory
          if (phaseId === 4) {
            updateMemoryFromSTR(artifact);
            saveMemory();
            persistMemorySupabase();
          }
        }

        // Render evidence tags in the output document
        var docEl = document.getElementById('out-doc');
        if (docEl) renderEvidenceTags(docEl);
      }
    };
  }


  /* ═══════════════════════════════════════════════════════════════════
     §8  EVIDENCE TAG RENDERER
  ═══════════════════════════════════════════════════════════════════ */
  var TAG_MAP = {
    '[OBSERVED]':  { color: '#00e5a0', label: 'OBSERVED',  title: 'Based on explicit document evidence' },
    '[INFERRED]':  { color: '#06b6d4', label: 'INFERRED',  title: 'Logically deduced from context' },
    '[ASSUMED]':   { color: '#f59e0b', label: 'ASSUMED',   title: 'No evidence — must verify in RUN phase' },
    '[VALIDATED]': { color: '#8b5cf6', label: 'VALIDATED', title: 'Confirmed by execution or multiple sources' },
    '[REJECTED]':  { color: '#f43f5e', label: 'REJECTED',  title: 'Assumption was disproven by execution' },
  };

  function renderEvidenceTags(docEl) {
    if (!docEl) return;
    var html = docEl.innerHTML;
    var changed = false;
    Object.keys(TAG_MAP).forEach(function (tag) {
      if (html.indexOf(tag) === -1) return;
      var t = TAG_MAP[tag];
      var badge = '<span class="vibe-evidence-tag vibe-et-' + t.label.toLowerCase() + '" ' +
                  'title="' + t.title + '">' + t.label + '</span>';
      html = html.split(tag).join(badge);
      changed = true;
    });
    if (changed) docEl.innerHTML = html;
  }


  /* ═══════════════════════════════════════════════════════════════════
     §9  UI — Confidence Badge & Assumptions Panel
  ═══════════════════════════════════════════════════════════════════ */
  var UI_INJECTED = false;

  function injectAgentUI() {
    if (UI_INJECTED) return;

    // ── Confidence Bar ───────────────────────────────────────────
    var outCard = document.getElementById('out-card');
    var outContent = document.getElementById('out-content');
    if (outCard && outContent) {
      var bar = document.createElement('div');
      bar.id = 'agent-confidence-bar';
      bar.className = 'agent-confidence-bar';
      bar.style.display = 'none';
      bar.innerHTML =
        '<div class="acb-left">' +
          '<span class="acb-label">AGENT ANALYSIS</span>' +
          '<div class="acb-agents" id="acb-agents"></div>' +
        '</div>' +
        '<div class="acb-right">' +
          '<span class="acb-score-label">CONFIDENCE</span>' +
          '<div class="acb-track">' +
            '<div class="acb-fill" id="acb-fill"></div>' +
          '</div>' +
          '<span class="acb-score-num" id="acb-score-num">—</span>' +
        '</div>';
      outCard.insertBefore(bar, outContent);
    }

    // ── Assumptions Panel ────────────────────────────────────────
    var outScroll = document.getElementById('out-scroll');
    if (outScroll) {
      var panel = document.createElement('div');
      panel.id = 'agent-assumptions-panel';
      panel.className = 'agent-assumptions-panel';
      panel.style.display = 'none';
      panel.innerHTML =
        '<div class="aap-header" onclick="document.getElementById(\'aap-body\').classList.toggle(\'aap-collapsed\')">' +
          '<span class="aap-title">◈ ASSUMPTIONS TRACKER</span>' +
          '<div class="aap-counts" id="aap-counts"></div>' +
          '<span class="aap-toggle">▾</span>' +
        '</div>' +
        '<div class="aap-body" id="aap-body"></div>';
      outScroll.appendChild(panel);
    }

    UI_INJECTED = true;
  }

  var PHASE_AGENTS = {
    1: ['Discovery', 'Inference', 'Risk'],
    2: ['Test Design', 'Validator'],
    3: ['Execution', 'Validator'],
    4: ['Insight', 'Validator', 'Memory'],
  };

  function updateConfidenceBadge(phaseId, score) {
    var bar    = document.getElementById('agent-confidence-bar');
    var fill   = document.getElementById('acb-fill');
    var num    = document.getElementById('acb-score-num');
    var agents = document.getElementById('acb-agents');
    if (!bar) return;

    bar.style.display = 'flex';
    var pct = Math.round((score || 0) * 100);
    var color = pct >= 80 ? '#00e5a0' : pct >= 60 ? '#f59e0b' : '#f43f5e';

    if (fill) { fill.style.width = pct + '%'; fill.style.background = color; }
    if (num)  { num.textContent = pct + '%'; num.style.color = color; }

    if (agents) {
      var agentList = PHASE_AGENTS[phaseId] || [];
      agents.innerHTML = agentList.map(function (a) {
        return '<span class="acb-agent-chip" style="border-color:' + color + '44;color:' + color + '">' +
               '✓ ' + a + '</span>';
      }).join('');
    }
  }

  function updateAssumptionsPanel() {
    var panel  = document.getElementById('agent-assumptions-panel');
    var body   = document.getElementById('aap-body');
    var counts = document.getElementById('aap-counts');
    if (!panel || !body || !window.S || !S.assumptions) return;

    var all    = S.assumptions;
    var total  = all.length;
    var critical = all.filter(function (a) { return a.critical; }).length;
    var validated = all.filter(function (a) { return a.tag === '[VALIDATED]'; }).length;
    var rejected  = all.filter(function (a) { return a.tag === '[REJECTED]';  }).length;

    if (total === 0) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';

    if (counts) {
      counts.innerHTML =
        '<span class="aap-chip aap-chip-total">' + total + ' total</span>' +
        (critical  ? '<span class="aap-chip aap-chip-critical">'  + critical  + ' critical</span>'  : '') +
        (validated ? '<span class="aap-chip aap-chip-validated">' + validated + ' validated</span>' : '') +
        (rejected  ? '<span class="aap-chip aap-chip-rejected">'  + rejected  + ' rejected</span>'  : '');
    }

    // Group by phase
    var phases = ['STP', 'STD', 'RUN', 'STR'];
    var html = '';
    phases.forEach(function (ph) {
      var items = all.filter(function (a) { return a.phase === ph; });
      if (!items.length) return;
      html += '<div class="aap-group"><span class="aap-phase-label">' + ph + '</span><div class="aap-items">';
      items.forEach(function (a) {
        var tagColor = TAG_MAP[a.tag] ? TAG_MAP[a.tag].color : '#7a9abf';
        html += '<div class="aap-item' + (a.critical ? ' aap-critical' : '') + '">' +
                '<span class="aap-item-tag" style="color:' + tagColor + ';border-color:' + tagColor + '44">' +
                (TAG_MAP[a.tag] ? TAG_MAP[a.tag].label : a.tag) + '</span>' +
                '<span class="aap-item-text">' + escHtml(a.text || '') + '</span>' +
                '</div>';
      });
      html += '</div></div>';
    });
    body.innerHTML = html || '<div class="aap-empty">No assumptions tracked yet.</div>';
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }


  /* ═══════════════════════════════════════════════════════════════════
     §10  PHASE CHANGE HOOK — reset confidence bar per phase
  ═══════════════════════════════════════════════════════════════════ */
  function patchSetPhase() {
    var _origSetPhase = typeof setPhase === 'function' ? setPhase : null;
    if (!_origSetPhase) return;
    window.setPhase = function (p) {
      _origSetPhase(p);
      // Show confidence bar if artifact exists for this phase
      if (window.S && S.artifacts && S.artifacts[p]) {
        updateConfidenceBadge(p, S.artifacts[p].confidenceScore || 0);
      } else {
        var bar = document.getElementById('agent-confidence-bar');
        if (bar) bar.style.display = 'none';
      }
    };
  }


  /* ═══════════════════════════════════════════════════════════════════
     §11  INIT
  ═══════════════════════════════════════════════════════════════════ */
  function init() {
    // Wait for S to be defined (may take up to ~300ms on slow loads)
    var attempts = 0;
    var poll = setInterval(function () {
      attempts++;
      if (!window.S && attempts < 50) return;

      clearInterval(poll);

      if (!initArtifactStore()) {
        // S not found — abort gracefully, do not break the app
        return;
      }

      loadMemory();
      patchOrchestrator();
      patchShowOut();
      patchSetPhase();

      // Inject UI elements (called once after DOM is ready)
      function tryInjectUI() {
        if (document.getElementById('out-card') && document.getElementById('out-scroll')) {
          injectAgentUI();
        } else {
          // DOM not ready yet — retry
          setTimeout(tryInjectUI, 300);
        }
      }
      tryInjectUI();

    }, 80);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
