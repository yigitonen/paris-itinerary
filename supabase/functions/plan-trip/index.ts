import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { AgentRouterClient, DEFAULT_AGENTIC_API_BASE_URL } from "npm:@agentrouter/agentrouter@0.1.12";
import { optimizeDayStops } from "./route.js";

const DEFAULT_MODEL_ROUTE = "models.chat.complete.deepseek.mpp";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_SEARCH_ROUTE = "search.answer.brave.mpp";
const DEFAULT_PLACES_ROUTE = "geo.places.search.googlemaps.mpp";

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

function addDays(isoDate: string, offset: number) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
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
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new Error("Days must be between 1 and 7");
  return { destination, startDate, days, style, pace, note };
}

function validUrl(value: unknown) {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function collectSources(value: unknown) {
  const sources = new Map<string, { title: string; url: string }>();
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth = 0) => {
    if (depth > 8 || node === null || node === undefined || seen.has(node)) return;
    if (typeof node === "string") {
      for (const match of node.matchAll(/https?:\/\/[^\s\])}>"']+/g)) {
        const url = validUrl(match[0]);
        if (url && !sources.has(url)) sources.set(url, { title: new URL(url).hostname.replace(/^www\./, ""), url });
      }
      return;
    }
    if (typeof node !== "object") return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }
    const object = node as Record<string, unknown>;
    const url = validUrl(object.url || object.link || object.href || object.sourceUrl);
    if (url) {
      const title = String(object.title || object.name || object.label || new URL(url).hostname.replace(/^www\./, "")).slice(0, 140);
      sources.set(url, { title, url });
    }
    Object.values(object).forEach((item) => visit(item, depth + 1));
  };
  visit(value);
  return [...sources.values()].slice(0, 8);
}

function compactProviderResult(value: unknown) {
  const object = value as Record<string, unknown> | null;
  return JSON.stringify(object?.raw || value).slice(0, 16_000);
}

function completionText(value: unknown) {
  const object = value as Record<string, unknown> | null;
  if (typeof object?.completionText === "string") return object.completionText;
  const strings: string[] = [];
  const visit = (node: unknown, depth = 0) => {
    if (depth > 7 || strings.length > 20 || node === null || node === undefined) return;
    if (typeof node === "string") {
      if (node.length > 40) strings.push(node);
      return;
    }
    if (Array.isArray(node)) return node.forEach((item) => visit(item, depth + 1));
    if (typeof node === "object") Object.values(node as Record<string, unknown>).forEach((item) => visit(item, depth + 1));
  };
  visit(value);
  return strings.sort((a, b) => b.length - a.length)[0] || "";
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function placeCoordinates(object: Record<string, unknown>) {
  const location = (object.location || object.position || {}) as Record<string, unknown>;
  const geometry = (object.geometry || {}) as Record<string, unknown>;
  const geometryLocation = (geometry.location || {}) as Record<string, unknown>;
  const lat = numberValue(object.lat ?? object.latitude ?? location.lat ?? location.latitude ?? geometryLocation.lat ?? geometryLocation.latitude);
  const lng = numberValue(object.lng ?? object.lon ?? object.longitude ?? location.lng ?? location.lon ?? location.longitude ?? geometryLocation.lng ?? geometryLocation.lon ?? geometryLocation.longitude);
  return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function normalizeName(value: unknown) {
  return String(value || "").toLocaleLowerCase("tr-TR").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function placeName(object: Record<string, unknown>) {
  const displayName = object.displayName;
  if (displayName && typeof displayName === "object") {
    const text = (displayName as Record<string, unknown>).text;
    if (text) return String(text);
  }
  return String(object.name || object.title || displayName || "");
}

function findBestPlace(value: unknown, expectedName: string) {
  const candidates: Array<Record<string, unknown> & { coordinates: { lat: number; lng: number } }> = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth = 0) => {
    if (depth > 9 || node === null || node === undefined || seen.has(node) || typeof node !== "object") return;
    seen.add(node);
    if (Array.isArray(node)) return node.forEach((item) => visit(item, depth + 1));
    const object = node as Record<string, unknown>;
    const coordinates = placeCoordinates(object);
    const name = placeName(object);
    if (coordinates && name) candidates.push({ ...object, coordinates });
    Object.values(object).forEach((item) => visit(item, depth + 1));
  };
  visit(value);
  const expected = normalizeName(expectedName);
  return candidates.sort((a, b) => {
    const score = (item: Record<string, unknown>) => {
      const name = normalizeName(placeName(item));
      if (name === expected) return 3;
      if (name.includes(expected) || expected.includes(name)) return 2;
      return expected.split(" ").filter((part) => name.includes(part)).length / Math.max(1, expected.split(" ").length);
    };
    return score(b) - score(a);
  })[0] || null;
}

function normalizeTrip(value: unknown, input: ReturnType<typeof validateInput>) {
  if (!value || typeof value !== "object") throw new Error("Planner response is empty");
  const trip = value as Record<string, unknown>;
  if (!Array.isArray(trip.days) || trip.days.length !== input.days) throw new Error("Planner returned the wrong number of days");
  return {
    title: String(trip.title || input.destination).slice(0, 100),
    country: String(trip.country || "").slice(0, 100),
    summary: String(trip.summary || "").slice(0, 360),
    days: trip.days.map((rawDay, dayIndex) => {
      const day = rawDay as Record<string, unknown>;
      if (!Array.isArray(day.stops)) throw new Error("Planner returned an invalid day");
      const stops = day.stops.slice(0, 5).map((rawStop) => {
        const stop = rawStop as Record<string, unknown>;
        const importance = ["must-see", "local", "optional"].includes(String(stop.importance)) ? String(stop.importance) : "optional";
        return {
          id: crypto.randomUUID(),
          time: /^\d{2}:\d{2}$/.test(String(stop.time || "")) ? String(stop.time) : "10:00",
          title: String(stop.title || "").slice(0, 120),
          query: String(stop.query || stop.title || "").slice(0, 180),
          category: String(stop.category || "Durak").slice(0, 40),
          duration: String(stop.duration || "").slice(0, 40),
          notes: String(stop.notes || "").slice(0, 300),
          why: String(stop.why || "").slice(0, 260),
          travelerNote: String(stop.travelerNote || "").slice(0, 260),
          importance,
          address: "",
          lat: null as number | null,
          lng: null as number | null,
          placeId: "",
          rating: null as number | null,
          reviewCount: null as number | null,
          verified: false
        };
      }).filter((stop) => stop.title);
      if (stops.length < 3) throw new Error("Planner returned too few stops for a day");
      return {
        id: crypto.randomUUID(),
        date: addDays(input.startDate, dayIndex),
        title: String(day.title || `${dayIndex + 1}. gün`).slice(0, 100),
        theme: String(day.theme || "").slice(0, 180),
        stops
      };
    })
  };
}

function credits(value: unknown) {
  const amount = numberValue((value as Record<string, unknown> | null)?.creditsCharged);
  return amount || 0;
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index]);
    }
  }));
  return output;
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
      timeoutMs: 60_000
    });
    const modelRoute = Deno.env.get("AGENTROUTER_MODEL_ROUTE_KEY") || DEFAULT_MODEL_ROUTE;
    const model = Deno.env.get("AGENTROUTER_MODEL") || DEFAULT_MODEL;
    const searchRoute = Deno.env.get("AGENTROUTER_SEARCH_ROUTE_KEY") || DEFAULT_SEARCH_ROUTE;
    const placesRoute = Deno.env.get("AGENTROUTER_PLACES_ROUTE_KEY") || DEFAULT_PLACES_ROUTE;
    let totalCredits = 0;

    const researchQuery = `${input.destination} travel planning: official tourism guidance, the most important museums and cultural landmarks, respected local recommendations, recurring traveler advice and common complaints, advance reservation needs, and neighborhood geography. Prefer official museum/tourism sources for facts and reputable travel discussions for recurring visitor patterns. Distinguish facts from opinions. Do not use invented reviews or quotes.`;
    const research = await client.capabilities.execute({
      domain: "search",
      capability: "answer",
      routeKey: searchRoute,
      input: { query: researchQuery, maxResults: 8 },
      allowFallback: false
    });
    totalCredits += credits(research);
    const researchPayload = compactProviderResult(research);
    if (researchPayload.length < 80) throw new Error("Destination research returned no usable evidence");
    const researchSources = collectSources(research);

    const prompt = `Create a culturally meaningful and geographically sensible itinerary from the supplied research.\nDestination: ${input.destination}\nStart date: ${input.startDate}\nDays: ${input.days}\nStyle: ${input.style}\nPace: ${input.pace}\nTraveler note: ${input.note || "none"}\n\nRESEARCH PAYLOAD:\n${researchPayload}\n\nRules:\n- Use exactly ${input.days} days and 3-5 stops per day.\n- Include genuinely important museums or landmarks when appropriate, but no more than one major museum per day unless the traveler requested otherwise.\n- Group each day into one or two adjacent neighborhoods. Do not crisscross the city.\n- Keep morning, lunch, afternoon, and evening timing realistic, including visit duration and rest.\n- Use local advice and recurring traveler feedback only when supported by the research. Paraphrase patterns; never invent or quote an individual review.\n- "why" explains the stop's value. "travelerNote" gives a source-grounded recurring tip or caveat, not promotional copy.\n- "query" must be the exact searchable venue or landmark name plus city.\n- Never guarantee opening hours, tickets, prices, availability, safety, weather, or live conditions. Tell the traveler to recheck time-sensitive details.\n- Write all traveler-facing text in natural Turkish.\n\nReturn JSON only in this shape: {"title":"","country":"","summary":"","days":[{"title":"","theme":"","stops":[{"time":"HH:MM","title":"","query":"","category":"","duration":"","notes":"","why":"","travelerNote":"","importance":"must-see|local|optional"}]}]}`;

    const modelResult = await client.capabilities.execute({
      domain: "models",
      capability: "chat-complete",
      routeKey: modelRoute,
      input: {
        model,
        messages: [
          { role: "system", content: "You are Roamly's evidence-led itinerary editor. Use only the supplied research for destination claims and return valid JSON only." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2
      },
      allowFallback: false
    });
    totalCredits += credits(modelResult);
    const trip = normalizeTrip(parseCompletion(completionText(modelResult)), input);

    const stopEntries = trip.days.flatMap((day, dayIndex) => day.stops.map((stop, stopIndex) => ({ dayIndex, stopIndex, stop })));
    const verifiedStops = await mapLimit(stopEntries, 3, async ({ stop }) => {
      try {
        const placeResult = await client.capabilities.execute({
          domain: "geo",
          capability: "places-search",
          routeKey: placesRoute,
          input: { query: stop.query || `${stop.title}, ${input.destination}` },
          allowFallback: false
        });
        totalCredits += credits(placeResult);
        const place = findBestPlace(placeResult, stop.title);
        if (!place) return stop;
        const address = String(place.formattedAddress || place.formatted_address || place.address || place.vicinity || "").slice(0, 200);
        return {
          ...stop,
          title: String(placeName(place) || stop.title).slice(0, 120),
          address,
          lat: place.coordinates.lat,
          lng: place.coordinates.lng,
          placeId: String(place.placeId || place.place_id || place.id || "").slice(0, 180),
          rating: numberValue(place.rating),
          reviewCount: numberValue(place.userRatingCount || place.user_ratings_total || place.reviewCount || place.reviewsCount),
          verified: true
        };
      } catch (error) {
        console.warn("Place verification skipped", stop.title, error instanceof Error ? error.message : error);
        return stop;
      }
    });

    stopEntries.forEach(({ dayIndex, stopIndex }, index) => {
      trip.days[dayIndex].stops[stopIndex] = verifiedStops[index];
    });
    trip.days = trip.days.map((day) => ({ ...day, stops: optimizeDayStops(day.stops) }));

    const verifiedCount = verifiedStops.filter((stop) => stop.verified).length;
    return json({
      trip: {
        ...trip,
        researchSummary: "Önemli duraklar, yerel öneriler ve tekrar eden gezgin deneyimleri güncel kaynaklardan birlikte değerlendirildi.",
        researchSources,
        plannerMeta: {
          researched: true,
          verifiedPlaces: verifiedCount,
          totalPlaces: verifiedStops.length,
          routeOptimized: true,
          timeSensitiveDetailsNeedRecheck: true
        }
      },
      creditsCharged: totalCredits || null
    }, request);
  } catch (error) {
    console.error("plan-trip failed", error instanceof Error ? error.message : error);
    return json({ error: error instanceof Error ? error.message : "Plan could not be created" }, request, 500);
  }
});
