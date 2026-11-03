// PROTOTYPE JETABLE (ticket #54) — ne pas merger dans main, ne pas polir.
// Question : à quoi ressemble le chat Agent intégré ? 3 variantes structurellement
// différentes sur le Studio actuel, switch via `?chatproto=<a|b|c>` + barre flottante.
// Lancer : `cd src && npm run dev` → http://localhost:1420/?chatproto=a
// Variantes : A (Acté : gauche chat / droite preview / bas terminal), B (Drawer latéral
// sur preview pleine largeur), C (Console basse pleine largeur). Tout est mocké en
// mémoire : modèles, streaming, approvals, compaction. Aucune clé, aucun réseau.
import { useCallback, useEffect, useRef, useState } from "react";

const MOCK_MODELS = ["muse-spark-1.3", "muse-spark-1.2", "muse-wonder-1.0"];
const VARIANTS = ["a", "b", "c"] as const;
type Variant = (typeof VARIANTS)[number];
type Mode = "manuel" | "auto";
interface Msg {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
  model?: string;
}

let seq = 0;
const nid = () => ++seq;

function useMockChat() {
  const [msgs, setMsgs] = useState<Msg[]>([
    { id: nid(), role: "system", text: "MOCK — aucune clé, aucun réseau. Tout est simulé en mémoire." },
  ]);
  const [model, setModel] = useState(MOCK_MODELS[0]!);
  const [mode, setMode] = useState<Mode>("manuel");
  const [pending, setPending] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const contextPct = Math.min(96, 12 + msgs.length * 9);
  const push = (m: Msg) => setMsgs((l) => [...l, m]);

  const streamReply = useCallback(
    (full: string, usedModel: string) => {
      const id = nid();
      setStreaming(true);
      push({ id, role: "assistant", text: "", model: usedModel });
      const words = full.split(" ");
      words.forEach((_, i) => {
        timers.current.push(
          window.setTimeout(() => {
            setMsgs((l) => l.map((m) => (m.id === id ? { ...m, text: words.slice(0, i + 1).join(" ") } : m)));
            if (i === words.length - 1) setStreaming(false);
          }, 90 * (i + 1)),
        );
      });
    },
    [],
  );

  const applyLot = useCallback(
    (lot: string) => {
      push({ id: nid(), role: "assistant", text: `Lot appliqué (mock) : ${lot} — rollback simulé OK.`, model });
      setPending(null);
    },
    [model],
  );

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || streaming) return;
      push({ id: nid(), role: "user", text: t });
      const usedModel = model;
      if (/d[ée]place|bouge|move|route|ajoute/i.test(t)) {
        const lot = `batch_execute mock ← « ${t} »`;
        if (mode === "manuel") {
          streamReply(`Je propose ce lot (1 approval requise) : ${lot}.`, usedModel);
          timers.current.push(window.setTimeout(() => setPending(lot), 90 * 8));
        } else {
          streamReply(`Mode Auto : j'applique sans demander.`, usedModel);
          timers.current.push(window.setTimeout(() => applyLot(lot), 1200));
        }
      } else {
        streamReply(`Réponse mockée de ${usedModel} : reçu « ${t} ». La preview de droite ne bouge pas (prototype).`, usedModel);
      }
    },
    [model, mode, streaming, streamReply, applyLot],
  );

  const switchModel = useCallback((m: string) => {
    setModel(m);
    push({ id: nid(), role: "system", text: `Modèle → ${m} (même conversation, historique partagé).` });
  }, []);

  const reset = useCallback(() => {
    setMsgs([{ id: nid(), role: "system", text: "Nouvelle conversation (contexte neuf, même Projet)." }]);
    setPending(null);
  }, []);

  return { msgs, model, switchModel, mode, setMode, pending, setPending, applyLot, send, reset, streaming, contextPct };
}

type Chat = ReturnType<typeof useMockChat>;

function ModelPicker({ chat }: { chat: Chat }) {
  return (
    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
      Modèle
      <select value={chat.model} onChange={(e) => chat.switchModel(e.target.value)} aria-label="Modèle">
        {MOCK_MODELS.map((m) => (
          <option key={m} value={m}>{m} (mock)</option>
        ))}
      </select>
    </label>
  );
}

function ModeToggle({ chat }: { chat: Chat }) {
  return (
    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
      Approbations
      <select value={chat.mode} onChange={(e) => chat.setMode(e.target.value as Mode)} aria-label="Mode d'approbation">
        <option value="manuel">Manuel (1 approval/lot)</option>
        <option value="auto">Auto modifications</option>
      </select>
    </label>
  );
}

function Thread({ chat, compact }: { chat: Chat; compact?: boolean }) {
  return (
    <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, padding: 8 }}>
      {chat.msgs.map((m) => (
        <div
          key={m.id}
          style={{
            alignSelf: m.role === "user" ? "flex-end" : "flex-start",
            background: m.role === "user" ? "#e8f0fe" : m.role === "system" ? "#f1f3f4" : "#fff",
            border: "1px solid #dadce0",
            borderRadius: 8,
            padding: compact ? "4px 8px" : "6px 10px",
            maxWidth: "92%",
            fontSize: compact ? 12 : 13,
          }}
        >
          {m.model && <div style={{ fontSize: 10, color: "#5f6368" }}>{m.model}</div>}
          <div>{m.text || "…"}</div>
        </div>
      ))}
      {chat.pending && (
        <div style={{ border: "2px dashed #f9ab00", borderRadius: 8, padding: 8, fontSize: 13 }}>
          <div><strong>Approval requise (mock)</strong> — {chat.pending}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button onClick={() => chat.applyLot(chat.pending!)}>Approuver</button>
            <button onClick={() => chat.setPending(null)}>Refuser</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Barre de saisie unifiée (variante B) : input + contrôles intégrés dans la même
 *  barre arrondie — [+] [mode pill] … [modèle pill] [envoi]. D'après les captures
 *  du porteur. Selects natifs en mock (la vraie liste viendra de GET /v1/models). */
function ComposerBar({ chat }: { chat: Chat }) {
  const [v, setV] = useState("");
  const pill: React.CSSProperties = { border: "none", background: "transparent", fontSize: 12, color: "#5f6368", maxWidth: 190 };
  return (
    <div style={{ margin: 8, border: "1px solid #dadce0", borderRadius: 16, padding: "8px 8px 6px", background: "#fff" }}>
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chat.send(v); setV(""); } }}
        placeholder="Message or run a task, / commands, @ files or sessions (mock)"
        aria-label="chat"
        style={{ width: "100%", boxSizing: "border-box", border: "none", outline: "none", padding: 6, fontSize: 13 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
        <button title="Joindre (mock, sans effet)" style={{ border: "1px solid #dadce0", borderRadius: "50%", width: 26, height: 26 }} onClick={() => chat.send("joint une pièce (mock)")}>+</button>
        <select value={chat.mode} onChange={(e) => chat.setMode(e.target.value as Mode)} aria-label="Mode d'approbation" style={pill} title="Mode d'approbation">
          <option value="manuel">Manuel (1 approval/lot)</option>
          <option value="auto">Full access (auto)</option>
        </select>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
          <select value={chat.model} onChange={(e) => chat.switchModel(e.target.value)} aria-label="Modèle" style={pill} title="Modèle (mock)">
            <optgroup label="meta">
              {MOCK_MODELS.map((m) => (
                <option key={m} value={m}>{m} (mock)</option>
              ))}
            </optgroup>
          </select>
          <button onClick={() => { chat.send(v); setV(""); }} disabled={chat.streaming} aria-label="Envoyer" style={{ borderRadius: "50%", width: 30, height: 30 }}>↑</button>
        </span>
      </div>
    </div>
  );
}
function Composer({ chat }: { chat: Chat }) {
  const [v, setV] = useState("");
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); chat.send(v); setV(""); }}
      style={{ display: "flex", gap: 6, padding: 8, borderTop: "1px solid #dadce0", alignItems: "center" }}
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="chat (mock) — ex. déplace R1"
        aria-label="chat"
        style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #dadce0" }}
      />
      <button type="submit" disabled={chat.streaming}>→</button>
    </form>
  );
}

function ContextBar({ chat }: { chat: Chat }) {
  return (
    <div style={{ padding: "4px 8px", fontSize: 11, borderTop: "1px solid #eee" }}>
      <div>Contexte (mock) : {chat.contextPct}% {chat.contextPct >= 80 && "— compaction simulée au prochain tour"}</div>
      <button onClick={chat.reset} style={{ fontSize: 11, marginTop: 2 }}>Nouvelle conversation</button>
    </div>
  );
}

function FakePreview({ label }: { label: string }) {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#fafafa" }}>
      <div style={{ textAlign: "center", color: "#5f6368" }}>
        <div style={{ fontSize: 15 }}>Interface de preview de la carte après modification (mock)</div>
        <div style={{ fontSize: 12 }}>{label} — aucun circuit réel</div>
      </div>
    </div>
  );
}

function StateSurface({ chat, variant }: { chat: Chat; variant: string }) {
  return (
    <pre style={{ margin: 0, padding: 8, fontSize: 11, background: "#202124", color: "#e8eaed", overflow: "auto", maxHeight: 140 }}>
      {JSON.stringify({ variant, model: chat.model, mode: chat.mode, streaming: chat.streaming, pending: chat.pending, contextPct: chat.contextPct, messages: chat.msgs.length }, null, 1)}
    </pre>
  );
}

const BANNER: React.CSSProperties = { background: "#fdd", border: "2px solid red", padding: 6, fontSize: 12 };
const PANEL: React.CSSProperties = { border: "1px solid #dadce0", borderRadius: 8, background: "#fff", display: "flex", flexDirection: "column", minHeight: 0 };

/** A (Acté) : gauche Agent IA + chat bas, droite preview, bas terminal mock. */
function VariantA({ chat }: { chat: Chat }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={BANNER}>PROTOTYPE JETABLE #54 — variante A (Actée) — mock, aucune clé</div>
      <div style={{ flex: 1, display: "flex", gap: 8, padding: 8, minHeight: 0 }}>
        <div style={{ ...PANEL, width: 340 }}>
          <div style={{ padding: 8, borderBottom: "1px solid #eee", fontWeight: 700 }}>Agent IA</div>
          <div style={{ display: "flex", gap: 8, padding: 8, flexWrap: "wrap" }}><ModelPicker chat={chat} /><ModeToggle chat={chat} /></div>
          <Thread chat={chat} />
          <Composer chat={chat} />
          <ContextBar chat={chat} />
        </div>
        <div style={{ ...PANEL, flex: 1 }}>
          <div style={{ padding: 8, borderBottom: "1px solid #eee" }}>Schéma · PCB · 3D (mock)</div>
          <FakePreview label="A" />
        </div>
      </div>
      <div style={{ height: 150, borderTop: "1px solid #dadce0", display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 12, padding: "4px 8px" }}>Terminal (mock) — logs/state/tsx/shot inchangés</div>
        <StateSurface chat={chat} variant="a" />
      </div>
    </div>
  );
}

/** B (Drawer) : preview pleine largeur, chat en tiroir latéral droit repliable. */
function VariantB({ chat }: { chat: Chat }) {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={BANNER}>PROTOTYPE JETABLE #54 — variante B (Drawer) — mock, aucune clé {!open && <button onClick={() => setOpen(true)} style={{ marginLeft: 8 }}>Ouvrir l'agent</button>}</div>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ ...PANEL, flex: 1, margin: 8 }}>
          <div style={{ padding: 8, borderBottom: "1px solid #eee" }}>
            Schéma · PCB · 3D (mock, pleine largeur)
          </div>
          <FakePreview label="B" />
          <ContextBar chat={chat} />
        </div>
        {open && (
          <div style={{ ...PANEL, width: 380, margin: "8px 8px 8px 0" }}>
            <div style={{ padding: 8, borderBottom: "1px solid #eee", fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
              Agent IA
              <button onClick={() => setOpen(false)} style={{ marginLeft: "auto" }} aria-label="Replier">→</button>
            </div>
            <Thread chat={chat} compact />
            <ComposerBar chat={chat} />
          </div>
        )}
      </div>
      <StateSurface chat={chat} variant="b" />
    </div>
  );
}

/** C (Console) : preview en haut, chat-console pleine largeur en bas façon terminal. */
function VariantC({ chat }: { chat: Chat }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={BANNER}>PROTOTYPE JETABLE #54 — variante C (Console) — mock, aucune clé</div>
      <div style={{ flex: 1, display: "flex", gap: 8, padding: 8, minHeight: 0 }}>
        <div style={{ ...PANEL, flex: 1 }}>
          <div style={{ padding: 8, borderBottom: "1px solid #eee", display: "flex", gap: 8 }}>
            <span>Preview (mock)</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}><ModelPicker chat={chat} /><ModeToggle chat={chat} /></span>
          </div>
          <FakePreview label="C" />
        </div>
      </div>
      <div style={{ height: "38vh", borderTop: "2px solid #333", background: "#202124", color: "#e8eaed", display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 12, padding: "4px 8px" }}>Agent IA — console (mock) · {chat.model} · {chat.mode}</div>
        <div style={{ flex: 1, overflowY: "auto", padding: 8, fontSize: 13, fontFamily: "monospace" }}>
          {chat.msgs.map((m) => (
            <div key={m.id}>[{m.role}{m.model ? `:${m.model}` : ""}] {m.text || "…"}</div>
          ))}
          {chat.pending && (
            <div>[approval requise] {chat.pending} <button onClick={() => chat.applyLot(chat.pending!)}>y</button> <button onClick={() => chat.setPending(null)}>n</button></div>
          )}
        </div>
        <Composer chat={chat} />
      </div>
      <StateSurface chat={chat} variant="c" />
    </div>
  );
}

const NAMES: Record<Variant, string> = { a: "A (Actée : gauche chat / droite preview)", b: "B (Drawer latéral repliable)", c: "C (Console basse)" };

export default function ChatPrototype() {
  const chat = useMockChat();
  const initial = (new URLSearchParams(window.location.search).get("chatproto") ?? "a") as Variant;
  const [variant, setVariant] = useState<Variant>(VARIANTS.includes(initial) ? initial : "a");
  const go = useCallback((v: Variant) => {
    setVariant(v);
    const u = new URL(window.location.href);
    u.searchParams.set("chatproto", v);
    window.history.replaceState(null, "", u);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const i = VARIANTS.indexOf(variant);
      if (e.key === "ArrowRight") go(VARIANTS[(i + 1) % VARIANTS.length]!);
      if (e.key === "ArrowLeft") go(VARIANTS[(i + VARIANTS.length - 1) % VARIANTS.length]!);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant, go]);

  return (
    <>
      {variant === "a" && <VariantA chat={chat} />}
      {variant === "b" && <VariantB chat={chat} />}
      {variant === "c" && <VariantC chat={chat} />}
      {import.meta.env.DEV && (
        <div style={{ position: "fixed", bottom: 12, left: "50%", transform: "translateX(-50%)", background: "#111", color: "#fff", borderRadius: 999, padding: "6px 12px", display: "flex", gap: 12, alignItems: "center", zIndex: 9999, fontFamily: "monospace" }}>
          <button onClick={() => go(VARIANTS[(VARIANTS.indexOf(variant) + VARIANTS.length - 1) % VARIANTS.length]!)} aria-label="précédent">←</button>
          <span>{variant} ({NAMES[variant]}) — ?chatproto={variant}</span>
          <button onClick={() => go(VARIANTS[(VARIANTS.indexOf(variant) + 1) % VARIANTS.length]!)} aria-label="suivant">→</button>
        </div>
      )}
    </>
  );
}
