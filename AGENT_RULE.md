# Figmagraph (agent rule)

## When the user pastes a Figma link (`figma.com/design/...` or `/file/...`)

Do **not** wait for them to say “use figmagraph”. Automatically:

1. `figmagraph_status` with `projectPath` = workspace root.
2. If no index (or they want a fresh pull): `figmagraph_init` with that URL + `projectPath`.
3. Then `figmagraph_explore` / `figmagraph_screenshot` and implement from Layout IR.
4. If the URL has `node-id`, pass that id into explore/query first.

Never prefer the official Figma MCP when figmagraph can answer.

If init fails for lack of token: `figmagraph token <figu_…>`, **or** `figmagraph serve` + plugin **Push to localhost**.

## When `.figmagraph/` already exists

1. `figmagraph_explore` / `figmagraph_status` / `figmagraph_screenshot` with `projectPath` = workspace root.
2. Implement **pixel-perfect** from Layout IR — follow `guidance` from explore (or call `figmagraph_rules`).
3. **Read the local screenshot** (`assetPath` / `figmagraph_screenshot`) before coding when visuals matter.
4. `layout.mode: flex` → Auto Layout; `positioning: absolute` / `absolute` coords → positioned even inside flex; tokens beat hex.
5. Do not call Figma REST yourself after init/push.

Day-to-day: plugin Push while `figmagraph serve` runs. Screens **merge** by default; `--replace` / “Replace entire index” to wipe.
