// Board fixture R1/R2+U1 — même TSX que le sidecar pcb-mcp (write-through).
// Le TSX reste la seule source de vérité ; la WebView ne fait que l'afficher.

export const BOARD_CODE = `export default () => (
  <board width="20mm" height="20mm">
    <resistor name="R1" resistance="10k" footprint="0402" pcbX={-5} pcbY={4} />
    <resistor name="R2" resistance="10k" footprint="0402" pcbX={-5} pcbY={-4} />
    <chip name="U1" footprint="sot23" pcbX={5} pcbY={0} />
    <trace from=".R1 > .pin1" to="net.VCC" />
    <trace from=".R1 > .pin2" to=".R2 > .pin1" />
    <trace from=".R1 > .pin2" to=".U1 > .pin1" />
    <trace from=".R2 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin2" to="net.GND" />
    <trace from=".U1 > .pin3" to="net.VCC" />
  </board>
)
`;

export const ENTRYPOINT = "main.tsx";

export function initialFsMap(): Record<string, string> {
  return { [ENTRYPOINT]: BOARD_CODE };
}

export interface CircuitStats {
  total: number;
  components: number;
  traces: number;
  nets: number;
  byType: Record<string, number>;
}

export function computeStats(circuitJson: unknown[]): CircuitStats {
  const byType: Record<string, number> = {};
  for (const el of circuitJson ?? []) {
    const t = (el as { type?: unknown })?.type;
    const key = typeof t === "string" ? t : "unknown";
    byType[key] = (byType[key] ?? 0) + 1;
  }
  const count = (re: RegExp) =>
    Object.entries(byType)
      .filter(([k]) => re.test(k))
      .reduce((a, [, v]) => a + (v as number), 0);
  return {
    total: (circuitJson ?? []).length,
    components: count(/pcb_component|schematic_component|cad_component|source_component/),
    traces: count(/pcb_trace|schematic_trace|source_trace/),
    nets: count(/source_net|pcb_net|schematic_net|cad_net/),
    byType,
  };
}
