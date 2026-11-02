import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CircuitBoard, FolderOpen, Plus, Trash2, X } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { projectName, type ProjectItem } from "../lib/projects";

interface HomeProps {
  projects: ProjectItem[];
  lastOpened: string | null;
  busy: boolean;
  error: string | null;
  onOpen: (path: string) => void;
  onCreate: (path: string, template: "vide" | "demo") => void;
  onForget: (path: string) => void;
  onDelete: (path: string) => void;
}

export function Home({ projects, lastOpened, busy, error, onOpen, onCreate, onForget, onDelete }: HomeProps) {
  const [template, setTemplate] = useState<"vide" | "demo">("vide");
  const empty = projects.length === 0;

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

  return (
    <div className="home">
      <div className="home-inner">
        <div className="home-brand">
          <span className="brand-tile home-tile" aria-hidden="true">
            <CircuitBoard size={empty ? 28 : 16} aria-hidden="true" />
          </span>
          <div>
            <h1>NIATSCIRCUIT Studio</h1>
            <p>Un dossier = un Projet. Tout (main.tsx, previews, exports) vit dedans.</p>
          </div>
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
                  <span className="home-path">{p.path}</span>
                </button>
                <span className="home-meta">
                  {p.path === lastOpened && <Badge variant="default">dernier</Badge>}
                  {!p.exists && <Badge variant="destructive">introuvable</Badge>}
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
