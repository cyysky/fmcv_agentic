import { NextRequest, NextResponse } from "next/server";

// The file-view proxy lives on the frontend origin so the browser can open an
// HTML file by link / in a new tab without ever putting the API token in the
// URL. The bearer token is attached server-side instead; the upstream CSP
// `sandbox` + inline headers are passed through untouched.
const BACKEND_BASE = (
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:5555/api"
).replace(/\/+$/, "");

const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN ?? "";

// Headers the backend sets on inline views (and error cases) that matter to
// the browser; anything else (server metadata, proxy internals) is dropped.
const PASSTHROUGH_HEADERS = new Set([
  "content-type",
  "content-disposition",
  "content-length",
  "content-security-policy",
  "x-content-type-options",
  "cache-control",
]);

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const upstream = new URL(`${BACKEND_BASE}/files/view`);
  upstream.search = request.nextUrl.searchParams.toString();

  let backend: Response;
  try {
    backend = await fetch(upstream, {
      headers: API_TOKEN ? { authorization: `Bearer ${API_TOKEN}` } : {},
      redirect: "manual",
    });
  } catch (err) {
    return NextResponse.json(
      { message: `File view proxy unavailable: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  const headers = new Headers();
  backend.headers.forEach((value, key) => {
    if (PASSTHROUGH_HEADERS.has(key)) headers.set(key, value);
  });
  return new Response(backend.body, { status: backend.status, headers });
}
