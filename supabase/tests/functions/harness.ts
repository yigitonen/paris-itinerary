// Test harness for the Edge Functions. Loads the real index.ts modules (real
// @supabase/supabase-js client included) with Deno.serve captured and
// globalThis.fetch replaced by a fake Supabase + provider backend, so nothing
// leaves the machine and every outbound request can be inspected.

// deno-lint-ignore-file no-explicit-any

export const SUPABASE_URL = "https://project.supabase.test";
export const ANON_KEY = "anon-key-for-tests";
export const SERVICE_KEY = "service-role-key-for-tests";
export const VALID_TOKEN = "valid-user-token";
export const USER_ID = "11111111-2222-4333-8444-555555555555";

export interface Recorded {
  method: string;
  url: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

export class FakeBackend {
  calls: Recorded[] = [];
  /** Handler for POST /rest/v1/rpc/reserve_provider_usage. */
  reserve: (params: Record<string, unknown>) => Reply = () => ({ body: { allowed: true, reservation_id: "res-1" } });
  /** Handler for POST /rest/v1/rpc/finish_provider_usage. */
  finish: (params: Record<string, unknown>) => Reply = () => ({ body: true });
  /** Replies for provider calls, consumed in order (Gemini). */
  providerQueue: Reply[] = [];
  /** Fallback provider handler (Google Places). */
  provider: (call: Recorded) => Reply = () => {
    throw new Error("unexpected provider call");
  };

  get(host: string, path?: string) {
    return this.calls.filter((c) => c.host === host && (path === undefined || c.path === path));
  }
  get reserveCalls() {
    return this.calls.filter((c) => c.path === "/rest/v1/rpc/reserve_provider_usage");
  }
  get finishCalls() {
    return this.calls.filter((c) => c.path === "/rest/v1/rpc/finish_provider_usage");
  }
  get authCalls() {
    return this.calls.filter((c) => c.path === "/auth/v1/user");
  }
  /** Calls to anything that is not Supabase: the paid upstream providers. */
  get providerCalls() {
    return this.calls.filter((c) => c.host !== new URL(SUPABASE_URL).host);
  }
}

function respond(reply: Reply): Response {
  if (reply instanceof Error) throw reply;
  return new Response(JSON.stringify("body" in reply ? reply.body : {}), {
    status: reply.status ?? 200,
    headers: { "Content-Type": "application/json", ...(reply.headers ?? {}) }
  });
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => (out[key.toLowerCase()] = value));
  return out;
}

export function installFetch(backend: FakeBackend) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    let body: any = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch { /* keep raw text */ }
    const call: Recorded = {
      method: request.method,
      url: request.url,
      host: url.host,
      path: url.pathname,
      headers: headersToObject(request.headers),
      body
    };
    backend.calls.push(call);

    if (url.host === new URL(SUPABASE_URL).host) {
      if (url.pathname === "/auth/v1/user") {
        const token = (call.headers["authorization"] || "").replace(/^Bearer /, "");
        if (token !== VALID_TOKEN) {
          return respond({ status: 401, body: { code: 401, error_code: "bad_jwt", msg: "invalid JWT: unable to parse or verify signature" } });
        }
        return respond({
          body: {
            id: USER_ID, aud: "authenticated", role: "authenticated", email: "traveler@example.test",
            app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z"
          }
        });
      }
      if (url.pathname === "/rest/v1/rpc/reserve_provider_usage") return respond(backend.reserve(body));
      if (url.pathname === "/rest/v1/rpc/finish_provider_usage") return respond(backend.finish(body));
      throw new Error(`unexpected Supabase request ${request.method} ${url.pathname}`);
    }
    if (url.host === "generativelanguage.googleapis.com") {
      const next = backend.providerQueue.shift();
      if (!next) throw new Error(`unexpected Gemini call to ${url.pathname}`);
      return respond(next);
    }
    return respond(backend.provider(call));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Sets env vars for the duration of fn, restoring the previous values after. */
export async function withEnv<T>(env: Record<string, string | null>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, Deno.env.get(key));
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

export const BASE_ENV: Record<string, string | null> = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
  GEMINI_API_KEY: "gemini-key",
  GEMINI_MODEL: null,
  GOOGLE_PLACES_API_KEY: "places-key",
  GOOGLE_MAPS_API_KEY: null,
  AI_GLOBAL_DAILY_LIMIT: null,
  PLACES_GLOBAL_DAILY_LIMIT: null
};

type Handler = (request: Request) => Response | Promise<Response>;

/** Imports an Edge Function module and returns the handler it passed to Deno.serve. */
export async function loadHandler(moduleUrl: URL): Promise<Handler> {
  const serve = Deno.serve;
  let captured: Handler | undefined;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (...args: any[]) => {
    captured = args.find((arg) => typeof arg === "function");
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve(), ref() {}, unref() {}, addr: {} };
  };
  try {
    await import(moduleUrl.href);
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = serve;
  }
  if (!captured) throw new Error(`${moduleUrl} did not call Deno.serve with a handler`);
  return captured;
}

/** Silences the functions' own console.warn/error output while capturing it. */
export function captureConsole() {
  const logs: string[] = [];
  const { error, warn } = console;
  console.error = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  return {
    logs,
    restore() {
      console.error = error;
      console.warn = warn;
    }
  };
}

export function postJson(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://functions.supabase.test/fn", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

export const authed = { Authorization: `Bearer ${VALID_TOKEN}` };

/**
 * Runs one request against a handler with a fresh fake backend. Returns the
 * response (already read as JSON when possible) and the backend for assertions.
 */
export async function run(
  handler: Handler,
  request: Request,
  configure: (backend: FakeBackend) => void = () => {},
  env: Record<string, string | null> = {}
) {
  const backend = new FakeBackend();
  configure(backend);
  const restoreFetch = installFetch(backend);
  const output = captureConsole();
  try {
    const response = await withEnv({ ...BASE_ENV, ...env }, async () => await handler(request));
    const text = await response.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch { /* not JSON */ }
    return { response, status: response.status, body, backend, logs: output.logs };
  } finally {
    output.restore();
    restoreFetch();
  }
}
