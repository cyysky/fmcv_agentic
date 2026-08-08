/**
 * Base-agent LLM model catalog for FMCC Agentic.
 *
 * Configured to mirror the user's `~/.codex/config.toml` VRS provider setup:
 *
 * ```toml
 * model = "ds4-flash"
 * model_provider = "vrs"
 * model_context_window = 131000
 *
 * [model_providers.vrs]
 * name = "VRS"
 * base_url = "http://60.51.17.97:9999/v1"
 * wire_api = "responses"
 * ```
 *
 * We expose two models here — `qwen3.6-35b` and `ds4-flash` — served by the
 * same VRS endpoint. The pattern follows the reference agents:
 * - `reference/pi/packages/ai/src/model-catalog.ts` — a flat catalog of
 *   `Model` specs with stable ids decoupled from the provider wire name.
 * - `reference/pi/packages/agent/src/agent.ts` — a default model + provider
 *   wiring that the agent loop resolves at call time.
 * - a catalog of `ModelSpec` objects with `is_default` / `is_fallback`
 *   flags (mirrors the `mastic_mosti_ocr` research-agent catalog).
 *
 * Each entry keeps `id` (what the UI / sessions store) separate from
 * `provider_model` (the string sent to the upstream completion endpoint),
 * so renaming a provider model never invalidates stored sessions.
 */

export interface ModelSpec {
  /** Stable id used by sessions and the model picker. */
  id: string;
  /** Human-friendly display name. */
  label: string;
  /** The model string sent to the chat completions endpoint. */
  provider_model: string;
  /** Short description shown next to the picker. */
  description: string;
  /** True if this is what new sessions default to. */
  is_default: boolean;
  /** True if this is the fallback used when the primary fails. */
  is_fallback: boolean;
  /** Reasoning / chain-of-thought model (drives temperature handling). */
  reasoning: boolean;
  /** If set, overrides the shared context window for this model. */
  context_window?: number;
}

export const DEFAULT_CONTEXT_WINDOW = 131000;

/** qwen3.6-35b — the general research/agentic workhorse (falls back to ds4). */
const QWEN: ModelSpec = {
  id: 'qwen3.6-35b',
  label: 'Qwen 3.6 35B',
  provider_model: 'qwen3.6-35b',
  description:
    'Qwen 3.6 35B Instruct served by the VRS provider. General agentic ' +
    'workhorse for reasoning, tool use, and long-horizon tasks.',
  is_default: false,
  is_fallback: false,
  reasoning: false,
  context_window: DEFAULT_CONTEXT_WINDOW,
};

/** ds4-flash — the default / fast lane (matches config.toml `model`). */
const DS4_FLASH: ModelSpec = {
  id: 'ds4-flash',
  label: 'DS4 Flash',
  provider_model: 'ds4-flash',
  description:
    'DS4 Flash served by the VRS provider. Default fast lane for ' +
    'everyday agentic work — the same model config.toml uses as its ' +
    'primary.',
  is_default: true,
  is_fallback: true,
  reasoning: false,
  context_window: DEFAULT_CONTEXT_WINDOW,
};

export const MODEL_CATALOG: ModelSpec[] = [QWEN, DS4_FLASH];

/** Resolve a stored model id to its catalog entry. Falls back to the
 *  default model when the id is unknown so existing sessions keep
 *  working across catalog changes. */
export function resolveModel(id: string | null | undefined): ModelSpec {
  if (id) {
    const hit = MODEL_CATALOG.find((m) => m.id === id);
    if (hit) return hit;
  }
  return MODEL_CATALOG.find((m) => m.is_default) ?? MODEL_CATALOG[0];
}

/** Return the model to use when the primary call fails. Returns null
 *  when the failed model was already a fallback (avoids loops). */
export function fallbackFor(spec: ModelSpec): ModelSpec | null {
  if (spec.is_fallback) return null;
  return MODEL_CATALOG.find((m) => m.is_fallback) ?? null;
}

/** Resolve the wire model for an explicit per-turn override. Catalog ids map
 *  to their `provider_model`; any other id (e.g. from a saved connection's
 *  `models` list) is a raw provider model and is used verbatim — it must not
 *  fall back to the catalog default. */
export function resolveWireModel(model: string): string {
  const hit = MODEL_CATALOG.find((m) => m.id === model);
  return hit ? hit.provider_model : model;
}
