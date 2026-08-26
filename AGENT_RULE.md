# FigmaGraph (agent rule)

## Figma link pasted

Do **not** wait. Do **not** ask for a Figma PAT or Desktop plugin first.

1. `figmagraph_explore` once (URL + `projectPath`). Use IR + the one attached screenshot.
2. `hint: figma-mcp-fallback` → follow `fallback.agentPlan` (free path).
3. File already indexed → local only — no more Figma MCP.

## After implement (visual QA — token-cheap)

1. Finish the UI first; do **not** compare after every CSS tweak.
2. Save a PNG of the frame to disk (e.g. `.figmagraph/compare/ui.png`).
3. `figmagraph_compare` with `nodeId` + **`candidatePath`** (not base64).
4. Default response is JSON only. If `passed=false`, optionally one call with `includeDiff=true`, then fix.
5. Max **2–3** compares per screen. Stop when `passed=true` (default ≥95%).
6. Do not re-call `figmagraph_screenshot` / explore screenshot if you already have the design image.

## `.figmagraph/` exists

- explore → implement → compare (paths). IR: flex / absolute / tokens.
- `guidanceFull` only if needed.

Humans: `figmagraph init` → paste link. `figmagraph doctor` to verify.
