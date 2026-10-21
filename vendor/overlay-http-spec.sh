#!/bin/sh
# Replace the registry @stoplight/http-spec (7.1.0) in node_modules with the vendored,
# unreleased build from stoplightio/http-spec feat/oas-3.2 (OAS 3.2 QUERY + additionalOperations).
# Its dependency list is identical to 7.1.0, so package-lock.json stays unchanged and the
# nested node_modules (e.g. @stoplight/types@14.1.0) installed by `npm ci` is kept.
set -eu
ROOT=${1:-.}
TGZ=$(ls "$ROOT"/vendor/stoplight-http-spec-*.tgz)
DEST="$ROOT/node_modules/@stoplight/http-spec"
[ -d "$DEST" ] || { echo "missing $DEST; run npm ci first" >&2; exit 1; }
find "$DEST" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -xzf "$TGZ" -C "$DEST" --strip-components=1
echo "overlaid $(node -p "require('$DEST/package.json').version" 2>/dev/null || basename "$TGZ") into $DEST"
