import type { FigmaColor, FigmaPaint, PaintRef, StrokeRef, EffectRef, TextStyleRef } from "../types.js";

export function rgbaToHex(c: FigmaColor): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const a = c.a ?? 1;
  const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  if (a < 1) {
    return `${hex}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
  }
  return hex;
}

function boundTokenName(
  paint: FigmaPaint,
  tokenNames: Map<string, string>
): string | undefined {
  const bv = paint.boundVariables?.color;
  if (!bv) return undefined;
  const id = Array.isArray(bv) ? bv[0]?.id : bv.id;
  if (!id) return undefined;
  const name = tokenNames.get(id);
  return name ? `token:${name}` : undefined;
}

export function paintToRef(
  paint: FigmaPaint,
  tokenNames: Map<string, string>,
  assetMap: Record<string, string>
): PaintRef | null {
  if (paint.visible === false) return null;
  const token = boundTokenName(paint, tokenNames);
  if (paint.type === "SOLID" && paint.color) {
    return {
      type: "solid",
      color: rgbaToHex(paint.color),
      opacity: paint.opacity,
      token,
    };
  }
  if (paint.type.startsWith("GRADIENT_") && paint.gradientStops) {
    const stops = paint.gradientStops
      .map((s) => `${rgbaToHex(s.color)} ${Math.round(s.position * 100)}%`)
      .join(", ");
    const kind =
      paint.type === "GRADIENT_RADIAL"
        ? "radial-gradient"
        : paint.type === "GRADIENT_ANGULAR"
          ? "conic-gradient"
          : "linear-gradient";
    return { type: "gradient", css: `${kind}(${stops})`, token };
  }
  if (paint.type === "IMAGE") {
    const assetPath = paint.imageRef ? assetMap[paint.imageRef] : undefined;
    return { type: "image", imageRef: paint.imageRef, assetPath };
  }
  return { type: "none" };
}

export function paintsToRefs(
  paints: FigmaPaint[] | undefined,
  tokenNames: Map<string, string>,
  assetMap: Record<string, string>
): PaintRef[] | undefined {
  if (!paints?.length) return undefined;
  const refs = paints
    .map((p) => paintToRef(p, tokenNames, assetMap))
    .filter((p): p is PaintRef => p !== null && p.type !== "none");
  return refs.length ? refs : undefined;
}

export function strokesToRefs(
  strokes: FigmaPaint[] | undefined,
  weight: number | undefined,
  align: string | undefined,
  tokenNames: Map<string, string>
): StrokeRef[] | undefined {
  if (!strokes?.length || !weight) return undefined;
  const out: StrokeRef[] = [];
  for (const s of strokes) {
    if (s.visible === false || s.type !== "SOLID" || !s.color) continue;
    const bv = s.boundVariables?.color;
    const id = bv ? (Array.isArray(bv) ? bv[0]?.id : bv.id) : undefined;
    out.push({
      color: rgbaToHex(s.color),
      weight,
      align: (align?.toLowerCase() as StrokeRef["align"]) ?? "center",
      token: id && tokenNames.has(id) ? `token:${tokenNames.get(id)}` : undefined,
    });
  }
  return out.length ? out : undefined;
}

export function effectsToRefs(
  effects: Array<{
    type: string;
    visible?: boolean;
    radius?: number;
    color?: FigmaColor;
    offset?: { x: number; y: number };
    spread?: number;
  }> | undefined
): EffectRef[] | undefined {
  if (!effects?.length) return undefined;
  const out: EffectRef[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const x = e.offset?.x ?? 0;
      const y = e.offset?.y ?? 0;
      const blur = e.radius ?? 0;
      const spread = e.spread ?? 0;
      const color = e.color ? rgbaToHex(e.color) : "#00000040";
      const inset = e.type === "INNER_SHADOW" ? "inset " : "";
      out.push({
        type: "shadow",
        css: `${inset}${x}px ${y}px ${blur}px ${spread}px ${color}`,
      });
    } else if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
      out.push({ type: "blur", radius: e.radius ?? 0 });
    }
  }
  return out.length ? out : undefined;
}

export function textStyleFromNode(style: {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
  textAlignHorizontal?: string;
} | undefined, fillColor?: string): TextStyleRef {
  return {
    fontFamily: style?.fontFamily,
    fontSize: style?.fontSize,
    fontWeight: style?.fontWeight,
    lineHeight: style?.lineHeightPx,
    letterSpacing: style?.letterSpacing,
    textAlign: style?.textAlignHorizontal?.toLowerCase(),
    color: fillColor,
  };
}

/** Build id→name map from Figma styles / variable-like names in export meta. */
export function buildTokenNameMap(
  styles?: Record<string, { key?: string; name?: string; styleType?: string }>
): Map<string, string> {
  const map = new Map<string, string>();
  if (!styles) return map;
  for (const [id, s] of Object.entries(styles)) {
    if (s.name) map.set(id, s.name.replace(/\s+/g, "/").toLowerCase());
  }
  return map;
}
