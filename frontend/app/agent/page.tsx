"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./agent.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5555/api";

interface ModelOption {
  id: string;
  label: string;
  description: string;
  is_default: boolean;
}

interface TurnResponse {
  answer: string;
  model: string;
  steps: number;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

export default function AgentPage() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/agent/models`);
        if (!res.ok) throw new Error(`Failed to load models (HTTP ${res.status})`);
        const data = (await res.json()) as ModelOption[];
        if (cancelled) return;
        setModels(data);
        const def = data.find((m) => m.is_default) ?? data[0];
        if (def) setModel(def.id);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load models");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    // History sent to the stateless turn = all prior user messages.
    const history = messages.filter((m) => m.role === "user").map((m) => m.content);
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    try {
      const res = await fetch(`${API_URL}/agent/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history, model: model || undefined }),
      });
      const data = (await res.json().catch(() => null)) as TurnResponse | null;
      if (!res.ok) {
        const errData = data as { message?: string | string[] } | null;
        let msg = `Request failed (HTTP ${res.status})`;
        if (errData && Array.isArray(errData.message)) msg = errData.message.join(", ");
        else if (errData && typeof errData.message === "string") msg = errData.message;
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: msg, error: true },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data?.answer ?? "(no answer)" },
        ]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }, [input, busy, model, messages]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const clearChat = () => {
    setMessages([]);
    setError(null);
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Agent</h1>
          <p className={styles.subtitle}>
            Chat with the workspace agent — it can read and write files in its
            own folder.
          </p>
        </div>
        <div className={styles.headerActions}>
          <select
            className={styles.modelSelect}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={models.length === 0}
          >
            {models.length === 0 ? (
              <option value="">Loading models…</option>
            ) : (
              models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))
            )}
          </select>
          <button
            className={styles.btnGhost}
            onClick={clearChat}
            disabled={messages.length === 0 || busy}
          >
            Clear
          </button>
        </div>
      </div>

      {error && (
        <div className={styles.bannerError} onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className={styles.thread}>
        {messages.length === 0 && !busy ? (
          <div className={styles.empty}>
            <p className={styles.muted}>
              Ask the agent to do something. Example:{" "}
              <em>&quot;Create a file called note.txt in my folder.&quot;</em>
            </p>
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={`${styles.bubble} ${
                m.role === "user" ? styles.bubbleUser : styles.bubbleAgent
              } ${m.error ? styles.bubbleError : ""}`}
            >
              <div className={styles.bubbleLabel}>
                {m.role === "user" ? "You" : "Agent"}
              </div>
              <div className={styles.bubbleText}>{m.content}</div>
            </div>
          ))
        )}

        {busy && (
          <div className={`${styles.bubble} ${styles.bubbleAgent}`}>
            <div className={styles.bubbleLabel}>Agent</div>
            <div className={styles.typing}>Typing…</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Message the agent…  (Enter to send, Shift+Enter for newline)"
          rows={1}
          disabled={busy}
        />
        <button
          type="submit"
          className={styles.btnPrimary}
          disabled={busy || input.trim() === ""}
        >
          {busy ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
