#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
echo "Installing figmagraph from $ROOT"
(cd "$ROOT" && npm install && npm run build && npm i -g .)
echo "Done → cd your-app && figmagraph init"
