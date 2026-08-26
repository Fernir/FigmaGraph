# Figmagraph

Local Figma knowledge graph for agents — Layout IR + screenshots in `.figmagraph/`, served over MCP. Happy path is offline after sync (Desktop plugin → `figmagraph serve`).

## 30-second demo

```bash
npm i -g figmagraph
cd your-app
figmagraph serve
```

In Figma: **Plugins → Development → Import plugin from manifest…** → `plugin/manifest.json` from the figmagraph install (or this repo). Select frames → **Push to localhost**.

Paste a Figma link in Cursor — the agent should `figmagraph_explore` / screenshot and implement from Layout IR (pixel-perfect rules ship in the package).

```bash
figmagraph doctor   # native binary, MCP wire, index
figmagraph status
```

## Install

```bash
npm i -g figmagraph
# or from this repo:
npm i -g .
```

## vs official Figma MCP

Figmagraph: local index, Layout IR, no free-tier burn after sync. Official Figma MCP: live canvas peek — don’t use it as the daily implement path.

## URL init (uses API quota)

```bash
figmagraph token figu_xxx
figmagraph init 'https://www.figma.com/design/FILEKEY/Name?node-id=1-2'
```

Prefer plugin push for day-to-day refreshes. Screens **merge** by default; `--replace` to wipe.

## What you get

- **raw** — thick dump  
- **Layout IR** — flex / absolute / tokens  
- **assets** — PNG/SVG under `.figmagraph/assets/`  
- **guidance** — short on explore; full via `figmagraph_rules`

## Dev / publish

```bash
npm run build
npm test
npm run build:native
```

See [PUBLISH.md](./PUBLISH.md) for tagging natives + `npm publish`. Agent rules: [AGENT_RULE.md](./AGENT_RULE.md) (always-on) + [AGENT_RULE_IMPLEMENT.md](./AGENT_RULE_IMPLEMENT.md) (pixel-perfect).

## License

MIT
