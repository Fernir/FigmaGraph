# Publishing figmagraph

## Checklist

1. Bump version in `package.json` **and** `crates/figmagraph-core/Cargo.toml` (keep in sync).
2. `npm test` + `npm run build` locally.
3. Commit & push, then tag: `git tag v0.1.4 && git push origin v0.1.4`
4. Wait for **Native binaries** workflow (`.github/workflows/native.yml`) to upload
   `figmagraph-core-<platform>.tar.gz` / `.zip` to the GitHub Release.
5. `npm publish` (runs `prepublishOnly` → build + test).
   - Postinstall on other machines downloads the matching native asset from that release.
6. `postpublish` bumps patch for the next cycle (`scripts/bump-after-publish.js`).

## Why natives are not in git

`native/` is gitignored. The npm tarball may include the platform you built on;
other platforms install via GitHub Releases (`figmagraph.nativeReleaseBase`).

## Plugin (Figma Community)

Local/dev: **Plugins → Development → Import plugin from manifest…** → `plugin/manifest.json`.

To publish to Community: Figma → plugin → Publish (needs a Figma org / listing). Ship the same `plugin/` folder; point users at the Community listing in the README once live.
