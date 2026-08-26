/** Shared types for figmagraph Layout IR and Figma document shapes. */

export type Size =
  | { kind: "hug" }
  | { kind: "fill" }
  | { kind: "fixed"; value: number };

export type PaintRef =
  | { type: "solid"; color: string; opacity?: number; token?: string }
  | { type: "gradient"; css: string; token?: string }
  | { type: "image"; imageRef?: string; assetPath?: string }
  | { type: "none" };

export type StrokeRef = {
  color: string;
  weight: number;
  align?: "inside" | "outside" | "center";
  token?: string;
};

export type EffectRef =
  | { type: "shadow"; css: string }
  | { type: "blur"; radius: number };

export type TextStyleRef = {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  lineHeight?: number | string;
  letterSpacing?: number | string;
  textAlign?: string;
  color?: string;
  token?: string;
};

export type TextSegment = {
  characters: string;
  style: TextStyleRef;
};

export type LayoutNodeRole =
  | "frame"
  | "text"
  | "vector"
  | "image"
  | "component"
  | "instance"
  | "group"
  | "other";

export type LayoutNode = {
  id: string;
  name: string;
  role: LayoutNodeRole;
  layout: {
    mode: "flex" | "none";
    direction?: "row" | "column";
    gap?: number;
    padding?: [number, number, number, number];
    align?: string;
    justify?: string;
    wrap?: boolean;
    width?: Size;
    height?: Size;
    minWidth?: number;
    maxWidth?: number;
    minHeight?: number;
    maxHeight?: number;
    /** Set when parent is not flex, or child uses layoutPositioning=ABSOLUTE inside flex. */
    absolute?: { x: number; y: number } | null;
    positioning?: "auto" | "absolute";
    clipsContent?: boolean;
    rotation?: number;
  };
  visual: {
    fills?: PaintRef[];
    strokes?: StrokeRef[];
    radius?: number | [number, number, number, number];
    opacity?: number;
    effects?: EffectRef[];
  };
  text?: {
    characters: string;
    style: TextStyleRef;
    /** Mixed styles when present in the dump. */
    segments?: TextSegment[];
  };
  component?: {
    key?: string;
    mainComponentId?: string;
    overrides?: Record<string, unknown>;
    variantProperties?: Record<string, string>;
    /** Optional Code Connect / repo component hint */
    codeConnect?: string;
  };
  tokens?: Record<string, string>;
  children?: LayoutNode[];
  asset?: { kind: "png" | "svg" | "imageFill"; path: string };
};

export type IndexMeta = {
  name: string;
  fileKey?: string;
  fileName?: string;
  version?: string;
  source: "plugin" | "rest";
  indexedAt: string;
  nodeCount: number;
  rootNodeIds: string[];
  indexPath: string;
  /** sha256 of raw/document.json — skip rebuild when unchanged */
  documentHash?: string;
  /** Variable collection modes when present (e.g. light/dark) */
  variableModes?: Array<{ collection: string; modes: string[] }>;
};

export type FigmaColor = {
  r: number;
  g: number;
  b: number;
  a?: number;
};

export type FigmaPaint = {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
  gradientStops?: Array<{ position: number; color: FigmaColor }>;
  gradientHandlePositions?: Array<{ x: number; y: number }>;
  imageRef?: string;
  scaleMode?: string;
  boundVariables?: Record<string, { id: string } | Array<{ id: string }>>;
};

export type FigmaNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  size?: { x: number; y: number };
  relativeTransform?: number[][];
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  primaryAxisSizingMode?: "FIXED" | "AUTO";
  counterAxisSizingMode?: "FIXED" | "AUTO";
  layoutWrap?: "NO_WRAP" | "WRAP";
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  layoutGrow?: number;
  layoutAlign?: string;
  layoutSizingHorizontal?: "FIXED" | "HUG" | "FILL";
  layoutSizingVertical?: "FIXED" | "HUG" | "FILL";
  layoutPositioning?: "AUTO" | "ABSOLUTE";
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  clipsContent?: boolean;
  rotation?: number;
  constraints?: { horizontal: string; vertical: string };
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  effects?: Array<{
    type: string;
    visible?: boolean;
    radius?: number;
    color?: FigmaColor;
    offset?: { x: number; y: number };
    spread?: number;
  }>;
  characters?: string;
  style?: {
    fontFamily?: string;
    fontPostScriptName?: string;
    fontWeight?: number;
    fontSize?: number;
    lineHeightPx?: number;
    lineHeightPercent?: number;
    letterSpacing?: number;
    textAlignHorizontal?: string;
    textAlignVertical?: string;
  };
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, FigmaNode["style"]>;
  componentId?: string;
  componentProperties?: Record<string, unknown>;
  variantProperties?: Record<string, string>;
  overrides?: unknown[];
  exportSettings?: unknown[];
  boundVariables?: Record<string, { id: string } | Array<{ id: string }>>;
};

export type FigmaDocument = {
  name?: string;
  lastModified?: string;
  version?: string;
  document?: FigmaNode;
  components?: Record<string, { key?: string; name?: string; description?: string }>;
  componentSets?: Record<string, { key?: string; name?: string }>;
  styles?: Record<string, { key?: string; name?: string; styleType?: string }>;
  nodes?: Record<string, { document: FigmaNode }>;
  figmagraphExport?: {
    fileKey?: string;
    fileName?: string;
    exportedAt?: string;
    assets?: Record<string, string>;
    fidelity?: string;
    /** Optional map componentId → import path / Code Connect string */
    codeConnect?: Record<string, string>;
  };
  variables?: Record<
    string,
    {
      name?: string;
      resolvedType?: string;
      variableCollectionId?: string;
      valuesByMode?: Record<string, unknown>;
    }
  >;
  variableCollections?: Record<string, unknown>;
};

export type AssetMap = Record<string, string>;
