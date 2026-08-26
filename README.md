# FigmaGraph

**Local Figma index for AI agents** — Layout IR + screenshots in `.figmagraph/`.

[![npm](https://img.shields.io/npm/v/figmagraph.svg)](https://www.npmjs.com/package/figmagraph)
[![license](https://img.shields.io/npm/l/figmagraph.svg)](./LICENSE)

---

## Quick start (recommended — View is enough)

```bash
npm i -g figmagraph
cd your-app && figmagraph init
figmagraph login
```

Browser opens → **Allow** → return to Cursor → paste Figma links. Sync is **automatic** (View permission is enough).

| Path | View OK? | Automatic from link? |
|------|----------|----------------------|
| **`figmagraph login`** (OAuth) | yes | yes, after one login |
| Manual PAT (`figmagraph token`) | yes | yes |
| Desktop plugin Push | yes | no (Push in Figma) |
| Official Figma MCP | often **no** | unreliable on View |

Private files cannot be fetched with zero auth — Figma always requires a login in the browser.

**OAuth app redirect URL** (Figma Developers → OAuth credentials):

```
http://127.0.0.1:9474/oauth/callback
http://localhost:9474/oauth/callback
```

**Scopes:** `file_content:read`, `file_metadata:read`, `current_user:read`

---

## Commands

```bash
figmagraph init | login | token | status | reset | doctor
figmagraph serve            # plugin Push — no API quota
```

---

## Agent tools

| Tool | Role |
|------|------|
| `figmagraph_explore` | Primary — local IR; without index returns `accessPlan` |
| `figmagraph_sync` | Cache MCP output / URL sync |
| `figmagraph_screenshot` | Design image |
| `figmagraph_compare` | Visual QA — prefer `candidatePath`; images opt-in |

---

## Docs

[Agent rule](./AGENT_RULE.md) · [Pixel-perfect](./AGENT_RULE_IMPLEMENT.md) · [Publish](./PUBLISH.md)

MIT
