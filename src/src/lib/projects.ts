import { invoke } from "@tauri-apps/api/core";

export interface ProjectItem {
  path: string;
  name: string;
  /** Dossier parent complet (homonymes distingués dans l'Accueil). */
  parent: string;
  exists: boolean;
  lastOpened: string;
}

export interface ProjectList {
  projects: ProjectItem[];
  lastOpened: string | null;
}

export async function listProjects(): Promise<ProjectList> {
  return (await invoke("list_projects")) as ProjectList;
}

export async function currentProject(): Promise<string | null> {
  return (await invoke("current_project")) as string | null;
}

export async function createProject(path: string, template: "vide" | "demo" = "vide"): Promise<string> {
  return (await invoke("create_project", { path, template })) as string;
}

export async function openProject(path: string): Promise<string> {
  return (await invoke("open_project", { path })) as string;
}

export async function closeProject(): Promise<void> {
  await invoke("close_project");
}

export async function forgetProject(path: string): Promise<void> {
  await invoke("forget_project", { path });
}

export async function relinkProject(oldPath: string, newPath: string): Promise<string> {
  return (await invoke("relink_project", { oldPath, newPath })) as string;
}

export async function deleteProject(path: string): Promise<void> {
  await invoke("delete_project", { path });
}

export async function readProjectMain(path?: string): Promise<{ path: string; code: string }> {
  return (await invoke("read_project_main", { path: path ?? null })) as {
    path: string;
    code: string;
  };
}

export function projectName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Nom affichable du dossier parent (homonymes distingués). */
export function projectParentName(parent: string): string {
  if (!parent) return "";
  const parts = parent.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? parent;
}
