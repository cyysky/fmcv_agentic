"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./settings.module.css";
import { apiFetch } from "../../lib/api";


interface ConnectionTest {
  ok: boolean;
  status?: number;
  latencyMs: number;
  model: string;
  message: string;
  /** When the result came from a persisted row probe (after a reload), the
   *  time the probe ran — rendered as a "probed HH:MM" marker. */
  probedAt?: string;
}

interface Connection {
  id: string;
  displayName: string;
  baseUrl: string;
  modelName: string;
  contextLength: number;
  concurrentConnections: number;
  apiKey?: string;
  defaultParameters?: Record<string, unknown> | null;
  models?: string[];
  lastProbeAt?: string | null;
  lastProbeOk?: boolean | null;
  lastProbeStatus?: number | null;
  lastProbeLatencyMs?: number | null;
  lastProbeModel?: string | null;
  lastProbeMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Compact probe metrics, e.g. "HTTP 200 · 42 ms". */
function probeMetrics(result: ConnectionTest): string {
  const parts: string[] = [];
  if (result.status !== undefined) parts.push(`HTTP ${result.status}`);
  parts.push(`${result.latencyMs} ms`);
  return parts.join(" · ");
}

/** True when a result has a structured metrics line worth rendering. Failed
 *  probes that got an upstream answer (status set) keep their metrics too, so
 *  a stale/last-known probe never loses its context. */
function hasMetrics(result: ConnectionTest): boolean {
  return result.status !== undefined || result.ok;
}

/** Compact "probed HH:MM" marker for persisted last-known results. */
function probedLabel(probedAt?: string): string {
  if (!probedAt) return "";
  try {
    const d = new Date(probedAt);
    if (Number.isNaN(d.getTime())) return "";
    return `probed ${d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  } catch {
    return "";
  }
}

/** Human-readable probe summary; latency/status come from structured fields
 *  (the upstream message no longer embeds latency, so metrics never repeat). */
function probeSummary(result: ConnectionTest): string {
  return result.ok
    ? `${result.message} (${probeMetrics(result)})`
    : result.message;
}

const EMPTY_FORM = {
  displayName: "",
  baseUrl: "",
  modelName: "",
  contextLength: "128000",
  concurrentConnections: "",
  apiKey: "",
  defaultParameters: "",
  models: "",
};

export default function SettingsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [clearKey, setClearKey] = useState(false);
  const [formTesting, setFormTesting] = useState(false);
  const [formTestResult, setFormTestResult] = useState<ConnectionTest | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsFetchResult, setModelsFetchResult] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<
    Record<string, { busy: boolean; result: ConnectionTest | null }>
  >({});

  // Persist last-known probe results from the server into the row/replay
  // state so a reload of /settings still shows known health. A fresh in-memory
  // result for a row always wins (e.g. an auto-probe racing a reload), so only
  // rows without a current result are seeded.
  const seedProbeState = (rows: Connection[]) => {
    setTestStates((prev) => {
      const next = { ...prev };
      for (const c of rows) {
        if (!c.lastProbeAt || next[c.id]?.result) continue;
        if (!c.lastProbeOk && !c.lastProbeMessage) continue;
        next[c.id] = {
          busy: false,
          result: {
            ok: !!c.lastProbeOk,
            status: c.lastProbeStatus ?? undefined,
            latencyMs: c.lastProbeLatencyMs ?? 0,
            model: c.lastProbeModel ?? c.modelName,
            message: c.lastProbeMessage ?? "",
            probedAt: c.lastProbeAt,
          },
        };
      }
      return next;
    });
  };

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(`/connections`);
      if (!res.ok) throw new Error(`Failed to load (HTTP ${res.status})`);
      const data = (await res.json()) as Connection[];
      setConnections(data);
      setError(null);
      seedProbeState(data);
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
          seedProbeState(data);
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
    // A result from a previous probe/fetch is stale as soon as the values change.
    setFormTestResult(null);
    setModelsFetchResult(null);
  };

  const resetForm = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setMessage(null);
    setClearKey(false);
    setFormTestResult(null);
    setModelsFetchResult(null);
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
      // Provider model list: one id per line; blank lines are ignored. The
      // list is sent on both create and update so clearing all lines clears
      // the stored list (there's no secret here, unlike apiKey).
      payload.models = form.models
        .split("\n")
        .map((m) => m.trim())
        .filter((m) => m.length > 0);
      // Credential (API key): send only when provided so editing doesn't
      // wipe it — unless the user explicitly asks to clear the stored key.
      if (clearKey) {
        payload.apiKey = "";
      } else if (form.apiKey !== "") {
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

      // Auto-probe on save: when the saved values were never probed in the
      // form, probe the persisted row client-side so latency/status show up
      // without the save ever being blocked by a slow endpoint. The result
      // renders in the row + success banner and is always graceful.
      const probeDraft = formTestResult;
      const savedLabel = editingId ? "Connection updated." : "Connection added.";
      const savedId =
        editingId ??
        (data && typeof data === "object" && "id" in data
          ? String(data.id)
          : null);
      resetForm();
      // resetForm clears the banner state; set it AFTER so the success
      // notice actually renders (state updates are batched into one paint).
      setMessage(savedLabel);
      await load();
      // Re-enable the form while the (best-effort) probe still runs.
      setSaving(false);
      if (savedId && probeDraft === null) {
        setMessage(`${savedLabel} Probing connection…`);
        const probe = await handleTest(savedId);
        if (probe) {
          setMessage(
            probe.ok
              ? `${savedLabel} Probe: ${probeSummary(probe)}`
              : `${savedLabel} Probe unavailable: ${probe.message}`,
          );
        }
      }
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
      apiKey: "",
      defaultParameters: conn.defaultParameters
        ? JSON.stringify(conn.defaultParameters, null, 2)
        : "",
      models: (conn.models ?? []).join("\n"),
    });
    setError(null);
    setMessage(null);
    setClearKey(false);
    // Replay the last probe for this row (if any) so the edit form shows the
    // connection's known health until a probed value changes.
    setFormTestResult(testStates[conn.id]?.result ?? null);
  };

  const handleFormTest = async () => {
    setFormTesting(true);
    setFormTestResult(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        baseUrl: form.baseUrl,
        modelName: form.modelName,
      };
      // Probe the key exactly as entered; blank means "no key for this probe".
      if (form.apiKey !== "") {
        payload.apiKey = form.apiKey;
      }
      const res = await apiFetch(`/connections/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as ConnectionTest | null;
      if (!res.ok) {
        const msg = Array.isArray(data?.message)
          ? data.message.join(", ")
          : data?.message ?? `Test failed (HTTP ${res.status})`;
        throw new Error(msg);
      }
      setFormTestResult(data);
    } catch (err) {
      setFormTestResult({
        ok: false,
        model: form.modelName,
        latencyMs: 0,
        message: err instanceof Error ? err.message : "Test failed",
      });
    } finally {
      setFormTesting(false);
    }
  };

  /** Fetch the provider's model list into the Models textarea. Editing a
   *  connection with its stored base URL untouched and no key re-entered uses
   *  the backend credential; otherwise the posted form values are probed. */
  const handleFetchModels = async () => {
    setFetchingModels(true);
    setModelsFetchResult(null);
    setError(null);
    try {
      const storedRow = editingId
        ? connections.find((c) => c.id === editingId)
        : null;
      const baseUrlUnchanged =
        !!storedRow &&
        storedRow.baseUrl === form.baseUrl.trim().replace(/\/+$/, "");
      let res: Response;
      if (storedRow && baseUrlUnchanged && form.apiKey === "") {
        res = await apiFetch(`/connections/${editingId}/models`, {
          method: "GET",
        });
      } else {
        const payload: Record<string, unknown> = { baseUrl: form.baseUrl };
        if (form.apiKey !== "") payload.apiKey = form.apiKey;
        res = await apiFetch(`/connections/models/fetch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      const data = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            models?: string[];
            message?: string;
            truncated?: boolean;
          }
        | null;
      if (!res.ok) {
        throw new Error(data?.message ?? `Fetch failed (HTTP ${res.status})`);
      }
      if (!data?.ok) {
        throw new Error(data?.message ?? "Fetch failed");
      }
      const ids = data.models ?? [];
      setForm((f) => ({ ...f, models: ids.join("\n") }));
      setModelsFetchResult(
        `${data.message ?? `Fetched ${ids.length} model(s) from the provider.`}${
          data.truncated ? " (capped at 50)" : ""
        }`,
      );
    } catch (err) {
      setModelsFetchResult(
        err instanceof Error ? err.message : "Fetch failed",
      );
    } finally {
      setFetchingModels(false);
    }
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

  const handleTest = async (id: string): Promise<ConnectionTest | null> => {
    setTestStates((prev) => ({ ...prev, [id]: { busy: true, result: null } }));
    setError(null);
    try {
      const res = await apiFetch(`/connections/${id}/test`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as ConnectionTest | null;
      if (!res.ok) {
        throw new Error(
          data?.message ?? `Test failed (HTTP ${res.status})`,
        );
      }
      setTestStates((prev) => ({ ...prev, [id]: { busy: false, result: data } }));
      return data;
    } catch (err) {
      const failed: ConnectionTest = {
        ok: false,
        model: "",
        latencyMs: 0,
        message: err instanceof Error ? err.message : "Test failed",
      };
      setTestStates((prev) => ({
        ...prev,
        [id]: { busy: false, result: failed },
      }));
      return failed;
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
          <span>Models (one per line, optional)</span>
          <textarea
            name="models"
            value={form.models}
            onChange={handleChange}
            placeholder={"gpt-4o\nllama-3.1-70b\nmixtral-8x7b"}
            rows={4}
            className={styles.textarea}
          />
          <button
            type="button"
            className={styles.btnGhost}
            onClick={handleFetchModels}
            disabled={fetchingModels || saving}
            style={{ alignSelf: "flex-start" }}
          >
            {fetchingModels ? "Fetching…" : "Fetch Models"}
          </button>
          {modelsFetchResult && (
            <span className={styles.hint} data-models-fetch-result>
              {modelsFetchResult}
            </span>
          )}
          <span className={styles.hint}>
            Extra model ids this provider exposes. They appear in the agent
            model picker whenever this connection is selected, so non-catalog
            providers are first-class (the connection default stays the model
            name above). Fetch Models reads the provider&apos;s GET
            /models endpoint when available.
          </span>
        </label>

        <div className={styles.field}>
          <span>Credential (API Key)</span>
          <input
            name="apiKey"
            value={form.apiKey}
            onChange={handleChange}
            placeholder={
              clearKey
                ? "Stored key will be removed on save."
                : "sk-... (leave blank on edit to keep existing)"
            }
            type="password"
            autoComplete="off"
            disabled={clearKey}
          />
          {editingId && (
            <>
              <span className={styles.hint}>
                Existing key is preserved when this field is left blank.
              </span>
              <label className={styles.checkbox} htmlFor="clearStoredKey">
                <input
                  id="clearStoredKey"
                  type="checkbox"
                  name="clearKey"
                  checked={clearKey}
                  onChange={(e) => {
                    setClearKey(e.target.checked);
                    setFormTestResult(null);
                  }}
                />
                Clear stored API key
              </label>
            </>
          )}
        </div>

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
          <button
            type="button"
            className={styles.btnGhost}
            onClick={handleFormTest}
            disabled={formTesting || saving}
          >
            {formTesting ? "Testing…" : "Test Connection"}
          </button>
          <button type="submit" className={styles.btnPrimary} disabled={saving}>
            {saving
              ? "Saving…"
              : editingId
                ? "Save Changes"
                : "Add Connection"}
          </button>
        </div>
        {formTestResult && (
          <div
            data-form-test-result="true"
            className={`${styles.testResult} ${
              formTestResult.ok ? styles.testOk : styles.testErr
            }`}
            aria-live="polite"
          >
            <div>{formTestResult.message}</div>
            {hasMetrics(formTestResult) && (
              <div className={styles.testDetail}>
                {probeMetrics(formTestResult)}
              </div>
            )}
          </div>
        )}
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
                  {testStates[c.id]?.result && (
                    <div
                      className={`${styles.testResult} ${
                        testStates[c.id]!.result!.ok
                          ? styles.testOk
                          : styles.testErr
                      }`}
                      aria-live="polite"
                    >
                      <div>{testStates[c.id]!.result!.message}</div>
                      {hasMetrics(testStates[c.id]!.result!) && (
                        <div className={styles.testDetail}>
                          {probeMetrics(testStates[c.id]!.result!)}
                          {probedLabel(testStates[c.id]!.result!.probedAt) &&
                            ` · ${probedLabel(testStates[c.id]!.result!.probedAt)}`}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className={styles.listActions}>
                  <button
                    className={styles.btnGhost}
                    disabled={testStates[c.id]?.busy}
                    onClick={() => handleTest(c.id)}
                  >
                    {testStates[c.id]?.busy ? "Testing…" : "Test"}
                  </button>
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
