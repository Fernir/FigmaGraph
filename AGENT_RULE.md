# Figmagraph (agent rule)

## Figma link pasted

Do **not** wait. Prefer local `.figmagraph/` over official Figma MCP.

1. `figmagraph_explore` with the URL + `projectPath` = workspace root.
2. IR / screenshot present → implement from that.
3. `hint: figma-mcp-fallback` → official `get_screenshot` + `get_metadata` → `figmagraph_sync` (cache) → explore again.
4. Same file already indexed → local only (node-id selects). Fresh file → whole-file sync (node stripped).

## `.figmagraph/` exists

- Primary: `figmagraph_explore`. Screenshot / sync only if needed.
- IR: flex → Auto Layout; `absolute` even inside flex; tokens > hex.
- `guidanceFull: true` for the full checklist.

Humans: `figmagraph init`. Token optional. `figmagraph reset` wipes local data.
