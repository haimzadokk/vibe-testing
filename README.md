# VIBE.TESTING — AI-Powered QA Generator

> Turn any spec document or website URL into a complete QA test suite in minutes — powered by Claude AI.

🔗 **[Live Demo → haimzadokk.github.io/vibe-testing](https://haimzadokk.github.io/vibe-testing)**

---

## What is VIBE.TESTING?

VIBE.TESTING is a browser-based QA automation tool that generates professional test documentation through 4 sequential phases — from test planning all the way to a management summary report. No installation required. No backend. Just open and run.

Built as a side project using **Vibe Coding** — no upfront planning, pure flow — it evolved from a simple QA helper into a full developer companion that replaces a QA engineer at the development stage.

---

## Features

- **4-Phase QA Pipeline** — STP → STD → RUN → STR
- **URL Analysis** — Enter any website URL and get a tailored test plan automatically
- **File Upload** — Supports DOCX, PDF, Excel, TXT, MD, JSON, YAML, HTML and 30+ formats
- **Smart Chat** — Ask questions about your test results, request analysis, add requirements
- **Real-time Streaming** — Watch output generate live with Claude Sonnet
- **Stop Anytime** — Interrupt generation and keep partial output
- **Export** — PDF, Excel/CSV, Markdown, Plain Text
- **Executive Dashboard** — Visual KPIs, Pass/Fail/Skip charts, Go/No-Go verdict with reasoning
- **System Connection** — Connect to tested systems via URL, API Token, Basic Auth, or Custom Headers
- **Fully Responsive** — Works on desktop and mobile browsers

---

## The 4 Phases

| Phase | Name | Description |
|-------|------|-------------|
| ◈ STP | Test Planning | Detailed test tree from spec doc or website URL |
| ◉ STD | Test Design | Full test cases with steps, data, and expected results |
| ▶ RUN | Test Execution | Realistic execution report with defect analysis and Root Cause |
| ◆ STR | Test Report | Management summary with Go/No-Go, KPIs, and visual dashboard |

---

## How to Use

1. Open **[haimzadokk.github.io/vibe-testing](https://haimzadokk.github.io/vibe-testing)**
2. Click **"Start Now"** on the welcome screen
3. Enter your **Anthropic API Key** (`sk-ant-...`) — stored in browser memory only, never saved
4. Upload a spec document **or** enter a website URL
5. Click **GENERATE** and watch the magic happen
6. Move through each phase and export your results

> **Cost:** ~$0.02–0.05 per full 4-phase run with Claude Sonnet

---

## Getting Your API Key

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up / Log in
3. Navigate to **API Keys** → **Create Key**
4. Paste it into VIBE.TESTING — it's only stored in your browser tab

---

## Tech Stack

- **Frontend:** Vanilla HTML + CSS + JavaScript (single file, no build step)
- **AI:** Anthropic Claude Sonnet via REST API
- **Proxy:** Cloudflare Workers (hides API key server-side)
- **Hosting:** GitHub Pages
- **File Parsing:** Mammoth.js (DOCX), JSZip, native FileReader

---

## Running Locally

```bash
# Clone the repo
git clone https://github.com/haimzadokk/vibe-testing.git
cd vibe-testing

# Serve locally (required for CORS)
python -m http.server 8080

# Open in browser
# http://localhost:8080
```

> Note: Must be served via HTTP server (not opened as a file) due to browser CORS restrictions.

---

## Privacy & Security

- Your API Key is stored in **sessionStorage only** — cleared when you close the tab
- No user data is stored on any server
- All AI calls go through a Cloudflare Worker proxy that keeps your key hidden
- No analytics, no tracking, no ads

---

## Status

🟢 **Beta** — Free and open for everyone to use. Feedback and feature requests are welcome!

---

## Feedback & Contributing

Found a bug? Have a feature idea? Open an issue or reach out on [LinkedIn](https://www.linkedin.com/in/haim-zadok).

All feedback is welcome — this is a beta and improvements are ongoing.

---

## License

MIT License — free to use, modify, and distribute.

---

*Built by [Haim Zadok](https://www.linkedin.com/in/haim-zadok) © 2026 · All Rights Reserved*

