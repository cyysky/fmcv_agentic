"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./settings.module.css";
import { apiFetch } from "../../lib/api";


interface Connection {
  id: string;
  displayName: string;
  baseUrl: string;
  modelName: string;
  contextLength: number;
  concurrentConnections: number;
  apiKey?: string;
  defaultParameters?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_FORM = {
  displayName: "",
  baseUrl: "",
  modelName: "",
  contextLength: "128000",
  concurrentConnections: "",
  apiKey: "",
  defaultParameters: "",
};

export default function SettingsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/connections`);
      if (!res.ok) throw new Error(`Failed to load (HTTP ${res.status})`);
      const data = (await res.json()) as Connection[];
      setConnections(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load connections");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch: state changes happen after async boundaries so React's
    // "no synchronous setState in effects" rule stays happy.
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/connections`);
        if (!res.ok) throw new Error(`Failed to load (HTTP ${res.status})`);
        const data = (await res.json()) as Connection[];
        if (!cancelled) {
          setConnections(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load connections");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  };

  const resetForm = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setMessage(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const payload: Record<string, unknown> = {
        displayName: form.displayName,
        baseUrl: form.baseUrl,
        modelName: form.modelName,
        contextLength: Number(form.contextLength),
      };
      if (form.concurrentConnections !== "") {
        payload.concurrentConnections = Number(form.concurrentConnections);
      }
      // Credential (API key): only send when provided so editing doesn't wipe it.
      if (form.apiKey !== "") {
        payload.apiKey = form.apiKey;
      }
      // Default parameters: parse JSON textarea into an object.
      if (form.defaultParameters.trim() !== "") {
        try {
          payload.defaultParameters = JSON.parse(form.defaultParameters);
        } catch {
          throw new Error(
            "Default Parameters must be valid JSON (e.g. {\"temperature\": 0.7})",
          );
        }
      }

      const path = editingId
        ? `/connections/${editingId}`
        : `/connections`;
      // For PATCH we omit concurrentConnections when blank to preserve it.
      const method = editingId ? "PATCH" : "POST";
      let body: Record<string, unknown> = payload;
      if (editingId) {
        const { concurrentConnections: _preserved, ...rest } = payload;
        void _preserved; // omitted on PATCH so the stored value is preserved
        body = rest;
      }

      const res = await apiFetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          Array.isArray(data?.message)
            ? data.message.join(", ")
            : data?.message ?? "Request failed";
        throw new Error(msg);
      }

      setMessage(editingId ? "Connection updated." : "Connection added.");
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (conn: Connection) => {
    setEditingId(conn.id);
    setForm({
      displayName: conn.displayName,
      baseUrl: conn.baseUrl,
      modelName: conn.modelName,
      contextLength: String(conn.contextLength),
      concurrentConnections: String(conn.concurrentConnections),
      apiKey: conn.apiKey ?? "",
      defaultParameters: conn.defaultParameters
        ? JSON.stringify(conn.defaultParameters, null, 2)
        : "",
    });
    setError(null);
    setMessage(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this connection?")) return;
    try {
      const res = await apiFetch(`/connections/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      if (editingId === id) resetForm();
      setMessage("Connection deleted.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  return (
    <div className={styles.container}>
      <h1 className={styles.title}>Settings</h1>
      <p className={styles.subtitle}>
        Manage OpenAI-compatible API connections.
      </p>

      {error && (
        <div className={styles.bannerError} onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {message && (
        <div className={styles.bannerOk} onClick={() => setMessage(null)}>
          {message}
        </div>
      )}

      <form className={styles.card} onSubmit={handleSubmit}>
        <h2>{editingId ? "Edit Connection" : "Add Connection"}</h2>

        <label className={styles.field}>
          <span>Display Name</span>
          <input
            name="displayName"
            value={form.displayName}
            onChange={handleChange}
            placeholder="e.g. Local Ollama"
            required
          />
        </label>

        <label className={styles.field}>
          <span>Base URL</span>
          <input
            name="baseUrl"
            value={form.baseUrl}
            onChange={handleChange}
            placeholder="https://api.openai.com/v1"
            required
            type="url"
          />
        </label>

        <label className={styles.field}>
          <span>Model Name</span>
          <input
            name="modelName"
            value={form.modelName}
            onChange={handleChange}
            placeholder="e.g. gpt-4o"
            required
          />
        </label>

        <label className={styles.field}>
          <span>Credential (API Key)</span>
          <input
            name="apiKey"
            value={form.apiKey}
            onChange={handleChange}
            placeholder="sk-... (leave blank on edit to keep existing)"
            type="password"
            autoComplete="off"
          />
        </label>

        <label className={styles.field}>
          <span>Default Parameters (JSON)</span>
          <textarea
            name="defaultParameters"
            value={form.defaultParameters}
            onChange={handleChange}
            placeholder='{"temperature": 0.7, "max_tokens": 4096}'
            rows={4}
            className={styles.textarea}
          />
        </label>

        <div className={styles.row}>
          <label className={styles.field}>
            <span>Context Length</span>
            <input
              name="contextLength"
              value={form.contextLength}
              onChange={handleChange}
              placeholder="128000"
              required
              type="number"
              min={1}
            />
          </label>

          <label className={styles.field}>
            <span>Concurrent Connections</span>
            <input
              name="concurrentConnections"
              value={form.concurrentConnections}
              onChange={handleChange}
              placeholder="10 (default)"
              type="number"
              min={1}
            />
          </label>
        </div>

        <div className={styles.actions}>
          {editingId && (
            <button
              type="button"
              className={styles.btnGhost}
              onClick={resetForm}
            >
              Cancel
            </button>
          )}
          <button type="submit" className={styles.btnPrimary} disabled={saving}>
            {saving
              ? "Saving…"
              : editingId
                ? "Save Changes"
                : "Add Connection"}
          </button>
        </div>
      </form>

      <section className={styles.card}>
        <h2>Connections ({connections.length})</h2>
        {loading ? (
          <p className={styles.muted}>Loading…</p>
        ) : connections.length === 0 ? (
          <p className={styles.muted}>No connections yet. Add one above.</p>
        ) : (
          <ul className={styles.list}>
            {connections.map((c) => (
              <li key={c.id} className={styles.listItem}>
                <div className={styles.listBody}>
                  <div className={styles.listTitle}>{c.displayName}</div>
                  <div className={styles.listMeta}>
                    {c.modelName} · {c.baseUrl}
                  </div>
                  <div className={styles.listMeta}>
                    ctx {c.contextLength.toLocaleString()} ·{" "}
                    {c.concurrentConnections} concurrent
                  </div>
                </div>
                <div className={styles.listActions}>
                  <button
                    className={styles.btnGhost}
                    onClick={() => startEdit(c)}
                  >
                    Edit
                  </button>
                  <button
                    className={styles.btnDanger}
                    onClick={() => handleDelete(c.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
