// FigmaGraph Desktop plugin — full local dump (raw) + PNG/SVG assets.
// Import: Figma → Plugins → Development → Import plugin from manifest…

function rgba(c) {
  if (!c) return undefined;
  return { r: c.r, g: c.g, b: c.b, a: "a" in c ? c.a : 1 };
}

function serializePaint(p) {
  if (!p || p.visible === false) return null;
  const out = {
    type: p.type,
    visible: p.visible !== false,
    opacity: p.opacity,
  };
  if ("color" in p && p.color) out.color = rgba(p.color);
  if ("imageHash" in p && p.imageHash) out.imageRef = p.imageHash;
  if ("scaleMode" in p) out.scaleMode = p.scaleMode;
  if ("gradientStops" in p && p.gradientStops) {
    out.gradientStops = p.gradientStops.map((s) => ({
      position: s.position,
      color: rgba(s.color),
    }));
  }
  if ("gradientTransform" in p && p.gradientTransform) {
    out.gradientHandlePositions = undefined;
    out.gradientTransform = p.gradientTransform;
  }
  if ("boundVariables" in p && p.boundVariables) {
    out.boundVariables = serializeBoundVars(p.boundVariables);
  }
  return out;
}

function serializeBoundVars(bv) {
  if (!bv || typeof bv !== "object") return undefined;
  const out = {};
  for (const [k, v] of Object.entries(bv)) {
    if (!v) continue;
    if (Array.isArray(v)) {
      out[k] = v.map((x) => (x && x.id ? { id: x.id } : x)).filter(Boolean);
    } else if (v.id) {
      out[k] = { id: v.id };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function letterSpacingValue(ls) {
  if (ls == null) return undefined;
  if (typeof ls === "object") return ls.value;
  return ls;
}

function serializeTextStyle(s) {
  if (!s) return undefined;
  return {
    fontFamily: s.fontFamily,
    fontPostScriptName: s.fontPostScriptName,
    fontWeight: s.fontWeight,
    fontSize: s.fontSize,
    lineHeightPx: s.lineHeightPx,
    lineHeightPercent: s.lineHeightPercent,
    lineHeightUnit: s.lineHeightUnit,
    letterSpacing: letterSpacingValue(s.letterSpacing),
    textAlignHorizontal: s.textAlignHorizontal,
    textAlignVertical: s.textAlignVertical,
    textCase: s.textCase,
    textDecoration: s.textDecoration,
  };
}

function serializeNode(node, depth, maxDepth) {
  const base = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible !== false,
  };

  if ("opacity" in node) base.opacity = node.opacity;
  if ("blendMode" in node) base.blendMode = node.blendMode;
  if ("isMask" in node) base.isMask = node.isMask;
  if ("clipsContent" in node) base.clipsContent = node.clipsContent;
  if ("rotation" in node && node.rotation) base.rotation = node.rotation;

  if ("absoluteBoundingBox" in node && node.absoluteBoundingBox) {
    const b = node.absoluteBoundingBox;
    base.absoluteBoundingBox = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    };
  }
  if ("absoluteRenderBounds" in node && node.absoluteRenderBounds) {
    const b = node.absoluteRenderBounds;
    base.absoluteRenderBounds = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
    };
  }
  if ("relativeTransform" in node && node.relativeTransform) {
    base.relativeTransform = node.relativeTransform;
  }
  if ("constraints" in node && node.constraints) {
    base.constraints = {
      horizontal: node.constraints.horizontal,
      vertical: node.constraints.vertical,
    };
  }

  // Auto Layout + absolute children inside flex
  if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
    base.layoutMode = node.layoutMode;
    base.primaryAxisAlignItems = node.primaryAxisAlignItems;
    base.counterAxisAlignItems = node.counterAxisAlignItems;
    base.primaryAxisSizingMode = node.primaryAxisSizingMode;
    base.counterAxisSizingMode = node.counterAxisSizingMode;
    base.layoutWrap = node.layoutWrap;
    base.itemSpacing = node.itemSpacing;
    base.counterAxisSpacing = node.counterAxisSpacing;
    base.paddingTop = node.paddingTop;
    base.paddingRight = node.paddingRight;
    base.paddingBottom = node.paddingBottom;
    base.paddingLeft = node.paddingLeft;
    base.layoutSizingHorizontal = node.layoutSizingHorizontal;
    base.layoutSizingVertical = node.layoutSizingVertical;
    base.layoutGrow = node.layoutGrow;
    base.layoutAlign = node.layoutAlign;
  }
  if ("layoutPositioning" in node) {
    base.layoutPositioning = node.layoutPositioning;
  }
  if ("minWidth" in node && node.minWidth != null) base.minWidth = node.minWidth;
  if ("maxWidth" in node && node.maxWidth != null) base.maxWidth = node.maxWidth;
  if ("minHeight" in node && node.minHeight != null) base.minHeight = node.minHeight;
  if ("maxHeight" in node && node.maxHeight != null) base.maxHeight = node.maxHeight;

  if ("fills" in node && Array.isArray(node.fills)) {
    base.fills = node.fills.map(serializePaint).filter(Boolean);
  }
  if ("strokes" in node && Array.isArray(node.strokes)) {
    base.strokes = node.strokes.map(serializePaint).filter(Boolean);
    base.strokeWeight = node.strokeWeight;
    base.strokeAlign = node.strokeAlign;
    if ("strokeTopWeight" in node) {
      base.individualStrokeWeights = {
        top: node.strokeTopWeight,
        right: node.strokeRightWeight,
        bottom: node.strokeBottomWeight,
        left: node.strokeLeftWeight,
      };
    }
  }
  if ("cornerRadius" in node && typeof node.cornerRadius === "number") {
    base.cornerRadius = node.cornerRadius;
  }
  if ("rectangleCornerRadii" in node && node.rectangleCornerRadii) {
    base.rectangleCornerRadii = [...node.rectangleCornerRadii];
  } else if (
    "topLeftRadius" in node &&
    (node.topLeftRadius ||
      node.topRightRadius ||
      node.bottomRightRadius ||
      node.bottomLeftRadius)
  ) {
    base.rectangleCornerRadii = [
      node.topLeftRadius || 0,
      node.topRightRadius || 0,
      node.bottomRightRadius || 0,
      node.bottomLeftRadius || 0,
    ];
  }

  if ("effects" in node && Array.isArray(node.effects)) {
    base.effects = node.effects
      .filter((e) => e.visible !== false)
      .map((e) => ({
        type: e.type,
        radius: e.radius,
        color: rgba(e.color),
        offset: e.offset ? { x: e.offset.x, y: e.offset.y } : undefined,
        spread: e.spread,
      }));
  }

  if ("boundVariables" in node && node.boundVariables) {
    base.boundVariables = serializeBoundVars(node.boundVariables);
  }

  if (node.type === "TEXT") {
    base.characters = node.characters;
    base.style = serializeTextStyle(node.style);
    try {
      if (node.characterStyleOverrides && node.characterStyleOverrides.length) {
        base.characterStyleOverrides = [...node.characterStyleOverrides];
      }
      if (node.styleOverrideTable) {
        const table = {};
        for (const [k, v] of Object.entries(node.styleOverrideTable)) {
          table[k] = serializeTextStyle(v);
        }
        base.styleOverrideTable = table;
      }
    } catch (_) {}
  }

  if (node.type === "INSTANCE") {
    try {
      if (node.mainComponent) base.componentId = node.mainComponent.id;
    } catch (_) {}
    try {
      if (node.componentProperties) {
        const props = {};
        for (const [k, v] of Object.entries(node.componentProperties)) {
          props[k] = {
            type: v.type,
            value: v.value,
            preferredValues: v.preferredValues,
          };
        }
        base.componentProperties = props;
      }
    } catch (_) {}
    try {
      if (node.variantProperties) base.variantProperties = { ...node.variantProperties };
    } catch (_) {}
  }

  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    base.componentId = node.id;
    try {
      if (node.componentPropertyDefinitions) {
        const defs = {};
        for (const [k, v] of Object.entries(node.componentPropertyDefinitions)) {
          defs[k] = {
            type: v.type,
            defaultValue: v.defaultValue,
            variantOptions: v.variantOptions,
          };
        }
        base.componentPropertyDefinitions = defs;
      }
    } catch (_) {}
  }

  if ("children" in node && node.children && depth < maxDepth) {
    base.children = node.children.map((c) =>
      serializeNode(c, depth + 1, maxDepth)
    );
  }

  return base;
}

async function exportPng(node, scale) {
  if (!("exportAsync" in node)) return null;
  try {
    return await node.exportAsync({
      format: "PNG",
      constraint: { type: "SCALE", value: scale || 2 },
    });
  } catch (_) {
    return null;
  }
}

async function exportSvg(node) {
  if (!("exportAsync" in node)) return null;
  try {
    return await node.exportAsync({ format: "SVG" });
  } catch (_) {
    return null;
  }
}

function isVectorish(type) {
  return (
    type === "VECTOR" ||
    type === "BOOLEAN_OPERATION" ||
    type === "STAR" ||
    type === "POLYGON" ||
    type === "LINE" ||
    type === "ELLIPSE"
  );
}

function nodeSize(node) {
  const b = node.absoluteBoundingBox;
  if (!b) return { w: 0, h: 0 };
  return { w: b.width || 0, h: b.height || 0 };
}

async function collectVariables() {
  const variables = {};
  const collections = {};
  try {
    if (!figma.variables) return { variables, collections };
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    for (const c of cols) {
      collections[c.id] = {
        name: c.name,
        modes: c.modes.map((m) => ({ modeId: m.modeId, name: m.name })),
        defaultModeId: c.defaultModeId,
        variableIds: c.variableIds,
      };
    }
    const vars = await figma.variables.getLocalVariablesAsync();
    for (const v of vars) {
      const valuesByMode = {};
      for (const [modeId, val] of Object.entries(v.valuesByMode || {})) {
        if (val && typeof val === "object" && "r" in val) {
          valuesByMode[modeId] = rgba(val);
        } else if (val && typeof val === "object" && "type" in val && val.type === "VARIABLE_ALIAS") {
          valuesByMode[modeId] = { alias: val.id };
        } else {
          valuesByMode[modeId] = val;
        }
      }
      variables[v.id] = {
        name: v.name,
        resolvedType: v.resolvedType,
        variableCollectionId: v.variableCollectionId,
        valuesByMode,
      };
    }
  } catch (_) {}
  return { variables, collections };
}

async function walkExportAssets(root, opts, assets, assetFiles, depth) {
  const idFile = root.id.replace(/:/g, "-");
  const { w, h } = nodeSize(root);
  const frameLike =
    root.type === "FRAME" ||
    root.type === "COMPONENT" ||
    root.type === "INSTANCE" ||
    root.type === "GROUP" ||
    root.type === "SECTION";

  if (opts.withImages && frameLike && depth <= 1) {
    const bytes = await exportPng(root, 2);
    if (bytes) {
      const filename = `${idFile}@2x.png`;
      assets[root.id] = filename;
      assetFiles.push({ name: filename, bytes: Array.from(bytes) });
    }
  }

  if (opts.withSvg && isVectorish(root.type) && w <= 256 && h <= 256) {
    const bytes = await exportSvg(root);
    if (bytes) {
      const filename = `${idFile}.svg`;
      assets[root.id] = filename;
      assetFiles.push({ name: filename, bytes: Array.from(bytes) });
    }
  }

  if ("children" in root && root.children && depth < 2) {
    for (const child of root.children) {
      await walkExportAssets(child, opts, assets, assetFiles, depth + 1);
    }
  }
}

figma.showUI(__html__, { width: 380, height: 520 });

figma.ui.onmessage = async (msg) => {
  if (msg.type === "cancel") {
    figma.closePlugin();
    return;
  }

  if (msg.type === "export" || msg.type === "push") {
    const scope = msg.scope || "selection";
    const withImages = msg.withImages !== false;
    const withSvg = msg.withSvg !== false;
    const maxDepth = typeof msg.maxDepth === "number" ? msg.maxDepth : 60;
    const push = msg.type === "push";
    const endpoint =
      msg.endpoint || "http://127.0.0.1:9473/ingest";

    let roots = [];
    if (scope === "selection") {
      roots = figma.currentPage.selection.slice();
      if (!roots.length) {
        figma.ui.postMessage({
          type: "error",
          message: "Nothing selected. Select frames or switch to Current page.",
        });
        return;
      }
    } else {
      roots = figma.currentPage.children.slice();
    }

    const nodes = {};
    const assets = {};
    const assetFiles = [];

    figma.ui.postMessage({
      type: "progress",
      message: `Serializing ${roots.length} root(s)…`,
    });

    for (const root of roots) {
      nodes[root.id] = { document: serializeNode(root, 0, maxDepth) };
      figma.ui.postMessage({
        type: "progress",
        message: `Assets: ${root.name}`,
      });
      await walkExportAssets(
        root,
        { withImages, withSvg },
        assets,
        assetFiles,
        0
      );
    }

    figma.ui.postMessage({ type: "progress", message: "Variables…" });
    const { variables, collections } = await collectVariables();

    const styles = {};
    try {
      for (const s of figma.getLocalPaintStyles()) {
        styles[s.id] = { key: s.key, name: s.name, styleType: "FILL" };
      }
      for (const s of figma.getLocalTextStyles()) {
        styles[s.id] = { key: s.key, name: s.name, styleType: "TEXT" };
      }
      for (const s of figma.getLocalEffectStyles()) {
        styles[s.id] = { key: s.key, name: s.name, styleType: "EFFECT" };
      }
    } catch (_) {}

    const payload = {
      name: figma.root.name,
      lastModified: new Date().toISOString(),
      version: "plugin-export-v2",
      nodes,
      styles,
      variables,
      variableCollections: collections,
      figmagraphExport: {
        fileKey: figma.fileKey || undefined,
        fileName: figma.root.name,
        exportedAt: new Date().toISOString(),
        assets,
        fidelity: "full-plugin",
      },
    };

    const documentJson = JSON.stringify(payload, null, 2);
    const fileName = `${(figma.root.name || "figma").replace(/[^\w.-]+/g, "_")}.figmagraph.zip`;

    if (push) {
      figma.ui.postMessage({
        type: "push",
        endpoint,
        documentJson,
        assets: assetFiles,
        fileName,
        replace: msg.replace === true,
        suggestedName: (figma.root.name || "figma")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48),
      });
    } else {
      figma.ui.postMessage({
        type: "download",
        fileName,
        documentJson,
        assets: assetFiles,
      });
    }
  }
};
