/**
 * Implementation rules shipped with the npm package.
 * Short blurb on every explore; full text via figmagraph_rules / guidanceFull.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./paths.js";

export const GUIDANCE_SHORT = [
  "Pixel-perfect from Layout IR (flex=Auto Layout). Honor absolute pins inside flex.",
  "tokens.* / fill.token > hex. Read assetPath / figmagraph_screenshot image before coding.",
  "Mirror IR tree 1:1 — no redesign. Stack/CSS follows the repo.",
  "Call figmagraph_rules (or explore with guidanceFull=true) for full workflow + checklist.",
].join(" ");

const FALLBACK_FULL = GUIDANCE_SHORT;

let cachedFull: string | null | undefined;

export function readImplementRuleMarkdown(): string | null {
  for (const name of ["AGENT_RULE_IMPLEMENT.md", "AGENT_RULE.md"]) {
    const path = join(PACKAGE_ROOT, name);
    if (!existsSync(path)) continue;
    try {
      const md = readFileSync(path, "utf8");
      if (name === "AGENT_RULE.md") {
        const start = md.search(/^## Pixel-perfect/m);
        if (start >= 0) return md.slice(start).trim();
      }
      return md.trim();
    } catch {
      /* try next */
    }
  }
  return null;
}

export function clearGuidanceCache(): void {
  cachedFull = undefined;
}

/** Short guidance for default explore responses. */
export function implementGuidanceShort(): string {
  return GUIDANCE_SHORT;
}

/** Full pixel-perfect rules (cached). */
export function implementGuidanceFull(): string {
  if (cachedFull !== undefined) return cachedFull ?? FALLBACK_FULL;
  const md = readImplementRuleMarkdown();
  if (!md) {
    cachedFull = null;
    return FALLBACK_FULL;
  }
  let section = md;
  if (section.length > 8000) {
    section =
      section.slice(0, 8000) +
      "\n…(truncated; see AGENT_RULE_IMPLEMENT.md in the figmagraph package)";
  }
  cachedFull = section;
  return section;
}

/** @deprecated use implementGuidanceShort / Full */
export function implementGuidance(): string {
  return implementGuidanceFull();
}
