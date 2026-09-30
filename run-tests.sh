#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(mktemp -d "${TMPDIR:-/tmp}/pi-telemetry.XXXXXX")"
trap 'rm -rf "$out"' EXIT

mkdir -p "$out/node_modules/@earendil-works/pi-coding-agent" "$out/node_modules/@earendil-works/pi-tui"
printf '{"type":"module"}\n' > "$out/package.json"
printf 'export function getAgentDir() { return "/tmp/pi-agent"; }\n' > "$out/node_modules/@earendil-works/pi-coding-agent/index.js"
printf '{"name":"@earendil-works/pi-coding-agent","type":"module","main":"index.js"}\n' > "$out/node_modules/@earendil-works/pi-coding-agent/package.json"
printf 'export function matchesKey() { return false; }\nexport function truncateToWidth(value) { return value; }\nexport function visibleWidth(value) { return value.length; }\n' > "$out/node_modules/@earendil-works/pi-tui/index.js"
printf '{"name":"@earendil-works/pi-tui","type":"module","main":"index.js"}\n' > "$out/node_modules/@earendil-works/pi-tui/package.json"
cp "$here/index.ts" "$here/metrics.ts" "$here/test.mjs" "$out/"

global_node_modules="$(npm root -g 2>/dev/null || true)"
pi_pkg="${PI_CODING_AGENT_PACKAGE_DIR:-$global_node_modules/@earendil-works/pi-coding-agent}"
tsc=""
for candidate in "$(command -v tsc || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] && { tsc="$candidate"; break; }
done
if [ -n "$tsc" ] && [ -d "$pi_pkg" ]; then
  cat > "$out/node-stub.d.ts" <<'EOF'
declare module "node:fs" {
  export function appendFileSync(path: string, data: string, options?: unknown): void;
  export function mkdirSync(path: string, options?: unknown): void;
  export function readFileSync(path: string, encoding: string): string;
  export function statSync(path: string): { isFile(): boolean };
}
declare module "node:path" {
  export function dirname(path: string): string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
}
EOF
  cat > "$out/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "ES2023", "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "skipLibCheck": true,
    "allowImportingTsExtensions": true, "types": [],
    "paths": {
      "@earendil-works/pi-coding-agent": ["$pi_pkg/dist/index.d.ts"],
      "@earendil-works/pi-ai": ["$pi_pkg/node_modules/@earendil-works/pi-ai/dist/index.d.ts"],
      "@earendil-works/pi-tui": ["$pi_pkg/node_modules/@earendil-works/pi-tui/dist/index.d.ts"]
    }
  },
  "files": ["$out/node-stub.d.ts", "$out/metrics.ts", "$out/index.ts"]
}
EOF
  "$tsc" -p "$out/tsconfig.json"
  echo "typecheck clean"
fi

cd "$out" && node test.mjs
