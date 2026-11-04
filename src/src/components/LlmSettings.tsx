import { useCallback, useEffect, useState } from "react";
import { Button } from "./ui/button";
import {
  isKeyRefused,
  isNoProjectOpen,
  llmClear,
  llmErrorMessage,
  llmSetTelemetry,
  llmStatus,
  llmTest,
  llmVerifyAndSave,
  type LlmStatus,
} from "../lib/llm";

export type LlmToastKind = "ok" | "error" | "info";

interface LlmSettingsProps {
  open: boolean;
  onClose: () => void;
  /** Projet ouvert (la vérification exige G3 : aucun appel sans Projet). */
  projectPath: string | null;
  /** Toasts `role=status` possédés par App (max 3, cf. ticket #43). */
  notify: (kind: LlmToastKind, msg: string) => void;
  /** Remontée statut (bandeau agent désactivé / clé refusée). */
  onStatusChange: (status: LlmStatus | null, keyRefused: boolean) => void;
}

/** Écran Paramètres → Clé API Meta (T4 BYOK, ticket #58).
 *  3 états : (1) vide + « Vérifier et enregistrer », (2) configurée
 *  (masque + statut + Tester / Remplacer / Supprimer + opt-in télémétrie),
 *  (3) suppression → agent désactivé avec explication, app utilisable.
 *  La clé ne transite que vers `llm_verify_and_save` (POST IPC, jamais
 *  stockée côté frontend : ni state persistant, ni store, ni localStorage). */
export function LlmSettings({ open, onClose, projectPath, notify, onStatusChange }: LlmSettingsProps) {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await llmStatus();
      setStatus(s);
      onStatusChange(s, false);
    } catch (e) {
      setStatus(null);
      onStatusChange(null, false);
      setError(llmErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    if (open) {
      setKey("");
      setError(null);
      setReplacing(false);
      setConfirmDelete(false);
      void refresh();
    }
  }, [open, refresh]);

  if (!open) return null;

  async function handleVerify(newKey: string) {
    const clean = newKey.trim();
    if (!clean) {
      setError("Clé vide — colle ta clé Meta dans le champ");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await llmVerifyAndSave(clean);
      setStatus(s);
      onStatusChange(s, false);
      setKey("");
      setReplacing(false);
      notify("ok", "Clé vérifiée et chiffrée");
    } catch (e) {
      const msg = llmErrorMessage(e);
      setError(msg);
      if (isNoProjectOpen(e)) {
        notify("error", "Ouvre un Projet d'abord — aucun appel LLM sans Projet ouvert");
      } else if (isKeyRefused(msg)) {
        onStatusChange(status, true);
        notify("error", msg);
      } else {
        notify("error", msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setBusy(true);
    setError(null);
    try {
      const s = await llmTest();
      setStatus(s);
      onStatusChange(s, false);
      notify("ok", "Clé toujours valide");
    } catch (e) {
      const msg = llmErrorMessage(e);
      setError(msg);
      if (isKeyRefused(msg)) {
        onStatusChange(status, true);
      }
      notify("error", msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    setError(null);
    try {
      await llmClear();
      setConfirmDelete(false);
      setReplacing(false);
      await refresh();
      notify("info", "Clé supprimée — agent désactivé, l'app reste utilisable");
    } catch (e) {
      const msg = llmErrorMessage(e);
      setError(msg);
      notify("error", msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleTelemetry(optin: boolean) {
    setBusy(true);
    try {
      const s = await llmSetTelemetry(optin);
      setStatus(s);
      onStatusChange(s, false);
      notify("info", optin ? "Télémétrie d'usage activée" : "Télémétrie d'usage désactivée");
    } catch (e) {
      notify("error", llmErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const configured = status?.configured === true;

  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="llm-title" aria-describedby="llm-desc">
        <h2 id="llm-title">Clé API Meta</h2>
        {loading ? (
          <p className="term-muted" role="status">Lecture du statut…</p>
        ) : !configured ? (
          <>
            <p id="llm-desc" className="term-muted">
              L&apos;agent intégré utilise ta propre clé Meta (<strong>BYOK</strong>) : vérifiée par un
              appel test au coût nul (<code translate="no">GET /v1/models</code>), chiffrée côté backend,
              jamais affichée ni journalisée. Sans clé ni réseau, l&apos;app reste 100&nbsp;% fonctionnelle.
            </p>
            <p className="term-muted">
              Console Meta (gestion des clés) : <code translate="no">https://api.meta.ai</code> — choisis
              une clé dédiée, révocable à tout moment. Non-rétention : seul l&apos;appel de vérification
              transite, aucun contenu de Projet n&apos;est envoyé.
            </p>
            {!projectPath && (
              <p className="modal-error" role="status">
                Sans Projet ouvert, la vérification est refusée (<code translate="no">NO_PROJECT_OPEN</code>) :
                ouvre un Projet pour activer l&apos;agent.
              </p>
            )}
            <label htmlFor="llm-key" className="modal-label">Clé API Meta</label>
            <input
              id="llm-key"
              className="llm-input"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Colle ta clé Meta ici"
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
            {error && (
              <p className="modal-error" role="alert">{error}</p>
            )}
            <div className="modal-actions">
              <Button variant="outline" size="sm" onClick={onClose}>Fermer</Button>
              <Button size="sm" onClick={() => void handleVerify(key)} disabled={busy || !key.trim()}>
                {busy ? "Vérification…" : "Vérifier et enregistrer"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p id="llm-desc" className="term-muted">
              Clé configurée <strong translate="no">{status?.mask}</strong>
              {status?.verifiedAt && (
                <> — vérifiée le {new Date(status.verifiedAt).toLocaleString()}</>
              )}{" "}
              · modèle défaut : <code translate="no">{status?.model}</code> (liste réelle via{" "}
              <code translate="no">GET /v1/models</code>, repli hors-ligne).
            </p>
            <p className="term-muted">
              Budget session : <strong translate="no">{status?.sessionTokens ?? 0}</strong> jetons consommés
              (plafond 100&nbsp;000, backoff 429, hard limit — Denial-of-Wallet).
            </p>
            {!replacing ? (
              <>
                {error && (
                  <p className="modal-error" role="alert">{error}</p>
                )}
                <div className="modal-actions modal-actions-start">
                  <Button size="sm" variant="outline" onClick={() => void handleTest()} disabled={busy}>
                    {busy ? "Test…" : "Tester"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setReplacing(true); setError(null); }} disabled={busy}>
                    Remplacer…
                  </Button>
                  {!confirmDelete ? (
                    <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)} disabled={busy}>
                      Supprimer…
                    </Button>
                  ) : (
                    <>
                      <span className="term-muted">Supprimer la clé ? L&apos;agent sera désactivé, l&apos;app restera utilisable.</span>
                      <Button size="sm" onClick={() => setConfirmDelete(false)} disabled={busy} variant="outline">
                        Garder
                      </Button>
                      <Button size="sm" onClick={() => void handleClear()} disabled={busy}>
                        {busy ? "Suppression…" : "Confirmer la suppression"}
                      </Button>
                    </>
                  )}
                </div>
                <label className="llm-check">
                  <input
                    type="checkbox"
                    checked={status?.telemetryOptIn === true}
                    disabled={busy}
                    onChange={(e) => void handleTelemetry(e.target.checked)}
                  />
                  Télémétrie d&apos;usage (opt-in, défaut désactivée — jamais de clé ni de prompt intégral)
                </label>
                <div className="modal-actions">
                  <Button variant="outline" size="sm" onClick={onClose}>Fermer</Button>
                </div>
              </>
            ) : (
              <>
                <p className="term-muted">
                  La clé actuelle n&apos;est écrasée que si la nouvelle est acceptée — un refus la conserve.
                </p>
                <label htmlFor="llm-key-replace" className="modal-label">Nouvelle clé Meta</label>
                <input
                  id="llm-key-replace"
                  className="llm-input"
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="Colle la nouvelle clé"
                  spellCheck={false}
                  autoComplete="off"
                  autoFocus
                />
                {error && (
                  <p className="modal-error" role="alert">{error}</p>
                )}
                <div className="modal-actions">
                  <Button variant="outline" size="sm" onClick={() => { setReplacing(false); setKey(""); setError(null); }}>
                    Annuler
                  </Button>
                  <Button size="sm" onClick={() => void handleVerify(key)} disabled={busy || !key.trim()}>
                    {busy ? "Vérification…" : "Vérifier et remplacer"}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Bandeau agent désactivé / clé refusée (T4 BYOK, ticket #58).
 *  Affiché quand un Projet est ouvert mais l'agent est inutilisable :
 *  pas de clé → explication, clé refusée → « rouvre les Paramètres ».
 *  Accès direct aux Paramètres ; l'app reste utilisable dans tous les cas. */
export function LlmKeyBanner({
  configured,
  keyRefused,
  onOpenSettings,
}: {
  configured: boolean;
  keyRefused: boolean;
  onOpenSettings: () => void;
}) {
  if (configured && !keyRefused) return null;
  return (
    <div className={keyRefused ? "notice notice-error" : "notice notice-warn"} role={keyRefused ? "alert" : "status"}>
      <span>
        {keyRefused
          ? "Clé refusée — rouvre les Paramètres pour la remplacer."
          : "Agent désactivé — aucune clé API configurée. L'app reste 100 % utilisable."}
      </span>
      <Button variant="outline" size="sm" onClick={onOpenSettings}>
        Ouvrir les Paramètres
      </Button>
    </div>
  );
}
