# Figmagraph

**Local Figma index for AI agents** — Layout IR + screenshots in `.figmagraph/`.  
Offline after sync. Works with Cursor, Claude, Codex, and more.

[![npm](https://img.shields.io/npm/v/figmagraph.svg)](https://www.npmjs.com/package/figmagraph)
[![license](https://img.shields.io/npm/l/figmagraph.svg)](./LICENSE)

---

## Quick start

```bash
npm i -g figmagraph
cd your-app && figmagraph init
```

Paste a Figma link in chat. The agent calls `figmagraph_explore` — that’s the whole loop.

| | |
|---|---|
| **First link** | Downloads the whole file (`node-id` stripped) |
| **Same file again** | Local DB only — no Figma re-read |
| **No PAT** | Free Figma MCP read → cached via `figmagraph_sync` |
| **Optional** | `figmagraph token <figu_…>` for unlimited REST |

---

## Commands

```bash
figmagraph init      # wire project + MCP
figmagraph status    # index stats
figmagraph reset     # wipe local design data
figmagraph doctor    # health check
figmagraph serve     # optional: plugin Push (no API quota)
figmagraph stop
```

---

## Agent tools

| Tool | Role |
|------|------|
| `figmagraph_explore` | Primary — URL / name / node-id → IR + screenshot |
| `figmagraph_screenshot` | Extra image when needed |
| `figmagraph_sync` | Force refresh, ZIP, or cache MCP output |

Prefer figmagraph over the official Figma MCP once data is local.

---

## Docs

- [Agent rule](./AGENT_RULE.md) — always-on workflow  
- [Pixel-perfect checklist](./AGENT_RULE_IMPLEMENT.md) — `guidanceFull`  
- [Publish](./PUBLISH.md) — npm + native binaries  

---

MIT © figmagraph
