# Figmagraph

Local Figma → Layout IR + screenshots for agents.

```bash
npm i -g figmagraph
cd your-app && figmagraph init
```

Paste a Figma link in Cursor. That’s it.

- First sync downloads the **whole file** (node-id stripped); later links to the same file use the local DB.
- No PAT: free Figma MCP read → cached into `.figmagraph/`.
- Optional: `figmagraph token <figu_…>` for REST sync.

```bash
figmagraph status | reset | doctor
figmagraph serve   # optional plugin Push (no API quota)
```

MCP: `figmagraph_explore` · `figmagraph_screenshot` · `figmagraph_sync`  
Rules: [AGENT_RULE.md](./AGENT_RULE.md) · publish: [PUBLISH.md](./PUBLISH.md)

MIT
