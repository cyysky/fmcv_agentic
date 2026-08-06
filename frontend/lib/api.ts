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
