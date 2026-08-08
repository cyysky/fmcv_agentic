// Shared API client for browser-side calls (agent + settings pages).
//
// NEXT_PUBLIC_* values are inlined at build time:
// - NEXT_PUBLIC_API_URL: backend origin + /api prefix.
// - NEXT_PUBLIC_API_TOKEN: optional bearer token forwarded when the backend
//   runs with API_TOKEN configured. A token shipped to a browser is not a
//   secret; this is defense-in-depth for dev/LAN deployments, not real auth.

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5555/api";

const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN ?? "";

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (API_TOKEN) headers.set("Authorization", `Bearer ${API_TOKEN}`);
  return fetch(`${API_URL}${path}`, { ...init, headers });
}

/** Build a readable error message from a non-OK API response. */
export async function apiError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = await res.json();
    if (typeof body?.message === "string") detail = body.message;
    else if (Array.isArray(body?.message)) detail = body.message.join("; ");
    else if (typeof body?.error === "string") detail = body.error;
  } catch {
    /* non-JSON error body */
  }
  return `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
}

/** Normalize an unknown thrown value into a displayable string. */
export const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
