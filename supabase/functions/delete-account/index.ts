import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { handleDeleteAccount } from "./handler.js";

// Public account deletion endpoint (in-app button and https://…/delete-account page).
// Requires the caller's own JWT plus {"confirm":"DELETE"}; see handler.js for the order of steps.

const allowedOrigins = new Set([
  "https://roamly-travel.yigitonen.chatgpt.site",
  "roamly://localhost",
  "https://localhost"
]);

(Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .forEach((origin) => allowedOrigins.add(origin));

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
  const localDevelopmentOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
  if (allowedOrigins.has(origin) || localDevelopmentOrigin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body: unknown, request: Request, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), ...extraHeaders, "Content-Type": "application/json; charset=utf-8" }
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, request, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !anonKey || !serviceKey) {
      console.error("delete-account is missing Supabase environment variables");
      return json({ error: "Hesap silme şu anda kullanılamıyor.", code: "not_configured" }, request, 503);
    }

    const authHeader = request.headers.get("Authorization") || "";
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } }, auth: { persistSession: false }
    });
    // The service-role client is only used after the caller's own JWT has been verified.
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

    const { status, body } = await handleDeleteAccount({
      authHeader,
      readBody: () => request.json(),
      authenticate: async (token: string) => {
        const { data, error } = await authClient.auth.getUser(token);
        return { user: data?.user ?? null, error };
      },
      cleanup: async (userId: string) => {
        const { error } = await admin.rpc("delete_account_data", { p_user_id: userId });
        return { error };
      },
      deleteUser: async (userId: string) => {
        const { error } = await admin.auth.admin.deleteUser(userId);
        return { error };
      }
    });
    return json(body, request, status);
  } catch (error) {
    console.error("delete-account failed", error instanceof Error ? error.message : error);
    return json({ error: "Hesap silinemedi. Lütfen tekrar dene.", code: "delete_failed" }, request, 500);
  }
});
