"use client";

import { useEffect, useState } from "react";
import styles from "./skills.module.css";
import { apiFetch, apiError, errText } from "../../lib/api";
import { formatTime } from "../../lib/time";

/* ------------------------------- types ---------------------------------- */

interface SkillRow {
  id: string;
  name: string;
  description: string;
  content: string;
  installed: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SkillDraft {
  name: string;
  description: string;
  content: string;
  installed: boolean;
}

const EMPTY_DRAFT: SkillDraft = {
  name: "",
  description: "",
  content: "",
  installed: false,
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/* ------------------------------- helpers -------------------------------- */

function previewLine(content: string): string {
  const first = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first || "(no content yet)";
}

/* ------------------------------ component ------------------------------- */

export default function SkillsPanel() {
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SkillRow | null>(null);
  const [draft, setDraft] = useState<SkillDraft>(EMPTY_DRAFT);
  const [formBusy, setFormBusy] = useState(false);

  const [actionBusyId, setActionBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Load the skill list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const res = await apiFetch("/skills");
        if (!res.ok) throw new Error(await apiError(res));
        const body = (await res.json()) as SkillRow[];
        if (cancelled) return;
        setSkills(body);
      } catch (e) {
        if (cancelled) return;
        setSkills([]);
        setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const refresh = () => setReloadKey((k) => k + 1);

  const openCreate = () => {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setShowForm(true);
  };

  const openEdit = (skill: SkillRow) => {
    setEditing(skill);
    setDraft({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      installed: skill.installed,
    });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
  };

  const patchDraft = (patch: Partial<SkillDraft>) =>
    setDraft((d) => ({ ...d, ...patch }));

  const submitSkill = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = draft.name.trim();
    if (!NAME_RE.test(name)) {
      setError(
        "Skill name must start with a letter or digit and use letters, digits, dash or underscore only (max 64 chars).",
      );
      return;
    }
    if (draft.installed && !draft.content.trim()) {
      setError("A skill must have content before it can be installed.");
      return;
    }
    setFormBusy(true);
    setError(null);
    setNotice(null);
    try {
      const payload: SkillDraft = {
        name,
        description: draft.description.trim(),
        content: draft.content,
        installed: draft.installed,
      };
      const res = editing
        ? await apiFetch(`/skills/${editing.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiFetch("/skills", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (!res.ok) throw new Error(await apiError(res));
      setNotice(
        editing
          ? `Skill "${name}" updated.`
          : `Skill "${name}" ${draft.installed ? "created and installed" : "created"}. Agents can now load it via read_skill when installed.`,
      );
      closeForm();
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setFormBusy(false);
    }
  };

  const toggleInstall = async (skill: SkillRow) => {
    setActionBusyId(skill.id);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(
        `/skills/${skill.id}/${skill.installed ? "uninstall" : "install"}`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(await apiError(res));
      setNotice(
        skill.installed
          ? `Skill "${skill.name}" uninstalled — the record stays, agents stop seeing it.`
          : `Skill "${skill.name}" installed — agents can now use read_skill to load it.`,
      );
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setActionBusyId(null);
    }
  };

  const deleteSkill = async (skill: SkillRow) => {
    setActionBusyId(skill.id);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/skills/${skill.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await apiError(res));
      setNotice(`Skill "${skill.name}" deleted.`);
      setConfirmDeleteId(null);
      if (editing?.id === skill.id) closeForm();
      refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setActionBusyId(null);
    }
  };

  /* ------------------------------ render ------------------------------- */

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Agent Skills</h1>
          <p className={styles.subtitle}>
            Create, install, and manage skills. Installed skills appear in
            every agent turn&apos;s registry — agents load the full
            instructions with the <code>read_skill</code> tool.
          </p>
        </div>
        <div className={styles.headerActions}>
          {!showForm && (
            <button
              className={styles.btnPrimary}
              onClick={openCreate}
              type="button"
            >
              + New Skill
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className={styles.bannerError} role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className={styles.bannerNotice} role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice">
            ×
          </button>
        </div>
      )}

      {showForm && (
        <form className={styles.form} onSubmit={submitSkill}>
          <h2 className={styles.formTitle}>
            {editing ? `Edit skill "${editing.name}"` : "Create a skill"}
          </h2>

          <label className={styles.field}>
            <span>Name (unique, slug-form)</span>
            <input
              value={draft.name}
              onChange={(e) => patchDraft({ name: e.target.value })}
              aria-label="Skill name"
              placeholder="e.g. code-review"
              required
              disabled={!!editing}
            />
          </label>

          <label className={styles.field}>
            <span>Description</span>
            <input
              value={draft.description}
              onChange={(e) => patchDraft({ description: e.target.value })}
              aria-label="Skill description"
              placeholder="One line: what this skill helps agents do"
            />
          </label>

          <label className={styles.field}>
            <span>Instructions (markdown, e.g. a SKILL.md body)</span>
            <textarea
              value={draft.content}
              onChange={(e) => patchDraft({ content: e.target.value })}
              aria-label="Skill instructions"
              placeholder={"# Skill instructions\n\nStep-by-step guidance agents should follow once loaded."}
              rows={7}
            />
          </label>

          <label className={styles.checkRow}>
            <input
              type="checkbox"
              checked={draft.installed}
              aria-label="Install skill"
              onChange={(e) => patchDraft({ installed: e.target.checked })}
            />
            <span>Install now (requires instructions above)</span>
          </label>

          <div className={styles.formActions}>
            <button
              className={styles.btnPrimary}
              type="submit"
              disabled={formBusy}
            >
              {formBusy ? "Saving…" : editing ? "Save changes" : "Create skill"}
            </button>
            <button
              className={styles.btnGhost}
              type="button"
              onClick={closeForm}
              disabled={formBusy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className={styles.muted}>Loading skills…</p>
      ) : skills.length === 0 ? (
        <p className={styles.empty}>
          No skills yet. Create your first skill to give agents a reusable
          capability.
        </p>
      ) : (
        <ul className={styles.list}>
          {skills.map((skill) => (
            <li key={skill.id} className={styles.row} data-name={skill.name}>
              <div className={styles.rowMain}>
                <div className={styles.rowTitleLine}>
                  <span className={styles.skillName}>{skill.name}</span>
                  <span
                    className={
                      skill.installed
                        ? `${styles.pill} ${styles.pillOn}`
                        : `${styles.pill} ${styles.pillOff}`
                    }
                  >
                    {skill.installed ? "Installed" : "Not installed"}
                  </span>
                </div>
                <p className={styles.skillDescription}>
                  {skill.description || "No description"}
                </p>
                <code className={styles.preview}>{previewLine(skill.content)}</code>
                <p className={styles.meta}>
                  Created {formatTime(skill.createdAt)}
                </p>
              </div>
              <div className={styles.rowActions}>
                <button
                  className={
                    skill.installed ? styles.btnGhost : styles.btnPrimary
                  }
                  type="button"
                  disabled={actionBusyId === skill.id}
                  onClick={() => toggleInstall(skill)}
                >
                  {skill.installed ? "Uninstall" : "Install"}
                </button>
                <button
                  className={styles.btnGhost}
                  type="button"
                  onClick={() => openEdit(skill)}
                >
                  Edit
                </button>
                {confirmDeleteId === skill.id ? (
                  <button
                    className={styles.btnDanger}
                    type="button"
                    disabled={actionBusyId === skill.id}
                    onClick={() => deleteSkill(skill)}
                  >
                    Confirm delete
                  </button>
                ) : (
                  <button
                    className={styles.btnDanger}
                    type="button"
                    onClick={() => setConfirmDeleteId(skill.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
