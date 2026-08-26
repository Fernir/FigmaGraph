# FigmaGraph

**Local Figma index for AI agents** — Layout IR + screenshots in `.figmagraph/`.  
No Figma PAT and no Desktop plugin required for the default path.

[![npm](https://img.shields.io/npm/v/figmagraph.svg)](https://www.npmjs.com/package/figmagraph)
[![license](https://img.shields.io/npm/l/figmagraph.svg)](./LICENSE)

---

## Quick start

```bash
npm i -g figmagraph
cd your-app && figmagraph init
figmagraph doctor
```

Paste a Figma link (**with `node-id`**) in Cursor.

| Step | What happens |
|------|----------------|
| 1 | `figmagraph_explore` — if empty, returns **`agentPlan`** |
| 2 | Agent uses official Figma MCP once (free tier) |
| 3 | `figmagraph_sync` caches screenshot (+ metadata / design context) |
| 4 | Explore again — **local forever** for that node |

Minimum free round: **screenshot only**. Best: screenshot + metadata + design context together.

---

## Commands

```bash
figmagraph init | status | reset | doctor
```

Optional upgrades (not required):

```bash
figmagraph token <figu_…>   # unlimited REST whole-file sync
figmagraph serve            # plugin Push — no API quota
```

---

## Agent tools

| Tool | Role |
|------|------|
| `figmagraph_explore` | Primary — local IR / free-path `agentPlan` |
| `figmagraph_sync` | Cache MCP output |
| `figmagraph_screenshot` | Design image |
| `figmagraph_compare` | Visual QA — prefer `candidatePath`; images opt-in |

---

## Docs

[Agent rule](./AGENT_RULE.md) · [Pixel-perfect](./AGENT_RULE_IMPLEMENT.md) · [Publish](./PUBLISH.md)

MIT
