# Experience audit on Claude Code

## Install
```bash
npx skills add sourav-ojha/agent-skills --skill experience-audit -a claude-code        # project
npx skills add sourav-ojha/agent-skills --skill experience-audit -a claude-code -g     # global
```
Update with `npx skills update`. The helper is `node <skill-dir>/core/scripts/ea.mjs`, where `<skill-dir>` is `.claude/skills/experience-audit` (project) or `~/.claude/skills/experience-audit` (global). It is not copied into your project.

## Optional native agents
```bash
node <skill-dir>/core/scripts/install-agents.mjs --scope project     # writes .claude/agents/ea-*.md
node <skill-dir>/core/scripts/install-agents.mjs --scope project --remove
```
Tiers map to model aliases in `core/config.default.json`. Roles that need a browser (surveyor, visual-judge, a11y-checker) get no tool list so they inherit your browser tools.

## Browser capability mapping
The skill needs: navigate, resize, evaluate JavaScript, screenshot. Any of these provides them:

| Capability | Playwright MCP | Chrome DevTools MCP | Claude in Chrome / in-app browser |
|---|---|---|---|
| navigate | `browser_navigate` | `navigate_page` | navigate |
| resize | `browser_resize` | `resize_page` / `emulate` (viewport, colour scheme) | resize window |
| evaluate the collector | `browser_evaluate` | `evaluate_script` | JavaScript tool |
| screenshot | `browser_take_screenshot` | `take_screenshot` | screenshot |
| accessibility snapshot | `browser_snapshot` | `take_snapshot` | read page |
| Lighthouse | not built in | `lighthouse_audit` (device, mode) | not built in |

Names differ by version and setup; check what your session lists. `collect.js` is one function that returns JSON, so it works with any tool that evaluates a function.

## Tips
- Start a local dev server or use staging; the audit needs a reachable URL. Production only if you say so.
- Add `.experience/evidence/` to `.gitignore` (screenshots may contain personal data). `.experience/findings.json`, `decisions.md` and `fixes/` are worth committing.
- Chrome DevTools MCP: pass `--no-performance-crux` so trace URLs are not sent to Google's CrUX API, and consider turning off its usage statistics. Playwright MCP: use `--isolated`; `--allowed-origins` limits navigation but is not a security boundary.
- Ask before installing anything (Lighthouse, Unlighthouse, axe packages). Without them the skill uses its own probes and, if the page allows, axe injected through the browser (a strict Content-Security-Policy can block that).
- Approvals and "needs evidence" answers come from you in chat. The helper records them but cannot prove who typed a command; the real gate is you reading the report.

## Use
`/experience-audit audit --url http://localhost:3000`, `/experience-audit seo`, `/experience-audit reaudit`, then pass `.experience/fixes/FIX-001.md` to `/implementer`.
