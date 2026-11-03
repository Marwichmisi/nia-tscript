import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, CircuitBoard, Copy, FolderOpen, Plus, Trash2, X } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { projectName, projectParentName, type ProjectItem } from "../lib/projects";

interface HomeProps {
  projects: ProjectItem[];
  lastOpened: string | null;
  busy: boolean;
  error: string | null;
  onOpen: (path: string) => void;
  onCreate: (path: string, template: "vide" | "demo") => void;
  onForget: (path: string) => void;
  onRelink: (oldPath: string, newPath: string) => void;
  onDelete: (path: string) => void;
  bridge: string;
  boot: string;
  bridgeCopied: boolean;
  onCopyBridge: () => void;
}

export function Home({ projects, lastOpened, busy, error, onOpen, onCreate, onForget, onRelink, onDelete, bridge, boot, bridgeCopied, onCopyBridge }: HomeProps) {
  const [template, setTemplate] = useState<"vide" | "demo">("vide");
  const empty = projects.length === 0;
  // Ticket #45, US10 : pendant le démarrage le pont n'est pas encore là —
  // le bouton Copier est désactivé AVEC explication (fini le faux négatif
  // « Pont introuvable » qui faisait croire au pont KO).
  const booting = !bridge && boot === "démarrage…";

  async function pickAndCreate() {
    try {
      const sel = await open({ directory: true, multiple: false, canCreateDirectories: true, title: "Choisir le dossier projet" });
      if (typeof sel === "string" && sel) onCreate(sel, template);
    } catch (e) {
      console.error(e);
    }
  }

  async function pickAndOpen() {
    try {
      const sel = await open({ directory: true, multiple: false, title: "Ouvrir un dossier projet" });
      if (typeof sel === "string" && sel) onOpen(sel);
    } catch (e) {
      console.error(e);
    }
  }

  async function pickAndRelink(oldPath: string) {
    try {
      const sel = await open({ directory: true, multiple: false, title: `Relier « ${oldPath} » vers…` });
      if (typeof sel === "string" && sel) onRelink(oldPath, sel);
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-brand">
          <span className="brand-tile home-tile" aria-hidden="true">
            <img src="/logo.png" alt="" width={28} height={28} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            <CircuitBoard size={empty ? 28 : 16} aria-hidden="true" style={{ display: "none" }} />
          </span>
          <div>
            <h1>NIATSCIRCUIT Studio</h1>
            <p>Studio PCB agentique (Tauri + tscircuit), piloté par ton agent IA via MCP.</p>
            <p className="home-sub">Un dossier = un Projet. Tout (main.tsx, previews, exports) vit dedans.</p>
          </div>
        </div>

        <div className="home-bridge" style={{ margin: "12px 0", padding: "10px 12px", border: "1px solid var(--border, #27272a)", borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Pont MCP — connexion agent</div>
          <div className="term-truncate" style={{ fontSize: 12, opacity: 0.85 }}>Sidecar : {boot}</div>
          {booting ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
              <Button variant="outline" size="sm" disabled title="Pont en cours de démarrage — la commande arrive quand le sidecar est prêt">
                <Copy size={13} aria-hidden="true" /> Copier la commande
              </Button>
              <span className="term-muted" style={{ fontSize: 12 }} role="status">
                Pont en cours de démarrage… (le sidecar se lance — la commande arrive quand il est prêt).
              </span>
            </div>
          ) : bridge ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
              <code translate="no" style={{ fontSize: 12 }}>{bridge}</code>
              <Button variant="outline" size="sm" onClick={onCopyBridge}>
                {bridgeCopied ? (<><Check size={13} aria-hidden="true" /> Copié</>) : (<><Copy size={13} aria-hidden="true" /> Copier la commande</>)}
              </Button>
            </div>
          ) : (
            <p className="term-muted" style={{ fontSize: 12, marginTop: 6 }}>
              Pont introuvable — relance l'app (le lockfile a été régénéré au boot). Secours : ouvre l'app puis <code translate="no">opencode mcp add niatscircuit --global -- node &quot;/usr/lib/nia-tscircuit-studio/bridge/bridge.mjs&quot;</code>
            </p>
          )}
          <p className="term-muted" style={{ fontSize: 12, marginTop: 6 }}>
            L'app doit rester ouverte (pas de headless). Ancienne config KO = token éphémère régénéré à chaque lancement.
          </p>
        </div>

        <div className={empty ? "home-hero" : "home-bar"}>
          <div className="home-actions">
            <Button onClick={pickAndCreate} disabled={busy} size={empty ? "default" : "sm"}>
              <Plus size={15} aria-hidden="true" />
              {empty ? "Créer mon premier projet" : "Nouveau projet"}
            </Button>
            {!empty && (
              <Button variant="outline" size="sm" onClick={pickAndOpen} disabled={busy}>
                <FolderOpen size={14} aria-hidden="true" />
                Ouvrir un dossier
              </Button>
            )}
          </div>
          <div className="home-template" role="radiogroup" aria-label="Contenu initial">
            <label>
              <input type="radio" name="tpl" checked={template === "vide"} onChange={() => setTemplate("vide")} />
              Vide
            </label>
            <label>
              <input type="radio" name="tpl" checked={template === "demo"} onChange={() => setTemplate("demo")} />
              Gabarit démo
            </label>
          </div>
        </div>

        {error && (
          <p className="home-error" role="alert">
            {error}
          </p>
        )}

        {!empty && (
          <ul className="home-list">
            {projects.map((p) => (
              <li key={p.path} className={p.path === lastOpened ? "home-item home-current" : "home-item"}>
                <button className="home-open" onClick={() => onOpen(p.path)} disabled={busy || !p.exists} title={p.path}>
                  <span className="home-name">{p.name || projectName(p.path)}</span>
                  {p.parent ? (
                    <span className="home-parent" title={p.parent}>
                      dans {projectParentName(p.parent) || p.parent}
                    </span>
                  ) : null}
                  <span className="home-path">{p.path}</span>
                </button>
                <span className="home-meta">
                  {p.path === lastOpened && <Badge variant="default">dernier</Badge>}
                  {!p.exists && <Badge variant="destructive">orphelin — dossier introuvable</Badge>}
                  {!p.exists && (
                    <Button variant="outline" size="sm" onClick={() => void pickAndRelink(p.path)} disabled={busy} aria-label={`Relier ${p.path} vers un nouveau dossier`}>
                      Relier…
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => onForget(p.path)} disabled={busy} aria-label={`Oublier ${p.path}`}>
                    <X size={14} aria-hidden="true" />
                    Oublier
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onDelete(p.path)} disabled={busy} aria-label={`Supprimer ${p.path}`}>
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {empty && (
          <p className="home-hint">
            Choisis le dossier dans lequel travailler — il sera créé s'il n'existe pas. L'agent IA ne verra que le Projet ouvert.
          </p>
        )}
      </div>
    </div>
  );
}
