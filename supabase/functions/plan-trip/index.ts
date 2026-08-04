import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { AgentRouterClient, DEFAULT_AGENTIC_API_BASE_URL } from "npm:@agentrouter/agentrouter@0.1.12";

const DEFAULT_ROUTE = "models.chat.complete.deepseek.mpp";
const DEFAULT_MODEL = "deepseek-v4-flash";

const allowedOrigins = new Set([
  "https://roamly-travel.yigitonen.chatgpt.site",
  "https://yigitonen.github.io",
  "http://localhost",
  "http://127.0.0.1:5173",
  "capacitor://localhost"
]);

const configuredOrigins = (Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
configuredOrigins.forEach((origin) => allowedOrigins.add(origin));

function corsHeaders(request: Request) {
  const origin = request.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://roamly-travel.yigitonen.chatgpt.site",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

function json(body: unknown, request: Request, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json; charset=utf-8" }
  });
}

function parseCompletion(value: string) {
  const cleaned = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("Planner returned invalid JSON");
  return JSON.parse(cleaned.slice(first, last + 1));
}

function validateInput(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("Missing request body");
  const input = value as Record<string, unknown>;
  const destination = String(input.destination || "").trim();
  const startDate = String(input.startDate || "");
  const days = Number(input.days);
  const style = String(input.style || "Dengeli").slice(0, 40);
  const pace = String(input.pace || "Rahat").slice(0, 40);
  const note = String(input.note || "").trim().slice(0, 600);
  if (destination.length < 2 || destination.length > 100) throw new Error("Destination is invalid");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error("Start date is invalid");
  if (!Number.isInteger(days) || days < 1 || days > 10) throw new Error("Days must be between 1 and 10");
  return { destination, startDate, days, style, pace, note };
}

function normalizeTrip(value: unknown, days: number) {
  if (!value || typeof value !== "object") throw new Error("Planner response is empty");
  const trip = value as Record<string, unknown>;
  if (!Array.isArray(trip.days) || trip.days.length !== days) throw new Error("Planner returned the wrong number of days");
  return {
    title: String(trip.title || "").slice(0, 100),
    country: String(trip.country || "").slice(0, 100),
    summary: String(trip.summary || "").slice(0, 360),
    days: trip.days.map((rawDay, dayIndex) => {
      const day = rawDay as Record<string, unknown>;
      if (!Array.isArray(day.stops)) throw new Error("Planner returned an invalid day");
      return {
        id: crypto.randomUUID(),
        date: String(day.date || ""),
        title: String(day.title || `${dayIndex + 1}. gün`).slice(0, 100),
        theme: String(day.theme || "").slice(0, 180),
        stops: day.stops.slice(0, 8).map((rawStop) => {
          const stop = rawStop as Record<string, unknown>;
          return {
            id: crypto.randomUUID(),
            time: String(stop.time || "").slice(0, 5),
            title: String(stop.title || "").slice(0, 120),
            category: String(stop.category || "Durak").slice(0, 40),
            duration: String(stop.duration || "").slice(0, 40),
            notes: String(stop.notes || "").slice(0, 300),
            address: String(stop.address || "").slice(0, 200),
            lat: typeof stop.lat === "number" ? stop.lat : null,
            lng: typeof stop.lng === "number" ? stop.lng : null
          };
        }).filter((stop) => stop.title)
      };
    })
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, request, 405);

  try {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Authentication required" }, request, 401);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_ANON_KEY") || "",
      { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } }
    );
    const token = authHeader.slice("Bearer ".length);
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) return json({ error: "Authentication required" }, request, 401);

    const apiKey = Deno.env.get("AGENTIC_API_KEY");
    if (!apiKey) return json({ error: "AgentRouter is not configured", code: "configuration_missing" }, request, 503);

    const input = validateInput(await request.json());
    const client = new AgentRouterClient({
      apiKey,
      baseUrl: Deno.env.get("AGENTIC_API_BASE_URL") || DEFAULT_AGENTIC_API_BASE_URL,
      timeoutMs: 45_000
    });
    const routeKey = Deno.env.get("AGENTROUTER_ROUTE_KEY") || DEFAULT_ROUTE;
    const model = Deno.env.get("AGENTROUTER_MODEL") || DEFAULT_MODEL;

    const prompt = `Create a practical travel itinerary as strict JSON.\nDestination: ${input.destination}\nStart date: ${input.startDate}\nDays: ${input.days}\nStyle: ${input.style}\nPace: ${input.pace}\nTraveler note: ${input.note || "none"}\n\nReturn only this JSON shape: {"title":"","country":"","summary":"","days":[{"date":"YYYY-MM-DD","title":"","theme":"","stops":[{"time":"HH:MM","title":"","category":"","duration":"","notes":"","address":"","lat":null,"lng":null}]}]}. Use exactly ${input.days} days, chronological dates, 3-6 realistic stops per day, sensible meal times and geography. Never invent bookings, opening-hour guarantees, availability, prices, safety verification, or live conditions. Use Turkish for all traveler-facing text. Keep notes concise and actionable.`;

    await client.catalog.routes.context(routeKey);
    const result = await client.capabilities.execute({
      domain: "models",
      capability: "chat-complete",
      routeKey,
      input: {
        model,
        messages: [
          { role: "system", content: "You are Roamly's itinerary planner. Return valid JSON only." },
          { role: "user", content: prompt }
        ]
      },
      allowFallback: false
    });

    const parsed = parseCompletion(String(result.completionText || ""));
    return json({ trip: normalizeTrip(parsed, input.days), routeKey, creditsCharged: result.creditsCharged ?? null }, request);
  } catch (error) {
    console.error("plan-trip failed", error instanceof Error ? error.message : error);
    return json({ error: error instanceof Error ? error.message : "Plan could not be created" }, request, 500);
  }
});

