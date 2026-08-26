# FigmaGraph (agent rule)

## Figma link pasted

Do **not** wait.

1. `figmagraph_explore` once (URL + `projectPath`).
2. Indexed → implement from IR + local screenshot. Stay local.
3. `hint: needs-access` → follow `fallback.accessPlan` (**prefer `oauth-login`**):
   - Ask once: `figmagraph login` (browser OAuth, **View OK**) → re-explore same URL.
   - Or `figmagraph token <figu_…>` / Desktop plugin Push.
   - Official Figma MCP only if Can edit; on *edit access* error **stop** — switch to login.
4. Legacy `hint: figma-mcp-fallback` / `agentPlan` = MCP-only subpath (unreliable on View).

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

Humans: `figmagraph init` → `figmagraph login` once → paste links. `figmagraph doctor` to verify.
