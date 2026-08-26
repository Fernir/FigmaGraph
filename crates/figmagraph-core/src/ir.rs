//! Layout IR compiler — parity with `src/ir/layout-ir.ts` + `tokens.ts`.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub fn role_of(ty: &str) -> &'static str {
    match ty {
        "FRAME" | "COMPONENT_SET" | "SECTION" => "frame",
        "GROUP" => "group",
        "TEXT" => "text",
        "RECTANGLE" | "ELLIPSE" | "LINE" | "POLYGON" | "STAR" | "VECTOR" | "BOOLEAN_OPERATION" => {
            "vector"
        }
        "COMPONENT" => "component",
        "INSTANCE" => "instance",
        _ => "other",
    }
}

pub fn is_auto(n: &Value) -> bool {
    matches!(
        n.get("layoutMode").and_then(|v| v.as_str()),
        Some("HORIZONTAL") | Some("VERTICAL")
    )
}

pub fn build_token_names(styles: Option<&Value>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(obj) = styles.and_then(|s| s.as_object()) else {
        return map;
    };
    for (id, s) in obj {
        if let Some(name) = s.get("name").and_then(|v| v.as_str()) {
            let normalized = name
                .split_whitespace()
                .collect::<Vec<_>>()
                .join("/")
                .to_lowercase();
            map.insert(id.clone(), normalized);
        }
    }
    map
}

/** Merge Figma variables (id → name) into the token map. */
pub fn merge_variable_names(map: &mut HashMap<String, String>, variables: Option<&Value>) {
    let Some(obj) = variables.and_then(|v| v.as_object()) else {
        return;
    };
    for (id, v) in obj {
        if map.contains_key(id) {
            continue;
        }
        if let Some(name) = v.get("name").and_then(|n| n.as_str()) {
            let normalized = name
                .split_whitespace()
                .collect::<Vec<_>>()
                .join("/")
                .to_lowercase();
            map.insert(id.clone(), normalized);
        }
    }
}

fn map_align(v: Option<&str>) -> Option<String> {
    match v {
        Some("MIN") => Some("flex-start".into()),
        Some("CENTER") => Some("center".into()),
        Some("MAX") => Some("flex-end".into()),
        Some("SPACE_BETWEEN") => Some("space-between".into()),
        Some("BASELINE") => Some("baseline".into()),
        Some(other) => Some(other.to_lowercase()),
        None => None,
    }
}

fn rgba_to_hex(c: &Value) -> String {
    let r = (c.get("r").and_then(|v| v.as_f64()).unwrap_or(0.0) * 255.0).round() as u8;
    let g = (c.get("g").and_then(|v| v.as_f64()).unwrap_or(0.0) * 255.0).round() as u8;
    let b = (c.get("b").and_then(|v| v.as_f64()).unwrap_or(0.0) * 255.0).round() as u8;
    let a = c.get("a").and_then(|v| v.as_f64()).unwrap_or(1.0);
    let mut hex = format!("#{r:02x}{g:02x}{b:02x}");
    if a < 1.0 {
        hex.push_str(&format!("{:02x}", (a * 255.0).round() as u8));
    }
    hex
}

fn bound_id(ref_v: &Value) -> Option<&str> {
    if let Some(arr) = ref_v.as_array() {
        arr.first()
            .and_then(|x| x.get("id"))
            .and_then(|v| v.as_str())
    } else {
        ref_v.get("id").and_then(|v| v.as_str())
    }
}

fn bound_token_name(paint: &Value, token_names: &HashMap<String, String>) -> Option<String> {
    let bv = paint.pointer("/boundVariables/color")?;
    let id = bound_id(bv)?;
    token_names.get(id).map(|n| format!("token:{n}"))
}

fn paint_to_ref(
    paint: &Value,
    token_names: &HashMap<String, String>,
    asset_map: &Value,
) -> Option<Value> {
    if paint.get("visible") == Some(&json!(false)) {
        return None;
    }
    let token = bound_token_name(paint, token_names);
    let ty = paint.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if ty == "SOLID" {
        let color = paint.get("color")?;
        let mut m = Map::new();
        m.insert("type".into(), json!("solid"));
        m.insert("color".into(), json!(rgba_to_hex(color)));
        if let Some(op) = paint.get("opacity").and_then(|v| v.as_f64()) {
            m.insert("opacity".into(), json!(op));
        }
        if let Some(t) = token {
            m.insert("token".into(), json!(t));
        }
        return Some(Value::Object(m));
    }
    if ty.starts_with("GRADIENT_") {
        if let Some(stops) = paint.get("gradientStops").and_then(|v| v.as_array()) {
            let stops_css: Vec<String> = stops
                .iter()
                .filter_map(|s| {
                    let c = s.get("color")?;
                    let pos = s.get("position").and_then(|v| v.as_f64()).unwrap_or(0.0);
                    Some(format!("{} {}%", rgba_to_hex(c), (pos * 100.0).round() as i64))
                })
                .collect();
            let kind = match ty {
                "GRADIENT_RADIAL" => "radial-gradient",
                "GRADIENT_ANGULAR" => "conic-gradient",
                _ => "linear-gradient",
            };
            let mut m = Map::new();
            m.insert("type".into(), json!("gradient"));
            m.insert("css".into(), json!(format!("{kind}({})", stops_css.join(", "))));
            if let Some(t) = token {
                m.insert("token".into(), json!(t));
            }
            return Some(Value::Object(m));
        }
    }
    if ty == "IMAGE" {
        let image_ref = paint.get("imageRef").and_then(|v| v.as_str());
        let asset_path = image_ref.and_then(|r| asset_map.get(r).and_then(|v| v.as_str()));
        let mut m = Map::new();
        m.insert("type".into(), json!("image"));
        if let Some(r) = image_ref {
            m.insert("imageRef".into(), json!(r));
        }
        if let Some(p) = asset_path {
            m.insert("assetPath".into(), json!(p));
        }
        return Some(Value::Object(m));
    }
    None
}

fn paints_to_refs(
    paints: Option<&Value>,
    token_names: &HashMap<String, String>,
    asset_map: &Value,
) -> Option<Value> {
    let arr = paints?.as_array()?;
    let refs: Vec<Value> = arr
        .iter()
        .filter_map(|p| paint_to_ref(p, token_names, asset_map))
        .collect();
    if refs.is_empty() {
        None
    } else {
        Some(Value::Array(refs))
    }
}

fn strokes_to_refs(
    strokes: Option<&Value>,
    weight: Option<f64>,
    align: Option<&str>,
    token_names: &HashMap<String, String>,
) -> Option<Value> {
    let weight = weight.filter(|w| *w != 0.0)?;
    let arr = strokes?.as_array()?;
    let mut out = Vec::new();
    for s in arr {
        if s.get("visible") == Some(&json!(false)) {
            continue;
        }
        if s.get("type").and_then(|v| v.as_str()) != Some("SOLID") {
            continue;
        }
        let Some(color) = s.get("color") else { continue };
        let mut m = Map::new();
        m.insert("color".into(), json!(rgba_to_hex(color)));
        m.insert("weight".into(), json!(weight));
        m.insert(
            "align".into(),
            json!(align.unwrap_or("CENTER").to_lowercase()),
        );
        if let Some(bv) = s.pointer("/boundVariables/color") {
            if let Some(id) = bound_id(bv) {
                if let Some(n) = token_names.get(id) {
                    m.insert("token".into(), json!(format!("token:{n}")));
                }
            }
        }
        out.push(Value::Object(m));
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Array(out))
    }
}

fn effects_to_refs(effects: Option<&Value>) -> Option<Value> {
    let arr = effects?.as_array()?;
    let mut out = Vec::new();
    for e in arr {
        if e.get("visible") == Some(&json!(false)) {
            continue;
        }
        let ty = e.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if ty == "DROP_SHADOW" || ty == "INNER_SHADOW" {
            let x = e.pointer("/offset/x").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let y = e.pointer("/offset/y").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let blur = e.get("radius").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let spread = e.get("spread").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let color = e
                .get("color")
                .map(rgba_to_hex)
                .unwrap_or_else(|| "#00000040".into());
            let inset = if ty == "INNER_SHADOW" { "inset " } else { "" };
            out.push(json!({
                "type": "shadow",
                "css": format!("{inset}{x}px {y}px {blur}px {spread}px {color}")
            }));
        } else if ty == "LAYER_BLUR" || ty == "BACKGROUND_BLUR" {
            out.push(json!({
                "type": "blur",
                "radius": e.get("radius").and_then(|v| v.as_f64()).unwrap_or(0.0)
            }));
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Array(out))
    }
}

fn size_from(
    sizing: Option<&str>,
    fixed: Option<f64>,
    axis_sizing_mode: Option<&str>,
    layout_grow: Option<f64>,
    parent_has_auto: bool,
) -> Option<Value> {
    match sizing {
        Some("HUG") => return Some(json!({ "kind": "hug" })),
        Some("FILL") => return Some(json!({ "kind": "fill" })),
        Some("FIXED") if fixed.is_some() => {
            return Some(json!({ "kind": "fixed", "value": fixed.unwrap().round() as i64 }))
        }
        _ => {}
    }
    if parent_has_auto {
        if layout_grow.map(|g| g > 0.0).unwrap_or(false) {
            return Some(json!({ "kind": "fill" }));
        }
        if axis_sizing_mode == Some("AUTO") {
            return Some(json!({ "kind": "hug" }));
        }
    }
    fixed.map(|v| json!({ "kind": "fixed", "value": v.round() as i64 }))
}

fn node_size(node: &Value) -> (Option<f64>, Option<f64>) {
    if let Some(b) = node.get("absoluteBoundingBox") {
        (
            b.get("width").and_then(|v| v.as_f64()),
            b.get("height").and_then(|v| v.as_f64()),
        )
    } else if let Some(s) = node.get("size") {
        (
            s.get("x").and_then(|v| v.as_f64()),
            s.get("y").and_then(|v| v.as_f64()),
        )
    } else {
        (None, None)
    }
}

fn relative_pos(node: &Value, parent: Option<&Value>) -> Option<(i64, i64)> {
    let box_ = node.get("absoluteBoundingBox");
    let pbox = parent.and_then(|p| p.get("absoluteBoundingBox"));
    if let (Some(b), Some(pb)) = (box_, pbox) {
        let x = b.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0)
            - pb.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let y = b.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0)
            - pb.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        return Some((x.round() as i64, y.round() as i64));
    }
    if let Some(t) = node.get("relativeTransform").and_then(|v| v.as_array()) {
        let x = t.first().and_then(|r| r.get(2)).and_then(|v| v.as_f64());
        let y = t.get(1).and_then(|r| r.get(2)).and_then(|v| v.as_f64());
        if let (Some(x), Some(y)) = (x, y) {
            return Some((x.round() as i64, y.round() as i64));
        }
    }
    None
}

fn text_style_from(style: Option<&Value>, fill_color: Option<&str>) -> Value {
    let mut m = Map::new();
    if let Some(s) = style {
        if let Some(v) = s.get("fontFamily") {
            m.insert("fontFamily".into(), v.clone());
        }
        if let Some(v) = s.get("fontSize") {
            m.insert("fontSize".into(), v.clone());
        }
        if let Some(v) = s.get("fontWeight") {
            m.insert("fontWeight".into(), v.clone());
        }
        if let Some(v) = s.get("lineHeightPx") {
            m.insert("lineHeight".into(), v.clone());
        }
        if let Some(v) = s.get("letterSpacing") {
            m.insert("letterSpacing".into(), v.clone());
        }
        if let Some(v) = s.get("textAlignHorizontal").and_then(|v| v.as_str()) {
            m.insert("textAlign".into(), json!(v.to_lowercase()));
        }
    }
    if let Some(c) = fill_color {
        m.insert("color".into(), json!(c));
    }
    Value::Object(m)
}

fn bound_tokens_from_node(
    node: &Value,
    token_names: &HashMap<String, String>,
) -> Option<Value> {
    let bv = node.get("boundVariables")?.as_object()?;
    let mut out = Map::new();
    for (prop, ref_v) in bv {
        if let Some(id) = bound_id(ref_v) {
            if let Some(name) = token_names.get(id) {
                out.insert(prop.clone(), json!(format!("token:{name}")));
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

fn variant_props_from_component_properties(props: Option<&Value>) -> Option<Value> {
    let obj = props?.as_object()?;
    let mut out = Map::new();
    for (k, v) in obj {
        if let Some(rec) = v.as_object() {
            if rec.get("type").and_then(|t| t.as_str()) == Some("VARIANT") {
                if let Some(val) = rec.get("value") {
                    out.insert(k.clone(), json!(val.as_str().map(|s| s.to_string()).unwrap_or_else(|| val.to_string())));
                }
            }
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
}

fn text_segments(node: &Value, fill_color: Option<&str>) -> Option<Value> {
    let chars = node.get("characters").and_then(|v| v.as_str()).unwrap_or("");
    let overrides = node.get("characterStyleOverrides")?.as_array()?;
    let table = node.get("styleOverrideTable")?.as_object()?;
    if overrides.is_empty() || chars.is_empty() {
        return None;
    }
    let chars_vec: Vec<char> = chars.chars().collect();
    let mut segments = Vec::new();
    let mut i = 0usize;
    while i < chars_vec.len() {
        let style_id = overrides
            .get(i)
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let mut j = i + 1;
        while j < chars_vec.len()
            && overrides
                .get(j)
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                == style_id
        {
            j += 1;
        }
        let override_style = if style_id != 0 {
            table.get(&style_id.to_string())
        } else {
            None
        };
        let base = text_style_from(node.get("style"), fill_color);
        let over = text_style_from(override_style, fill_color);
        let mut merged = base.as_object().cloned().unwrap_or_default();
        if let Some(om) = over.as_object() {
            for (k, v) in om {
                if !v.is_null() {
                    merged.insert(k.clone(), v.clone());
                }
            }
        }
        segments.push(json!({
            "characters": chars_vec[i..j].iter().collect::<String>(),
            "style": Value::Object(merged),
        }));
        i = j;
    }
    if segments.len() > 1 {
        Some(Value::Array(segments))
    } else {
        None
    }
}

fn asset_for_node(id: &str, asset_map: &Value) -> Option<(String, String)> {
    let path = asset_map
        .get(id)
        .and_then(|v| v.as_str())
        .or_else(|| {
            if id.contains(';') {
                None
            } else {
                let dashed = id.replace(':', "-");
                asset_map.get(&dashed).and_then(|v| v.as_str())
            }
        })?;
    let kind = if path.ends_with(".svg") {
        "svg"
    } else if path.contains("image_") {
        "imageFill"
    } else {
        "png"
    };
    Some((kind.into(), path.into()))
}

/// Compile a Figma node tree into Layout IR (borrowed walk — no subtree clones).
#[allow(clippy::too_many_arguments)]
pub fn compile_layout_ir(
    node: &Value,
    parent: Option<&Value>,
    parent_is_flex: bool,
    token_names: &HashMap<String, String>,
    asset_map: &Value,
    components: Option<&Value>,
    collapse_instances: bool,
    max_depth: Option<i32>,
) -> Option<Value> {
    compile_depth(
        node,
        parent,
        parent_is_flex,
        token_names,
        asset_map,
        components,
        collapse_instances,
        max_depth,
        0,
    )
}

#[allow(clippy::too_many_arguments)]
fn compile_depth(
    node: &Value,
    parent: Option<&Value>,
    parent_is_flex: bool,
    token_names: &HashMap<String, String>,
    asset_map: &Value,
    components: Option<&Value>,
    collapse_instances: bool,
    max_depth: Option<i32>,
    depth: i32,
) -> Option<Value> {
    if node.get("visible") == Some(&json!(false)) {
        return None;
    }
    let id = node.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let ty = node.get("type").and_then(|v| v.as_str()).unwrap_or("UNKNOWN");
    let auto = is_auto(node);
    let (w, h) = node_size(node);
    let parent_auto = parent.map(is_auto).unwrap_or(false);

    let width = size_from(
        node.get("layoutSizingHorizontal").and_then(|v| v.as_str()),
        w,
        if node.get("layoutMode").and_then(|v| v.as_str()) == Some("HORIZONTAL") {
            node.get("primaryAxisSizingMode").and_then(|v| v.as_str())
        } else {
            node.get("counterAxisSizingMode").and_then(|v| v.as_str())
        },
        node.get("layoutGrow").and_then(|v| v.as_f64()),
        parent_auto,
    );
    let height = size_from(
        node.get("layoutSizingVertical").and_then(|v| v.as_str()),
        h,
        if node.get("layoutMode").and_then(|v| v.as_str()) == Some("VERTICAL") {
            node.get("primaryAxisSizingMode").and_then(|v| v.as_str())
        } else {
            node.get("counterAxisSizingMode").and_then(|v| v.as_str())
        },
        node.get("layoutGrow").and_then(|v| v.as_f64()),
        parent_auto,
    );

    let fills = paints_to_refs(node.get("fills"), token_names, asset_map);
    let strokes = strokes_to_refs(
        node.get("strokes"),
        node.get("strokeWeight").and_then(|v| v.as_f64()),
        node.get("strokeAlign").and_then(|v| v.as_str()),
        token_names,
    );
    let effects = effects_to_refs(node.get("effects"));

    let radius = if let Some(radii) = node.get("rectangleCornerRadii").and_then(|v| v.as_array()) {
        if radii.len() == 4 {
            Some(json!([
                radii[0].as_f64().unwrap_or(0.0).round() as i64,
                radii[1].as_f64().unwrap_or(0.0).round() as i64,
                radii[2].as_f64().unwrap_or(0.0).round() as i64,
                radii[3].as_f64().unwrap_or(0.0).round() as i64,
            ]))
        } else {
            None
        }
    } else if let Some(r) = node.get("cornerRadius").and_then(|v| v.as_f64()) {
        if r > 0.0 {
            Some(json!(r.round() as i64))
        } else {
            None
        }
    } else {
        None
    };

    let mut layout = Map::new();
    layout.insert("mode".into(), json!(if auto { "flex" } else { "none" }));
    if let Some(s) = width {
        layout.insert("width".into(), s);
    }
    if let Some(s) = height {
        layout.insert("height".into(), s);
    }

    if auto {
        layout.insert(
            "direction".into(),
            json!(
                if node.get("layoutMode").and_then(|v| v.as_str()) == Some("HORIZONTAL") {
                    "row"
                } else {
                    "column"
                }
            ),
        );
        if let Some(gap) = node.get("itemSpacing").and_then(|v| v.as_f64()) {
            if gap != 0.0 {
                layout.insert("gap".into(), json!(gap));
            }
        }
        let pt = node.get("paddingTop").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let pr = node.get("paddingRight").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let pb = node.get("paddingBottom").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let pl = node.get("paddingLeft").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if pt != 0.0 || pr != 0.0 || pb != 0.0 || pl != 0.0 {
            layout.insert("padding".into(), json!([pt, pr, pb, pl]));
        }
        if let Some(a) = map_align(node.get("primaryAxisAlignItems").and_then(|v| v.as_str())) {
            layout.insert("justify".into(), json!(a));
        }
        if let Some(a) = map_align(node.get("counterAxisAlignItems").and_then(|v| v.as_str())) {
            layout.insert("align".into(), json!(a));
        }
        if node.get("layoutWrap").and_then(|v| v.as_str()) == Some("WRAP") {
            layout.insert("wrap".into(), json!(true));
        }
    }

    if let Some(v) = node.get("minWidth").and_then(|v| v.as_f64()) {
        layout.insert("minWidth".into(), json!(v.round() as i64));
    }
    if let Some(v) = node.get("maxWidth").and_then(|v| v.as_f64()) {
        layout.insert("maxWidth".into(), json!(v.round() as i64));
    }
    if let Some(v) = node.get("minHeight").and_then(|v| v.as_f64()) {
        layout.insert("minHeight".into(), json!(v.round() as i64));
    }
    if let Some(v) = node.get("maxHeight").and_then(|v| v.as_f64()) {
        layout.insert("maxHeight".into(), json!(v.round() as i64));
    }
    if node.get("clipsContent") == Some(&json!(true)) {
        layout.insert("clipsContent".into(), json!(true));
    }
    if let Some(r) = node.get("rotation").and_then(|v| v.as_f64()) {
        if r != 0.0 {
            layout.insert("rotation".into(), json!(r));
        }
    }

    let layout_positioning = node.get("layoutPositioning").and_then(|v| v.as_str());
    let absolute_child = layout_positioning == Some("ABSOLUTE") || !parent_is_flex;
    if absolute_child {
        if let Some((x, y)) = relative_pos(node, parent) {
            layout.insert("absolute".into(), json!({ "x": x, "y": y }));
        } else {
            layout.insert("absolute".into(), Value::Null);
        }
        if layout_positioning == Some("ABSOLUTE") {
            layout.insert("positioning".into(), json!("absolute"));
        }
    } else {
        layout.insert("absolute".into(), Value::Null);
        layout.insert("positioning".into(), json!("auto"));
    }

    let mut visual = Map::new();
    if let Some(f) = fills {
        visual.insert("fills".into(), f);
    }
    if let Some(s) = strokes {
        visual.insert("strokes".into(), s);
    }
    if let Some(r) = radius {
        visual.insert("radius".into(), r);
    }
    if let Some(op) = node.get("opacity").and_then(|v| v.as_f64()) {
        if op < 1.0 {
            visual.insert("opacity".into(), json!(op));
        }
    }
    if let Some(e) = effects {
        visual.insert("effects".into(), e);
    }

    let mut ir = json!({
        "id": id,
        "name": name,
        "role": role_of(ty),
        "layout": layout,
        "visual": visual,
    });

    if let Some(tokens) = bound_tokens_from_node(node, token_names) {
        ir["tokens"] = tokens;
    }

    if let Some((kind, path)) = asset_for_node(id, asset_map) {
        ir["asset"] = json!({ "kind": kind, "path": path });
    }

    if ty == "TEXT" {
        let fill_color = node
            .get("fills")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|f| {
                if f.get("type").and_then(|v| v.as_str()) == Some("SOLID") {
                    f.get("color").map(rgba_to_hex)
                } else {
                    None
                }
            });
        let fill_ref = fill_color.as_deref();
        let mut text = Map::new();
        text.insert(
            "characters".into(),
            json!(node.get("characters").and_then(|v| v.as_str()).unwrap_or("")),
        );
        text.insert(
            "style".into(),
            text_style_from(node.get("style"), fill_ref),
        );
        if let Some(segs) = text_segments(node, fill_ref) {
            text.insert("segments".into(), segs);
        }
        ir["text"] = Value::Object(text);
    }

    if ty == "INSTANCE" || ty == "COMPONENT" {
        let main_id = node.get("componentId").and_then(|v| v.as_str());
        let comp_meta = main_id.and_then(|mid| components.and_then(|c| c.get(mid)));
        let variant = node
            .get("variantProperties")
            .cloned()
            .or_else(|| variant_props_from_component_properties(node.get("componentProperties")));
        let mut comp = Map::new();
        if let Some(key) = comp_meta.and_then(|m| m.get("key")) {
            comp.insert("key".into(), key.clone());
        }
        if let Some(mid) = main_id {
            comp.insert("mainComponentId".into(), json!(mid));
        }
        if let Some(overrides) = node.get("componentProperties") {
            comp.insert("overrides".into(), overrides.clone());
        }
        if let Some(v) = variant {
            comp.insert("variantProperties".into(), v);
        }
        if let Some(desc) = comp_meta
            .and_then(|m| m.get("description"))
            .and_then(|v| v.as_str())
        {
            if desc.len() < 200 && (desc.contains('/') || desc.contains('.')) {
                comp.insert("codeConnect".into(), json!(desc.trim()));
            }
        }
        ir["component"] = Value::Object(comp);

        if collapse_instances && ty == "INSTANCE" && main_id.is_some() {
            return Some(ir);
        }
    }

    let at_limit = max_depth.map(|m| depth >= m).unwrap_or(false);
    if at_limit {
        if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
            if !children.is_empty() {
                let stubs: Vec<Value> = children
                    .iter()
                    .filter(|c| c.get("visible") != Some(&json!(false)))
                    .map(|c| {
                        let cid = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let cname = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let cty = c.get("type").and_then(|v| v.as_str()).unwrap_or("UNKNOWN");
                        json!({
                            "id": cid,
                            "name": cname,
                            "role": role_of(cty),
                            "layout": { "mode": if is_auto(c) { "flex" } else { "none" } },
                            "visual": {}
                        })
                    })
                    .collect();
                if !stubs.is_empty() {
                    ir["children"] = Value::Array(stubs);
                }
            }
        }
        return Some(ir);
    }

    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
        let mut kids = Vec::new();
        for child in children {
            if let Some(c) = compile_depth(
                child,
                Some(node),
                auto,
                token_names,
                asset_map,
                components,
                collapse_instances,
                max_depth,
                depth + 1,
            ) {
                kids.push(c);
            }
        }
        if !kids.is_empty() {
            ir["children"] = Value::Array(kids);
        }
    }

    Some(ir)
}

pub fn collect_screen_roots(document: &Value, roots: &mut Vec<String>) {
    let ty = document.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if ty == "DOCUMENT" {
        if let Some(pages) = document.get("children").and_then(|c| c.as_array()) {
            for page in pages {
                collect_page_frames(page, roots);
            }
        }
    } else if let Some(id) = document.get("id").and_then(|v| v.as_str()) {
        roots.push(id.to_string());
    }
}

fn collect_page_frames(page: &Value, roots: &mut Vec<String>) {
    let ty = page.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if ty == "CANVAS" || ty == "PAGE" {
        if let Some(children) = page.get("children").and_then(|c| c.as_array()) {
            for child in children {
                let ct = child.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if matches!(ct, "FRAME" | "COMPONENT" | "COMPONENT_SET" | "SECTION") {
                    if let Some(id) = child.get("id").and_then(|v| v.as_str()) {
                        roots.push(id.to_string());
                    }
                }
            }
        }
        return;
    }
    if let Some(children) = page.get("children").and_then(|c| c.as_array()) {
        for child in children {
            collect_page_frames(child, roots);
        }
    }
}

/// Find a node by id in a document tree (borrowed).
pub fn find_node<'a>(node: &'a Value, id: &str) -> Option<&'a Value> {
    if node.get("id").and_then(|v| v.as_str()) == Some(id) {
        return Some(node);
    }
    if let Some(children) = node.get("children").and_then(|c| c.as_array()) {
        for child in children {
            if let Some(found) = find_node(child, id) {
                return Some(found);
            }
        }
    }
    None
}
