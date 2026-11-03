// Panneau bas façon terminal : console, état, TSX, screenshot.
// Redimensionnable à la souris (poignée haute) + boutons clavier,
// repliable, hauteur et état persistés en localStorage.
import { useEffect, useRef } from "react";
import {
  Activity,
  Braces,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  FileCode2,
  Terminal as TerminalIcon,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import type { PreviewSource } from "../lib/screenshot";

export type TermTab = "console" | "state" | "tsx" | "shot";

export interface Shot {
  dataUrl: string;
  bytes: number;
  backend: string;
  width: number;
  height: number;
  previewUrl: string | null;
}

interface TerminalProps {
  tab: TermTab;
  onTabChange: (t: TermTab) => void;
  collapsed: boolean;
  onCollapsedChange: (c: boolean) => void;
  height: number;
  onHeightChange: (h: number) => void;
  logs: string[];
  stats: { components: number; traces: number; nets: number; total: number };
  boot: string;
  bridge: string;
  bridgeCopied: boolean;
  onCopyBridge: () => void;
  modeLabel: string;
  ready: boolean;
  tsx: string;
  copied: boolean;
  onCopyTsx: () => void;
  shot: Shot | null;
  shotErr: string | null;
  shotBusy: boolean;
  shotName: string;
  onShotNameChange: (n: string) => void;
  source: PreviewSource;
  onShot: () => void;
}

const MIN_H = 120;
const MAX_H = 560;

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function Terminal(props: TerminalProps) {
  const logRef = useRef<HTMLOListElement | null>(null);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el && props.tab === "console" && !props.collapsed) {
      el.scrollTop = el.scrollHeight;
    }
  }, [props.logs, props.tab, props.collapsed]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (props.collapsed) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: props.height };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current;
    if (!d) return;
    const h = Math.min(MAX_H, Math.max(MIN_H, d.startH + (d.startY - e.clientY)));
    props.onHeightChange(Math.round(h));
  }
  function onPointerUp() {
    dragRef.current = null;
  }

  return (
    <section
      aria-label="Terminal"
      className="terminal"
      style={props.collapsed ? undefined : { height: props.height }}
      data-collapsed={props.collapsed}
    >
      {!props.collapsed && (
        <div
          className="terminal-grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionner le terminal"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <span aria-hidden="true" />
        </div>
      )}
      <Tabs
        value={props.tab}
        onValueChange={(v) => props.onTabChange(v as TermTab)}
        className="terminal-tabs"
      >
        <div className="terminal-bar">
          <TerminalIcon size={14} aria-hidden="true" className="terminal-logo" />
          <TabsList aria-label="Panneaux du terminal">
            <TabsTrigger value="console">
              <TerminalIcon size={13} aria-hidden="true" />
              Console
            </TabsTrigger>
            <TabsTrigger value="state">
              <Activity size={13} aria-hidden="true" />
              État
              <Badge variant={props.ready ? "success" : "warning"} className="term-count">
                {props.stats.total}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="tsx">
              <FileCode2 size={13} aria-hidden="true" />
              TSX
            </TabsTrigger>
            <TabsTrigger value="shot">
              <Camera size={13} aria-hidden="true" />
              Screenshot
              {props.shot && (
                <Badge variant="secondary" className="term-count">
                  {props.shot.width}×{props.shot.height}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
          <div className="terminal-bar-actions">
            <TooltipProvider>
              {!props.collapsed && (
                <>
                  <IconBtn
                    label="Réduire la hauteur du terminal"
                    onClick={() =>
                      props.onHeightChange(Math.max(MIN_H, props.height - 80))
                    }
                  >
                    <ChevronDown size={15} aria-hidden="true" />
                  </IconBtn>
                  <IconBtn
                    label="Agrandir la hauteur du terminal"
                    onClick={() =>
                      props.onHeightChange(Math.min(MAX_H, props.height + 80))
                    }
                  >
                    <ChevronUp size={15} aria-hidden="true" />
                  </IconBtn>
                </>
              )}
              <IconBtn
                label={props.collapsed ? "Déplier le terminal" : "Replier le terminal"}
                onClick={() => props.onCollapsedChange(!props.collapsed)}
              >
                {props.collapsed ? (
                  <ChevronUp size={15} aria-hidden="true" />
                ) : (
                  <ChevronDown size={15} aria-hidden="true" />
                )}
              </IconBtn>
            </TooltipProvider>
          </div>
        </div>

        {!props.collapsed && (
          <div className="terminal-body">
            <TabsContent value="console">
              {props.logs.length === 0 ? (
                <p className="term-empty">Aucun log — lance une recompile.</p>
              ) : (
                <ol ref={logRef} className="term-logs" aria-label="Logs de compilation">
                  {props.logs.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ol>
              )}
            </TabsContent>

            <TabsContent value="state">
              <dl className="term-stats">
                <div>
                  <dt>Composants</dt>
                  <dd>{props.stats.components}</dd>
                </div>
                <div>
                  <dt>Traces</dt>
                  <dd>{props.stats.traces}</dd>
                </div>
                <div>
                  <dt>Nets</dt>
                  <dd>{props.stats.nets}</dd>
                </div>
                <div>
                  <dt>Total</dt>
                  <dd>{props.stats.total}</dd>
                </div>
                <div className="term-stats-wide">
                  <dt>Compilation</dt>
                  <dd>{props.modeLabel}</dd>
                </div>
                <div className="term-stats-wide">
                  <dt>Sidecar</dt>
                  <dd className="term-truncate">{props.boot}</dd>
                </div>
                {props.bridge && (
                  <div className="term-stats-wide">
                    <dt>Pont MCP</dt>
                    <dd className="term-truncate">
                      <code translate="no">{props.bridge}</code>{" "}
                      <Button variant="ghost" size="sm" onClick={props.onCopyBridge}>
                        {props.bridgeCopied ? (
                          <>
                            <Check size={13} aria-hidden="true" /> Copié
                          </>
                        ) : (
                          <>
                            <Copy size={13} aria-hidden="true" /> Copier la commande
                          </>
                        )}
                      </Button>
                    </dd>
                  </div>
                )}
              </dl>
            </TabsContent>

            <TabsContent value="tsx">
              <div className="term-tsx-head">
                <span>
                  <Braces size={13} aria-hidden="true" /> Source de vérité (lecture seule)
                </span>
                <Button variant="ghost" size="sm" onClick={props.onCopyTsx}>
                  {props.copied ? (
                    <>
                      <Check size={13} aria-hidden="true" /> Copié
                    </>
                  ) : (
                    <>
                      <Copy size={13} aria-hidden="true" /> Copier
                    </>
                  )}
                </Button>
              </div>
              <pre className="term-tsx">{props.tsx}</pre>
            </TabsContent>

            <TabsContent value="shot">
              <div className="term-shot-name">
                <label htmlFor="shot-name">Capture nommée (optionnel)</label>
                <input
                  id="shot-name"
                  type="text"
                  value={props.shotName}
                  onChange={(e) => props.onShotNameChange(e.target.value)}
                  placeholder="verif-xyz"
                  maxLength={32}
                  className="term-shot-input"
                  translate="no"
                />
              </div>
              {props.shotErr && (
                <p className="term-error" role="alert">
                  Échec : {props.shotErr} — affiche un onglet avec du contenu puis réessaie.
                </p>
              )}
              {props.shot ? (
                <div className="term-shot">
                  <img
                    src={props.shot.dataUrl}
                    alt={`Capture ${props.source} pour l'agent`}
                    width={props.shot.width}
                    height={props.shot.height}
                    className="term-shot-img"
                  />
                  <div className="term-shot-meta">
                    <p>
                      PNG {props.shot.width}×{props.shot.height} — base64 ≈{" "}
                      <strong>{props.shot.bytes} octets</strong>
                    </p>
                    <p className="term-muted">
                      Moteur : {props.shot.backend} · source :{" "}
                      <code translate="no">{props.source}</code>
                    </p>
                    {props.shot.previewUrl ? (
                      <p className="term-muted term-break">
                        Lien preview locale :{" "}
                        <code translate="no">{props.shot.previewUrl}</code>
                      </p>
                    ) : (
                      <p className="term-muted">
                        Hors Tauri : download seul (ouvre l'app pour l'agent).
                      </p>
                    )}
                    <div className="term-shot-actions">
                      <Button variant="secondary" size="sm" onClick={props.onShot} disabled={props.shotBusy}>
                        <Camera size={13} aria-hidden="true" />
                        {props.shotBusy ? "Capture…" : "Recapturer"}
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <a href={props.shot.dataUrl} download={`agent-${props.source}.png`}>
                          <Download size={13} aria-hidden="true" />
                          Télécharger le PNG
                        </a>
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                !props.shotErr && (
                  <div className="term-shot-empty">
                    <p className="term-muted">
                      Capture l'onglet courant pour l'agent (PNG base64 + taille + lien
                      preview locale <code translate="no">file://</code>). Sans GPU, les
                      vues PCB/3D peuvent afficher « WebGPU rendering failed » : la capture
                      bascule sur SVG/canvas 2D, jamais d'image inventée.
                    </p>
                    <Button variant="secondary" size="sm" onClick={props.onShot} disabled={props.shotBusy}>
                      <Camera size={13} aria-hidden="true" />
                      {props.shotBusy ? "Capture…" : "Capturer l'onglet courant"}
                    </Button>
                  </div>
                )
              )}
            </TabsContent>
          </div>
        )}
      </Tabs>
    </section>
  );
}
