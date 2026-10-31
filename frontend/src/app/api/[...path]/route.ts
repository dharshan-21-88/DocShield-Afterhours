import { NextRequest, NextResponse } from "next/server";

/**
 * Catch-all API proxy to the DocShield engine mini service (port 3002).
 *
 * When the app is reached through the gateway, requests carrying
 * `XTransformPort=3002` are proxied straight to the engine and never hit this
 * route. This handler covers direct access to the Next.js server so the
 * frontend works identically in both setups. It is a transparent pass-through:
 * path, query, method, JSON and multipart bodies are forwarded untouched.
 */

const BACKEND = "http://localhost:3002";

const REQUEST_FORWARD_HEADERS = ["content-type", "accept", "authorization"];
const RESPONSE_FORWARD_HEADERS = [
  "content-type",
  "content-disposition",
  "x-document-sha256",
  "cache-control",
];

async function proxy(
  req: NextRequest,
  params: Promise<{ path?: string[] }>
): Promise<NextResponse> {
  const { path = [] } = await params;
  const incoming = new URL(req.url);
  const target = new URL(`/api/${path.join("/")}`, BACKEND);
  // Preserve every query param except the gateway transform hint itself.
  incoming.searchParams.forEach((value, key) => {
    if (key !== "XTransformPort") target.searchParams.set(key, value);
  });

  const headers = new Headers();
  for (const h of REQUEST_FORWARD_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await req.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "ENGINE_UNREACHABLE",
        message:
          "The DocShield engine did not respond. It may be restarting — try again in a moment.",
      },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers();
  for (const h of RESPONSE_FORWARD_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) responseHeaders.set(h, v);
  }

  const data = await upstream.arrayBuffer();
  return new NextResponse(data, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return proxy(req, ctx.params);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return proxy(req, ctx.params);
}
