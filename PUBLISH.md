# Publishing FigmaGraph

## Checklist

1. Bump version in `package.json` **and** `crates/figmagraph-core/Cargo.toml` (keep in sync).
2. `npm test` + `npm run build` locally.
3. Commit & push, then tag: `git tag v0.1.4 && git push origin v0.1.4`
4. Wait for **Native binaries** workflow to upload assets to
   `https://github.com/Fernir/FigmaGraph/releases` (`v0.1.4`).
5. `npm publish` (runs `prepublishOnly` → build + test).
   - Postinstall on other machines downloads the matching native asset from that release.
6. `postpublish` bumps patch for the next cycle (`scripts/bump-after-publish.js`).

## Why natives are not in git

`native/` is gitignored. The npm tarball may include the platform you built on;
other platforms install via GitHub Releases (`figmagraph.nativeReleaseBase`).

## OAuth (figmagraph login)

1. Copy `secrets/oauth.json.example` → `secrets/oauth.json` (gitignored — **never commit**).
2. Paste Client Secret from Figma app.
3. `npm run build:js` embeds it into `dist/oauth-config.json` (ships in npm, not in git).

Public GitHub repo stays clean. Note: anyone who installs from npm can still extract the secret from the tarball — normal for CLI OAuth; rotate in Figma if leaked.

## Plugin (Figma Community)

Local/dev: import **once** from the stable path `~/.figmagraph/plugin/manifest.json`
(`figmagraph` / `figmagraph plugin` keeps that folder in sync with the npm package).

Daily: **Plugins → Development → FigmaGraph Export → Push** — no re-import after npm updates.

To publish to Community (users install from Figma UI, no Development import): Figma → plugin → Publish.
Ship the same `plugin/` folder; point README at the Community listing once live.
