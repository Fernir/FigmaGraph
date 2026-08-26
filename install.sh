#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo "Installing figmagraph from $ROOT"
(cd "$ROOT" && npm install && npm run build && npm i -g .)
echo ""
echo "Done. Next:"
echo "  cd your-app"
echo "  figmagraph token <figu_…>"
echo "  figmagraph init '<figma-url>'"
