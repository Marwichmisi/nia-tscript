# Approvals batch atomique — `batch_execute` (ticket #16)

Une itération complète = **un seul `tools/call batch_execute`** = **une seule approbation**
côté client. Sans batch : N ops (patch + moves) = N approbations.

## Hints MCP (vérifiés via `tools/list`)

```json
{
  "name": "batch_execute",
  "annotations": {
    "readOnlyHint": false,
    "destructiveHint": true,
    "idempotentHint": false,
    "openWorldHint": false
  }
}
```

- `readOnlyHint: false` + `destructiveHint: true` : le lot mute le TSX (write-through)
  puis recompile. Les clients qui auto-approuvent le lecture seule doivent
  demander confirmation ici (spec MCP 2026-07-28, ToolAnnotations).
- `code_patch` et `live_manage` portent les mêmes hints ; `pcb_state`,
  `logs_read`, `run_checks`, `preview_screenshot` sont `readOnlyHint: true`.
- Test : `bun test test/batch_execute.test.ts` vérifie `tools/list`
  expose ces hints + rollback.

## Atomicité (fichier + live)

1. Snapshot `code + compile + drc` (`snapshotStore()`).
2. `applyBatch()` pur en mémoire, dans l'ordre (patch ancré + move/rotate/
   swap_package/reassign_net). Premier échec → restore, `applied: false`,
   `failedOpIndex`, `rolledBack: true`, TSX inchangé.
3. Une seule `compileTsx()`. Erreurs != 0 → restore, `applied: false`,
   `rolledBack: true`, diagnostics compilateur.
4. Succès → `setCode` + `setLastCompile(ok)`, `ready: true`, stats + circuit-json.
5. Sérialisé par `enqueue` (file #14) : deux batch concurrents ne s'entrelacent pas.

## Approval_mode par client (une approbation par lot)

### opencode — `permission` dans `opencode.json`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    // défaut : demander pour tout le serveur
    "pcb-mcp_*": "ask",
    // lot atomique : une approbation couvre patch+live
    "pcb-mcp_batch_execute": "ask",
    // lecture auto-approuvée (hints readOnly)
    "pcb-mcp_pcb_state": "allow",
    "pcb-mcp_logs_read": "allow"
  }
}
```

- `ask` = 1 prompt par `batch_execute`, quel que soit le nombre d'ops.
- Pour itérer sans friction en dev : `"pcb-mcp_batch_execute": "allow"`.

### claude code — `claude mcp add` + prompts destructifs

```bash
# stdio via bridge (défaut)
claude mcp add --transport stdio niatscircuit -- npx -y @nia-tscircuit/mcp-bridge
# HTTP directe (token du lockfile mcp.json)
claude mcp add --transport http niatscircuit-local http://127.0.0.1:PORT/mcp \
  --header "Authorization: Bearer TOKEN"
```

- `destructiveHint: true` → dialogue de confirmation avant exécution.
- Un lot valide = 1 confirmation ; sans batch = N confirmations.
- Variables utiles : `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT` (lots avec compile longue).

### codex — `config.toml` approvals

```toml
[mcp_servers.niatscircuit]
command = "npx"
args = ["-y", "@nia-tscircuit/mcp-bridge"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

- `codex` demande approval par `tools/call` (voir `approvals`,
  `enabled_tools` / `disabled_tools` dans `config.toml`).
- `batch_execute` = 1 approval par itération. Pré-approuver en dev via
  allow-list du serveur (`niatscircuit`) ou du seul outil batch.

### cursor — `mcp.json` + auto-run

```jsonc
// .cursor/mcp.json
{ "mcpServers": { "niatscircuit": {
  "command": "npx", "args": ["-y", "@nia-tscircuit/mcp-bridge"] } } }
```

- Cursor affiche les images base64 et supporte MCP Apps, mais le batch reste
  texte+JSON (pas de dépendance Apps).
- Outils `destructiveHint: true` → auto-run désactivé par défaut, 1 clic par lot.
- Lecture (`pcb_state`, `logs_read`) : auto-run sûr (`readOnlyHint: true`).

## Preuves acceptance #16

- `bun test test/batch.test.ts` (pur) : patch+move ok, échec index 0/1, lot vide refusé.
- `bun test test/batch_execute.test.ts` (MCP) : hints via `tools/list`,
  lot valide → `applied true + ready true`, lot mixte échec → `rolledBack true`
  + `getCode()` inchangé + `pcb_state ready true`, compile cassée → rollback.
- `bun test` complet + `tsc --noEmit` verts avant close.
