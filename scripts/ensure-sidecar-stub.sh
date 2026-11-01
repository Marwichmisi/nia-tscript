#!/bin/sh
# Recrée le stub sidecar exigé par tauri-build (`externalBin`) quand le vrai
# binaire `pcb-mcp-<triple>` (#10) n'est pas encore construit.
# Le vrai `bun build --compile` de #10 remplacera ce stub.
set -eu
TRIPLE="${1:-$(rustc --print host-tuple)}"
OUT="src-tauri/binaries/pcb-mcp-${TRIPLE}"
if [ -f "$OUT" ]; then
  exit 0
fi
printf '#!/bin/sh\n# STUB #9 — remplace par le vrai sidecar pcb-mcp (ticket #10).\necho "[pcb-mcp-stub] $0 $@" >&2\nexit 0\n' > "$OUT"
chmod +x "$OUT"
echo "stub: $OUT"
