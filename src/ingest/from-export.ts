import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import AdmZip from "adm-zip";
import type { FigmaDocument, AssetMap } from "../types.js";
import { normalizeDocument, extractAssetMap } from "./normalize.js";

export type LoadedExport = {
  document: FigmaDocument;
  assetMap: AssetMap;
  sourceDir: string;
};

function findDocumentJson(dir: string): string {
  const candidates = [
    join(dir, "document.json"),
    join(dir, "file.json"),
    join(dir, "data.json"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // shallow search
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isFile() && extname(p) === ".json") {
      return p;
    }
    if (statSync(p).isDirectory() && name !== "assets" && name !== ".assets") {
      try {
        return findDocumentJson(p);
      } catch {
        /* continue */
      }
    }
  }
  throw new Error(`No document JSON found under ${dir}`);
}

function findAssetsDir(dir: string): string | null {
  for (const name of ["assets", ".assets", "design.assets"]) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isDirectory()) return p;
  }
  return null;
}

function loadFromDirectory(dir: string): LoadedExport {
  const jsonPath = findDocumentJson(dir);
  const raw = JSON.parse(readFileSync(jsonPath, "utf8"));
  const document = normalizeDocument(raw);
  const assetMap = extractAssetMap(document);

  const assetsDir = findAssetsDir(dir) ?? findAssetsDir(join(dir, basename(jsonPath, ".json")));
  if (assetsDir) {
    // Map files by basename / node-id patterns
    const walk = (d: string, prefix = "") => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) {
          walk(p, `${prefix}${name}/`);
          continue;
        }
        const rel = `${prefix}${name}`;
        const idGuess = name.replace(/\.(png|svg|jpg|jpeg|webp)$/i, "");
        // node ids often encoded as 1-2 or 1_2
        const nodeId = idGuess.replace(/_/g, ":").replace(/-/g, ":");
        if (!assetMap[nodeId]) assetMap[nodeId] = rel;
        if (!assetMap[idGuess]) assetMap[idGuess] = rel;
        // imageRef hashes
        if (idGuess.startsWith("image_")) {
          assetMap[idGuess.replace(/^image_/, "")] = rel;
          assetMap[idGuess] = rel;
        }
      }
    };
    walk(assetsDir);
  }

  return { document, assetMap, sourceDir: dir };
}

export function loadExport(fromPath: string): LoadedExport {
  const resolved = resolve(fromPath);
  if (!existsSync(resolved)) {
    throw new Error(`Path not found: ${resolved}`);
  }

  const st = statSync(resolved);
  if (st.isDirectory()) {
    return loadFromDirectory(resolved);
  }

  if (resolved.endsWith(".json")) {
    const document = normalizeDocument(
      JSON.parse(readFileSync(resolved, "utf8"))
    );
    return {
      document,
      assetMap: extractAssetMap(document),
      sourceDir: resolve(resolved, ".."),
    };
  }

  if (resolved.endsWith(".zip")) {
    const zip = new AdmZip(resolved);
    const tmp = join(tmpdir(), `figmagraph-${randomBytes(6).toString("hex")}`);
    mkdirSync(tmp, { recursive: true });
    zip.extractAllTo(tmp, true);
    // zip may contain a single root folder
    const entries = readdirSync(tmp);
    const root =
      entries.length === 1 && statSync(join(tmp, entries[0]!)).isDirectory()
        ? join(tmp, entries[0]!)
        : tmp;
    const loaded = loadFromDirectory(root);
    return { ...loaded, sourceDir: tmp };
  }

  throw new Error(`Unsupported export path (use .zip, .json, or folder): ${resolved}`);
}

export function materializeExport(
  loaded: LoadedExport,
  rawDir: string,
  assetsDir: string
): { document: FigmaDocument; assetMap: AssetMap } {
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });

  writeFileSync(
    join(rawDir, "document.json"),
    JSON.stringify(loaded.document, null, 2)
  );

  const srcAssets =
    findAssetsDir(loaded.sourceDir) ??
    (existsSync(join(loaded.sourceDir, "assets"))
      ? join(loaded.sourceDir, "assets")
      : null);

  const remapped: AssetMap = { ...loaded.assetMap };

  if (srcAssets) {
    // copy all asset files into index assets/
    const copyWalk = (d: string, prefix = "") => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) {
          copyWalk(p, `${prefix}${name}/`);
          continue;
        }
        const destRel = `${prefix}${name}`;
        const dest = join(assetsDir, destRel);
        mkdirSync(resolve(dest, ".."), { recursive: true });
        cpSync(p, dest);
      }
    };
    copyWalk(srcAssets);
  }

  // Normalize asset map paths to be relative to assets/
  for (const [k, v] of Object.entries(remapped)) {
    remapped[k] = v.replace(/^(assets\/|\.assets\/|design\.assets\/)/, "");
  }

  writeFileSync(join(rawDir, "assets-map.json"), JSON.stringify(remapped, null, 2));

  // Cleanup temp zip extract if under tmpdir
  if (loaded.sourceDir.includes("figmagraph-")) {
    try {
      rmSync(loaded.sourceDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  return { document: loaded.document, assetMap: remapped };
}
