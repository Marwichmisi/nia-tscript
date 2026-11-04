// Tiroir Agent intégré — variante B validée (maquette #54 réécrite en
// propre) : preview pleine largeur, tiroir droit repliable, barre unifiée
// (input + pills mode/modèle + envoi), Terminal bas inchangé.
//
// Ce composant ne parle qu'au hook `useAgentChat` (seam étroit) — jamais
// au SDK en direct. 1 approval = 1 lot (ApprovalCard), suppression Projet
// toujours manuelle (aucun op ne l'expose), lectures libres.

import { useEffect, useRef, useState } from "react";
import { useAgentChat } from "./useAgentChat";
import { Button } from "../components/ui/button";
import type { ChatMessage } from "./store";

/** Suggestions de démarrage (ergonomie : un clic = un envoi). */
const STARTERS: readonly string[] = [
  "Résume l'état de la carte",
  "Vérifie le placement",
  "Déplace R1 de 2 mm vers la droite",
];

/** Libellé humain d'une opération de lot (évite le dump JSON brut). */
function opLabel(op: unknown): string {
  if (typeof op !== "object" || op === null) return "opération inconnue";
  const o = op as Record<string, unknown>;
  switch (o.kind) {
    case "move":
      return `Déplacer ${String(o.refdes ?? "?")} → (x=${String(o.x ?? "?")}, y=${String(o.y ?? "?")})`;
    case "rotate":
      return `Pivoter ${String(o.refdes ?? "?")} de ${String(o.degrees ?? "?")}°`;
    case "swap_package":
      return `Boîtier ${String(o.refdes ?? "?")} → ${String(o.footprint ?? "?")}`;
    case "reassign_net":
      return `${String(o.refdes ?? "?")}.${String(o.pin ?? "?")} → ${String(o.net ?? "?")}`;
    case "patch":
      return `Patch (ancre « ${String(o.anchor ?? "?").slice(0, 60)} »)`;
    case "route":
      return `Router${typeof o.effort === "string" ? ` (effort ${o.effort})` : ""}`;
    default:
      return `Opération « ${String(o.kind ?? "?")} »`;
  }
}

function LotBadge({ lot }: { lot: NonNullable<ChatMessage["lot"]> }) {
  if (lot.applied && !lot.rolledBack) {
    return (
      <span className="agent-lot agent-lot-ok" title={lot.message}>
        ✓ lot appliqué
      </span>
    );
  }
  if (lot.rolledBack) {
    return (
      <span className="agent-lot agent-lot-rollback" title={lot.message}>
        ⤺ rollback — {lot.message.slice(0, 140)}
      </span>
    );
  }
  const refused = /refusé par l'utilisateur/i.test(lot.message);
  return (
    <span className="agent-lot agent-lot-ko" title={lot.message}>
      {refused ? "✕ lot refusé (aucune modification)" : `✕ non appliqué — ${lot.message.slice(0, 140)}`}
    </span>
  );
}

function Conversation({
  messages,
  partial,
  onStarter,
}: {
  messages: ChatMessage[];
  partial: string | null;
  onStarter: (text: string) => void;
}) {
  const bottom = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, partial]);
  return (
    <div className="agent-thread" aria-live="polite" aria-label="Conversation agent">
      {messages.length === 0 && partial === null && (
        <div className="agent-empty">
          <p>Pose ta question ou demande une modification — lectures libres, 1 approval par lot en mode Manuel.</p>
          <div className="agent-starters">
            {STARTERS.map((s) => (
              <button key={s} type="button" className="agent-starter" onClick={() => onStarter(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`agent-msg agent-msg-${m.role}`}>
          {m.model && m.role === "assistant" && (
            <div className="agent-model-tag" translate="no" title="Modèle ayant produit cette réponse (switch mid-conversation possible)">
              {m.model}
            </div>
          )}
          <div className="agent-text">{m.text || "…"}</div>
          {m.role === "assistant" && m.lot && <LotBadge lot={m.lot} />}
        </div>
      ))}
      {partial !== null && (
        <div className="agent-msg agent-msg-assistant agent-streaming" aria-label="Réponse en cours">
          <div className="agent-text">{partial || "…"}</div>
        </div>
      )}
      <div ref={bottom} />
    </div>
  );
}

interface AgentDrawerProps {
  projectPath: string;
  /** Clé configurée (bandeau « colle ta clé » sinon, app utilisable). */
  keyConfigured: boolean;
  onOpenSettings: () => void;
  onClose: () => void;
}

export function AgentDrawer({ projectPath, keyConfigured, onOpenSettings, onClose }: AgentDrawerProps) {
  const chat = useAgentChat(projectPath);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const busy = chat.working || chat.loading;
  const blocked = chat.needsConsent || !keyConfigured;
  const canSend = draft.trim().length > 0 && !busy && !blocked;
  const canResume =
    !busy &&
    !chat.needsConsent &&
    chat.messages.length > 0 &&
    chat.messages[chat.messages.length - 1]?.role === "user";
  const statusLabel =
    chat.status === "awaiting-approval"
      ? "approval requise"
      : chat.status === "working"
        ? chat.partial !== null
          ? "génération…"
          : "réflexion…"
        : "prêt";

  function submit() {
    const t = draft.trim();
    if (!t || busy) return;
    setDraft("");
    chat.send(t);
  }

  return (
    <aside className="agent-drawer" aria-label="Agent intégré">
      <div className="agent-head">
        <span
          className={`agent-dot agent-dot-${chat.status === "idle" ? "idle" : chat.status === "awaiting-approval" ? "approval" : "working"}`}
          aria-hidden="true"
        />
        <strong>Agent IA</strong>
        <span className="agent-status" role="status" title="État du tour en cours">
          {statusLabel}
        </span>
        <span className="agent-context" title="Contexte estimé (compaction automatique à 80 %)">
          {chat.compactionPct} %
        </span>
        <button
          type="button"
          className="agent-fold"
          onClick={onClose}
          aria-label="Replier le tiroir agent (la preview passe pleine largeur)"
          title="Replier"
        >
          →
        </button>
      </div>

      {!keyConfigured && (
        <div className="agent-banner agent-banner-warn" role="status">
          <div>
            <strong>Agent en pause — clé manquante.</strong>
            <br />
            Colle ta clé Meta dans les Paramètres (chiffrée, jamais affichée) pour activer le chat. La compilation,
            les previews et les exports restent disponibles hors-ligne.
          </div>
          <div className="agent-banner-actions">
            <Button size="sm" onClick={onOpenSettings}>
              Ouvrir les Paramètres
            </Button>
          </div>
        </div>
      )}

      {chat.needsConsent && (
        <div className="agent-banner agent-banner-info" role="alert">
          <div>
            <strong>Avant le premier envoi au modèle</strong>
            <br />
            {chat.consentSummary}
          </div>
          <div className="agent-banner-actions">
            <Button size="sm" onClick={chat.giveConsent} disabled={!keyConfigured}>
              J'accepte l'envoi
            </Button>
          </div>
        </div>
      )}

      {chat.loading && (
        <div className="agent-banner agent-banner-info" role="status">
          Chargement de la Conversation chiffrée…
        </div>
      )}

      {chat.degraded && (
        <div className="agent-banner agent-banner-warn" role="status">
          <strong>Dégradé :</strong> {chat.degraded}
        </div>
      )}

      <Conversation messages={chat.messages} partial={chat.partial} onStarter={(s) => chat.send(s)} />

      {chat.pending.length > 0 && (
        <div className="agent-approval" role="alertdialog" aria-label="Approbation requise pour le lot">
          {chat.pending.map((p) => (
            <div key={p.toolCallId} className="agent-approval-card">
              <strong>Approuver ce lot ?</strong>
              <span className="agent-approval-hint">1 approval = 1 lot, rollback automatique en cas d'échec.</span>
              <ul className="agent-ops-list">
                {(p.operations as unknown[]).map((op, i) => (
                  <li key={i}>{opLabel(op)}</li>
                ))}
              </ul>
              <details className="agent-ops-raw">
                <summary>Détail JSON du lot</summary>
                <pre className="agent-ops">{JSON.stringify(p.operations, null, 1).slice(0, 2000)}</pre>
              </details>
              <div className="agent-banner-actions">
                <Button size="sm" onClick={() => chat.approve(p.toolCallId)}>
                  Approuver et appliquer
                </Button>
                <Button size="sm" variant="outline" onClick={() => chat.reject(p.toolCallId, "refusé par l'utilisateur")}>
                  Refuser
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="agent-contextbar">
        <span title="Compaction automatique à 80 % du contexte, conversations par Projet">
          Contexte {chat.compactionPct} %{chat.modelsFallback ? " · modèles (repli)" : ""}
        </span>
        <span className="agent-contextbar-actions">
          {canResume && (
            <button
              type="button"
              className="agent-link"
              onClick={chat.resume}
              title="Rejouer le dernier message (tour interrompu par Stop)"
            >
              Reprendre
            </button>
          )}
          <button
            type="button"
            className="agent-link"
            onClick={chat.newConversation}
            title="Nouvelle conversation (contexte neuf, même Projet, historique précédent conservé en mémoire locale)"
          >
            Nouvelle conversation
          </button>
        </span>
      </div>

      <div className="agent-composer">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            chat.loading
              ? "Chargement de la Conversation chiffrée…"
              : !keyConfigured
                ? "Agent en pause — colle ta clé dans Paramètres…"
                : chat.needsConsent
                  ? "Valide le récapitulatif ci-dessus pour commencer…"
                  : "Message — ex. déplace R1 de 2 mm (Entrée = envoyer)"
          }
          aria-label="Message à l'agent"
          className="agent-input"
          disabled={busy || blocked}
        />
        <div className="agent-composer-row">
          <select
            value={chat.mode}
            onChange={(e) => chat.setMode(e.target.value as "manuel" | "auto")}
            aria-label="Mode d'approbation"
            title="Manuel : 1 approval par lot (défaut). Auto : applique sans demander — la suppression du Projet reste toujours manuelle."
            className="agent-pill"
            disabled={busy}
          >
            <option value="manuel">Manuel · 1 approval/lot</option>
            <option value="auto">Auto · sans demander</option>
          </select>
          <span className="agent-spacer" />
          <select
            value={chat.model}
            onChange={(e) => chat.setModel(e.target.value)}
            aria-label="Modèle Meta"
            title={
              chat.modelsFallback
                ? "Liste live indisponible (repli codé, voir module models.ts) — switch mid-conversation sans perte, historique partagé"
                : "Modèle Meta — switch mid-conversation sans perte"
            }
            className="agent-pill"
            disabled={busy}
          >
            {chat.models.map((m) => (
              <option key={m} value={m} translate="no">
                {m}
              </option>
            ))}
          </select>
          {busy ? (
            <button
              type="button"
              className="agent-send agent-stop"
              onClick={chat.stop}
              aria-label="Stop — interrompre la génération (reprise possible)"
              title="Stop (reprise possible via « Reprendre »)"
            >
              ■<span className="agent-stop-label">Stop</span>
            </button>
          ) : (
            <button
              type="button"
              className="agent-send"
              onClick={submit}
              disabled={!canSend}
              aria-label="Envoyer le message (Entrée)"
              title={blocked ? "Valide le pré-requis ci-dessus (clé / consentement)" : "Envoyer (Entrée)"}
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
