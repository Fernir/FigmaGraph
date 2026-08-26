import type {
  AssetMap,
  FigmaDocument,
  FigmaNode,
  LayoutNode,
  LayoutNodeRole,
  Size,
  TextSegment,
} from "../types.js";
import {
  buildTokenNameMap,
  effectsToRefs,
  paintsToRefs,
  rgbaToHex,
  strokesToRefs,
  textStyleFromNode,
} from "./tokens.js";

function roleOf(type: string): LayoutNodeRole {
  switch (type) {
    case "FRAME":
    case "COMPONENT_SET":
    case "SECTION":
      return "frame";
    case "GROUP":
      return "group";
    case "TEXT":
      return "text";
    case "RECTANGLE":
    case "ELLIPSE":
    case "LINE":
    case "POLYGON":
    case "STAR":
    case "VECTOR":
    case "BOOLEAN_OPERATION":
      return "vector";
    case "COMPONENT":
      return "component";
    case "INSTANCE":
      return "instance";
    default:
      return "other";
  }
}

function mapAlign(value?: string): string | undefined {
  if (!value) return undefined;
  switch (value) {
    case "MIN":
      return "flex-start";
    case "CENTER":
      return "center";
    case "MAX":
      return "flex-end";
    case "SPACE_BETWEEN":
      return "space-between";
    case "BASELINE":
      return "baseline";
    default:
      return value.toLowerCase();
  }
}

function sizeFrom(
  sizing: "FIXED" | "HUG" | "FILL" | undefined,
  fixedPx: number | undefined,
  axisSizingMode: "FIXED" | "AUTO" | undefined,
  layoutGrow: number | undefined,
  isPrimary: boolean,
  hasAutoLayout: boolean
): Size | undefined {
  if (sizing === "HUG") return { kind: "hug" };
  if (sizing === "FILL") return { kind: "fill" };
  if (sizing === "FIXED" && fixedPx != null) return { kind: "fixed", value: Math.round(fixedPx) };

  // Legacy REST fields
  if (hasAutoLayout) {
    if (layoutGrow && layoutGrow > 0) return { kind: "fill" };
    if (isPrimary) {
      if (axisSizingMode === "AUTO") return { kind: "hug" };
    } else {
      if (axisSizingMode === "AUTO") return { kind: "hug" };
    }
  }
  if (fixedPx != null) return { kind: "fixed", value: Math.round(fixedPx) };
  return undefined;
}

function nodeSize(node: FigmaNode): { w?: number; h?: number } {
  if (node.absoluteBoundingBox) {
    return {
      w: node.absoluteBoundingBox.width,
      h: node.absoluteBoundingBox.height,
    };
  }
  if (node.size) return { w: node.size.x, h: node.size.y };
  return {};
}

function relativePos(node: FigmaNode, parent?: FigmaNode): { x: number; y: number } | null {
  const box = node.absoluteBoundingBox;
  const pbox = parent?.absoluteBoundingBox;
  if (box && pbox) {
    return {
      x: Math.round(box.x - pbox.x),
      y: Math.round(box.y - pbox.y),
    };
  }
  // relativeTransform origin
  const t = node.relativeTransform;
  if (t?.[0]?.[2] != null && t?.[1]?.[2] != null) {
    return { x: Math.round(t[0][2]), y: Math.round(t[1][2]) };
  }
  return null;
}

function isAutoLayout(node: FigmaNode): boolean {
  return node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL";
}

function boundTokensFromNode(
  node: FigmaNode,
  tokenNames: Map<string, string>
): Record<string, string> | undefined {
  const bv = node.boundVariables;
  if (!bv) return undefined;
  const out: Record<string, string> = {};
  for (const [prop, ref] of Object.entries(bv)) {
    const id = Array.isArray(ref) ? ref[0]?.id : ref?.id;
    if (!id) continue;
    const name = tokenNames.get(id);
    if (name) out[prop] = `token:${name}`;
  }
  return Object.keys(out).length ? out : undefined;
}

function variantPropsFromComponentProperties(
  props: Record<string, unknown> | undefined
): Record<string, string> | undefined {
  if (!props) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (!v || typeof v !== "object") continue;
    const rec = v as { type?: string; value?: unknown };
    if (rec.type === "VARIANT" && rec.value != null) {
      out[k] = String(rec.value);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function textSegmentsFromNode(
  node: FigmaNode,
  fillColor?: string
): TextSegment[] | undefined {
  const chars = node.characters ?? "";
  const overrides = node.characterStyleOverrides;
  const table = node.styleOverrideTable;
  if (!overrides?.length || !table || !chars) return undefined;

  const segments: TextSegment[] = [];
  let i = 0;
  while (i < chars.length) {
    const styleId = overrides[i] ?? 0;
    let j = i + 1;
    while (j < chars.length && (overrides[j] ?? 0) === styleId) j++;
    const overrideStyle = styleId ? table[String(styleId)] : undefined;
    const base = textStyleFromNode(node.style, fillColor);
    const over = textStyleFromNode(overrideStyle, fillColor);
    segments.push({
      characters: chars.slice(i, j),
      style: {
        ...base,
        ...Object.fromEntries(
          Object.entries(over).filter(([, v]) => v != null)
        ),
      },
    });
    i = j;
  }
  return segments.length > 1 ? segments : undefined;
}

function compileNode(
  node: FigmaNode,
  parent: FigmaNode | undefined,
  parentIsFlex: boolean,
  tokenNames: Map<string, string>,
  assetMap: AssetMap,
  components: FigmaDocument["components"],
  opts: { collapseInstances: boolean; codeConnect?: Record<string, string> }
): LayoutNode | null {
  if (node.visible === false) return null;

  const auto = isAutoLayout(node);
  const { w, h } = nodeSize(node);
  const role = roleOf(node.type);

  const width = sizeFrom(
    node.layoutSizingHorizontal,
    w,
    node.layoutMode === "HORIZONTAL"
      ? node.primaryAxisSizingMode
      : node.counterAxisSizingMode,
    node.layoutGrow,
    node.layoutMode === "HORIZONTAL",
    Boolean(parent && isAutoLayout(parent))
  );
  const height = sizeFrom(
    node.layoutSizingVertical,
    h,
    node.layoutMode === "VERTICAL"
      ? node.primaryAxisSizingMode
      : node.counterAxisSizingMode,
    node.layoutGrow,
    node.layoutMode === "VERTICAL",
    Boolean(parent && isAutoLayout(parent))
  );

  const fills = paintsToRefs(node.fills, tokenNames, assetMap);
  const strokes = strokesToRefs(
    node.strokes,
    node.strokeWeight,
    node.strokeAlign,
    tokenNames
  );
  const effects = effectsToRefs(node.effects);

  let radius: LayoutNode["visual"]["radius"];
  if (node.rectangleCornerRadii) {
    radius = node.rectangleCornerRadii.map((n) => Math.round(n)) as [
      number,
      number,
      number,
      number,
    ];
  } else if (node.cornerRadius != null && node.cornerRadius > 0) {
    radius = Math.round(node.cornerRadius);
  }

  const layout: LayoutNode["layout"] = {
    mode: auto ? "flex" : "none",
    width,
    height,
  };

  if (auto) {
    layout.direction = node.layoutMode === "HORIZONTAL" ? "row" : "column";
    if (node.itemSpacing) layout.gap = node.itemSpacing;
    const pt = node.paddingTop ?? 0;
    const pr = node.paddingRight ?? 0;
    const pb = node.paddingBottom ?? 0;
    const pl = node.paddingLeft ?? 0;
    if (pt || pr || pb || pl) layout.padding = [pt, pr, pb, pl];
    layout.justify = mapAlign(node.primaryAxisAlignItems);
    layout.align = mapAlign(node.counterAxisAlignItems);
    if (node.layoutWrap === "WRAP") layout.wrap = true;
  }

  if (node.minWidth != null) layout.minWidth = Math.round(node.minWidth);
  if (node.maxWidth != null) layout.maxWidth = Math.round(node.maxWidth);
  if (node.minHeight != null) layout.minHeight = Math.round(node.minHeight);
  if (node.maxHeight != null) layout.maxHeight = Math.round(node.maxHeight);
  if (node.clipsContent) layout.clipsContent = true;
  if (node.rotation) layout.rotation = node.rotation;

  const absoluteChild =
    node.layoutPositioning === "ABSOLUTE" || !parentIsFlex;
  if (absoluteChild) {
    const pos = relativePos(node, parent);
    layout.absolute = pos;
    if (node.layoutPositioning === "ABSOLUTE") layout.positioning = "absolute";
  } else {
    layout.absolute = null;
    layout.positioning = "auto";
  }

  const ir: LayoutNode = {
    id: node.id,
    name: node.name,
    role,
    layout,
    visual: {
      fills,
      strokes,
      radius,
      opacity: node.opacity != null && node.opacity < 1 ? node.opacity : undefined,
      effects,
    },
  };

  const nodeTokens = boundTokensFromNode(node, tokenNames);
  if (nodeTokens) ir.tokens = nodeTokens;

  const assetPath =
    assetMap[node.id] ??
    (node.id.includes(";") ? undefined : assetMap[node.id.replace(":", "-")]);
  if (assetPath) {
    const kind = assetPath.endsWith(".svg")
      ? "svg"
      : assetPath.includes("image_")
        ? "imageFill"
        : "png";
    ir.asset = { kind, path: assetPath };
  }

  if (node.type === "TEXT") {
    const fillColor =
      node.fills?.[0]?.type === "SOLID" && node.fills[0].color
        ? rgbaToHex(node.fills[0].color)
        : undefined;
    ir.text = {
      characters: node.characters ?? "",
      style: textStyleFromNode(node.style, fillColor),
      segments: textSegmentsFromNode(node, fillColor),
    };
  }

  if (node.type === "INSTANCE" || node.type === "COMPONENT") {
    const mainId = node.componentId;
    const compMeta = mainId ? components?.[mainId] : undefined;
    const variantProperties =
      node.variantProperties ??
      variantPropsFromComponentProperties(node.componentProperties);
    const codeConnect =
      (mainId && opts.codeConnect?.[mainId]) ||
      (compMeta?.description &&
      /[./]/.test(compMeta.description) &&
      compMeta.description.length < 200
        ? compMeta.description.trim()
        : undefined);
    ir.component = {
      key: compMeta?.key,
      mainComponentId: mainId,
      overrides: node.componentProperties as Record<string, unknown> | undefined,
      variantProperties,
      codeConnect,
    };
    // Collapse instance trees: keep shell + overrides, skip deep children unless no main
    if (opts.collapseInstances && node.type === "INSTANCE" && mainId) {
      return ir;
    }
  }

  if (node.children?.length) {
    const kids: LayoutNode[] = [];
    for (const child of node.children) {
      const c = compileNode(
        child,
        node,
        auto,
        tokenNames,
        assetMap,
        components,
        opts
      );
      if (c) kids.push(c);
    }
    if (kids.length) ir.children = kids;
  }

  return ir;
}

export type CompileOptions = {
  collapseInstances?: boolean;
  /** Limit depth of returned tree (undefined = full). */
  maxDepth?: number;
};

/** Compile a Figma node tree into Layout IR. */
export function compileLayoutIR(
  root: FigmaNode,
  doc: FigmaDocument,
  assetMap: AssetMap = {},
  options: CompileOptions = {}
): LayoutNode | null {
  const tokenNames = buildTokenNameMap(doc.styles);
  const collapseInstances = options.collapseInstances ?? true;
  const ir = compileNode(
    root,
    undefined,
    false,
    tokenNames,
    assetMap,
    doc.components,
    {
      collapseInstances,
      codeConnect: doc.figmagraphExport?.codeConnect,
    }
  );
  if (ir && options.maxDepth != null) {
    return trimDepth(ir, options.maxDepth);
  }
  return ir;
}

function trimDepth(node: LayoutNode, maxDepth: number, depth = 0): LayoutNode {
  if (depth >= maxDepth) {
    const { children: _c, ...rest } = node;
    return {
      ...rest,
      children: node.children?.length
        ? node.children.map((c) => ({
            id: c.id,
            name: c.name,
            role: c.role,
            layout: { mode: c.layout.mode },
            visual: {},
          }))
        : undefined,
    };
  }
  return {
    ...node,
    children: node.children?.map((c) => trimDepth(c, maxDepth, depth + 1)),
  };
}

/** Collect all top-level frames / components worth indexing as screens. */
export function collectScreenRoots(doc: FigmaDocument): FigmaNode[] {
  const roots: FigmaNode[] = [];

  if (doc.nodes) {
    for (const entry of Object.values(doc.nodes)) {
      if (entry.document) roots.push(entry.document);
    }
    if (roots.length) return roots;
  }

  const document = doc.document;
  if (!document) return roots;

  const walkPages = (node: FigmaNode) => {
    if (node.type === "CANVAS" || node.type === "PAGE") {
      for (const child of node.children ?? []) {
        if (
          child.type === "FRAME" ||
          child.type === "COMPONENT" ||
          child.type === "COMPONENT_SET" ||
          child.type === "SECTION"
        ) {
          roots.push(child);
        }
      }
      return;
    }
    for (const child of node.children ?? []) walkPages(child);
  };

  if (document.type === "DOCUMENT") {
    for (const page of document.children ?? []) walkPages(page);
  } else {
    roots.push(document);
  }

  return roots;
}
