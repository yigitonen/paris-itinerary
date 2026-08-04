import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { interactionSources, interactionText, matchPlaceSource, mergeSources } from "./gemini.js";
import { optimizeDayStops } from "./route.js";

const DEFAULT_MODEL = "gemini-2.5-flash";
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

const allowedOrigins = new Set([
  "https://roamly-travel.yigitonen.chatgpt.site",
  "https://yigitonen.github.io",
  "http://localhost",
  "http://127.0.0.1:5173",
  "capacitor://localhost"
]);

(Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .forEach((origin) => allowedOrigins.add(origin));

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

function numberValue(value: unknown, minimum: number, maximum: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function normalizeTrip(value: unknown, input: ReturnType<typeof validateInput>, mapSources: Array<Record<string, string>>) {
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
        const source = matchPlaceSource(stop, mapSources);
        const lat = numberValue(stop.lat, -90, 90);
        const lng = numberValue(stop.lng, -180, 180);
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
          address: String(stop.address || "").slice(0, 200),
          lat: lat !== null && lng !== null ? lat : null,
          lng: lat !== null && lng !== null ? lng : null,
          placeId: "",
          rating: null,
          reviewCount: null,
          verified: Boolean(source),
          mapsSourceName: source?.title || "",
          mapsSourceUrl: source?.url || ""
        };
      }).filter((stop) => stop.title);
      if (stops.length < 3) throw new Error("Planner returned too few stops for a day");
      return {
        id: crypto.randomUUID(),
        date: addDays(input.startDate, dayIndex),
        title: String(day.title || `${dayIndex + 1}. gün`).slice(0, 100),
        theme: String(day.theme || "").slice(0, 180),
        stops: optimizeDayStops(stops)
      };
    })
  };
}

class GeminiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function geminiRequest(path: string, apiKey: string, body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${API_ROOT}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerMessage = String(payload?.error?.message || "");
      const message = response.status === 429
        ? "Yapay zekâ kotası şu anda kullanılamıyor. Daha sonra yeniden dene."
        : response.status === 403
          ? "Gemini anahtarı bu istek için yetkili değil."
          : response.status === 400
            ? "Gemini gezi isteğini kabul etmedi."
            : "Gemini şu anda yanıt veremiyor.";
      console.warn("Gemini request failed", response.status, providerMessage.slice(0, 180));
      throw new GeminiError(message, response.status);
    }
    return payload;
  } catch (error) {
    if (error instanceof GeminiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw new GeminiError("AI planlama zaman aşımına uğradı.", 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function finalSchema(days: number) {
  const stop = {
    type: "object",
    additionalProperties: false,
    required: ["time", "title", "query", "mapSourceName", "category", "duration", "notes", "why", "travelerNote", "importance", "address"],
    properties: {
      time: { type: "string", description: "24-hour HH:MM" },
      title: { type: "string" },
      query: { type: "string" },
      mapSourceName: { type: "string", description: "Exact matching name from the supplied Google Maps sources, or empty only when no source exists" },
      category: { type: "string" },
      duration: { type: "string" },
      notes: { type: "string" },
      why: { type: "string" },
      travelerNote: { type: "string" },
      importance: { type: "string", enum: ["must-see", "local", "optional"] },
      address: { type: "string" }
    }
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "country", "summary", "days"],
    properties: {
      title: { type: "string" },
      country: { type: "string" },
      summary: { type: "string" },
      days: {
        type: "array",
        minItems: days,
        maxItems: days,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "theme", "stops"],
          properties: {
            title: { type: "string" },
            theme: { type: "string" },
            stops: { type: "array", minItems: 3, maxItems: 5, items: stop }
          }
        }
      }
    }
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

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return json({ error: "Gemini is not configured", code: "configuration_missing" }, request, 503);

    const input = validateInput(await request.json());
    const model = Deno.env.get("GEMINI_MODEL") || DEFAULT_MODEL;

    const researchPrompt = `Research ${input.destination} for an evidence-led trip plan. Answer in Turkish. Cover: official tourism guidance; essential museums and cultural landmarks; reservation or closure caveats; respected local recommendations; neighborhood geography; and recurring traveler advice or common complaints found across credible discussions. Prefer official tourism and museum sources for facts. Clearly distinguish facts from recurring opinions. Never invent or quote an individual review. Keep it under 1,200 words.`;
    const researchResponse = await geminiRequest("/interactions", apiKey, {
      model,
      input: researchPrompt,
      tools: [{ type: "google_search" }]
    });
    const researchText = interactionText(researchResponse);
    const searchSources = interactionSources(researchResponse, "url_citation");
    if (researchText.length < 80 || !searchSources.length) throw new Error("Destination research returned no usable evidence");

    const mapsPrompt = `Create an English planning brief for an optimized ${input.days}-day itinerary in ${input.destination}, starting ${input.startDate}. Traveler style: ${input.style}. Pace: ${input.pace}. Special note: ${input.note || "none"}.

Use Google Maps grounding for every named venue. Select 3-5 stops per day and group each day into one or two adjacent neighborhoods. Minimize backtracking and city crisscrossing. Preserve realistic morning, lunch/rest, afternoon, and evening timing. Include the essential museums or landmarks that genuinely matter, but no more than one major museum per day unless requested. Balance them with strong local places. For each stop, give the exact Google Maps place name, neighborhood, sensible duration, why it belongs, and only recurring review advice or caveats supported by Maps data. Never invent a review or quote a reviewer. Do not guarantee opening hours, tickets, prices, or availability. Return a concise day-by-day planning brief, not JSON.

Independent destination research to consider:
${researchText.slice(0, 12_000)}`;
    const mapsResponse = await geminiRequest("/interactions", apiKey, {
      model,
      input: mapsPrompt,
      tools: [{ type: "google_maps" }]
    });
    const mapsText = interactionText(mapsResponse);
    const mapSources = interactionSources(mapsResponse, "place_citation");
    if (mapsText.length < 80 || !mapSources.length) throw new Error("Google Maps could not ground the route");

    const sourceNames = mapSources.map((source) => `- ${source.title}`).join("\n");
    const finalPrompt = `Turn the grounded material below into Roamly's final itinerary JSON. All traveler-facing content must be natural Turkish. Preserve the exact day and stop order from the Google Maps planning brief because that order is already geographically optimized.

Trip: ${input.destination}, ${input.startDate}, exactly ${input.days} days
Style: ${input.style}
Pace: ${input.pace}
Traveler note: ${input.note || "none"}

Rules:
- Exactly ${input.days} days and 3-5 stops per day.
- Use only venues named in the Google Maps source list below.
- mapSourceName must exactly copy the matching source name. Never invent a source name.
- Keep each day within one or two adjacent neighborhoods and do not reorder into backtracking.
- Include meals/rest when useful, but only if there is a matching Maps source.
- No more than one major museum per day unless the traveler explicitly asked otherwise.
- travelerNote must paraphrase only recurring advice supported by the research or Maps brief. If none exists, use an empty string. Never fabricate or quote a traveler.
- Never claim live opening hours, prices, ticket availability, safety, or weather. In notes, tell the user to recheck time-sensitive details when relevant.
- query should be the exact venue name plus ${input.destination}.

GOOGLE MAPS SOURCE NAMES:
${sourceNames}

GOOGLE MAPS OPTIMIZED BRIEF:
${mapsText.slice(0, 16_000)}

SEARCH-GROUNDED RESEARCH:
${researchText.slice(0, 12_000)}`;
    const finalResponse = await geminiRequest(`/models/${encodeURIComponent(model)}:generateContent`, apiKey, {
      contents: [{ role: "user", parts: [{ text: finalPrompt }] }],
      generationConfig: {
        temperature: 0.15,
        responseMimeType: "application/json",
        responseSchema: finalSchema(input.days)
      }
    });
    const finalText = finalResponse?.candidates?.[0]?.content?.parts?.map((part: Record<string, unknown>) => part.text || "").join("") || "";
    const trip = normalizeTrip(parseCompletion(finalText), input, mapSources);
    const stops = trip.days.flatMap((day) => day.stops);
    const verifiedCount = stops.filter((stop) => stop.verified).length;
    const researchSources = mergeSources(searchSources, mapSources).slice(0, 12);

    return json({
      trip: {
        ...trip,
        researchSummary: "Resmî bilgiler, önemli müzeler, yerel öneriler ve tekrar eden gezgin deneyimleri güncel web ve Google Maps kaynaklarıyla birlikte değerlendirildi.",
        researchSources,
        plannerMeta: {
          provider: model,
          researched: true,
          verifiedPlaces: verifiedCount,
          totalPlaces: stops.length,
          routeOptimized: true,
          routeMethod: "Google Maps grounding",
          timeSensitiveDetailsNeedRecheck: true
        }
      }
    }, request);
  } catch (error) {
    console.error("plan-trip failed", error instanceof Error ? error.message : error);
    const status = error instanceof GeminiError ? error.status : 500;
    return json({ error: error instanceof Error ? error.message : "Plan could not be created" }, request, status);
  }
});
