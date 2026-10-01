import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.0";

const GOOGLE_ROOT = "https://places.googleapis.com/v1";
const DAILY_LIMIT = 120;
const allowedOrigins = new Set(["https://roamly-travel.yigitonen.chatgpt.site", "roamly://localhost", "https://localhost"]);
(Deno.env.get("ALLOWED_ORIGINS") || "").split(",").map((value) => value.trim()).filter(Boolean).forEach((value) => allowedOrigins.add(value));

function cors(request: Request) {
  const origin = request.headers.get("origin") || "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
  if (allowedOrigins.has(origin) || /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body: unknown, request: Request, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(request), "Content-Type": "application/json; charset=utf-8" } });
}

function number(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function text(value: unknown, max = 160) {
  return String(value || "").trim().slice(0, max);
}

async function google(path: string, apiKey: string, body?: unknown, fields = "*") {
  const response = await fetch(`${GOOGLE_ROOT}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fields
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn("Google Places request failed", response.status, String(payload?.error?.message || "").slice(0, 180));
    throw new Error(response.status === 429 ? "Google Places request limit reached." : "Google Places is temporarily unavailable.");
  }
  return payload;
}

function normalizedPlace(place: Record<string, unknown>) {
  const location = (place.location || {}) as Record<string, unknown>;
  const displayName = (place.displayName || {}) as Record<string, unknown>;
  return {
    id: String(place.id || ""),
    name: String(displayName.text || place.name || ""),
    address: String(place.formattedAddress || place.shortFormattedAddress || ""),
    lat: location.latitude ?? null,
    lng: location.longitude ?? null,
    primaryType: String(place.primaryType || "place"),
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? null,
    provider: "google",
    googleMapsUrl: String(place.googleMapsUri || "")
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, request, 405);
  try {
    const authHeader = request.headers.get("authorization") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData.user) return json({ error: "Sign in to search places." }, request, 401);

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = text(body.action, 20);
    if (!["autocomplete", "details", "nearby"].includes(action)) return json({ error: "Unknown place action." }, request, 400);

    const apiKey = Deno.env.get("GOOGLE_PLACES_API_KEY") || Deno.env.get("GOOGLE_MAPS_API_KEY") || "";
    if (!apiKey) return json({ error: "Google Places is not configured; use the OpenStreetMap fallback." }, request, 503);

    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count, error: countError } = await admin.from("place_search_requests").select("id", { count: "exact", head: true }).eq("user_id", userData.user.id).gte("created_at", since);
    if (countError) throw countError;
    if ((count || 0) >= DAILY_LIMIT) return json({ error: "Daily place search limit reached." }, request, 429);
    const { error: usageError } = await admin.from("place_search_requests").insert({ user_id: userData.user.id, action });
    if (usageError) throw usageError;

    if (action === "autocomplete") {
      const query = text(body.query, 120);
      if (query.length < 3) return json({ suggestions: [] }, request);
      const locationBias = (body.locationBias || {}) as Record<string, unknown>;
      const lat = number(locationBias.lat, -90, 90);
      const lng = number(locationBias.lng, -180, 180);
      const sessionToken = text(body.sessionToken, 120);
      const requestBody: Record<string, unknown> = { input: query, languageCode: "tr", includeQueryPredictions: false };
      if (sessionToken) requestBody.sessionToken = sessionToken;
      if (lat !== null && lng !== null) requestBody.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(50_000, Math.max(500, Number(locationBias.radiusMeters) || 25_000)) } };
      const payload = await google("/places:autocomplete", apiKey, requestBody, "suggestions.placePrediction.placeId,suggestions.placePrediction.text");
      const suggestions = (payload.suggestions || []).map((item: Record<string, unknown>) => {
        const prediction = (item.placePrediction || {}) as Record<string, unknown>;
        const predictionText = (prediction.text || {}) as Record<string, unknown>;
        return { id: prediction.placeId, name: predictionText.text, provider: "google" };
      });
      return json({ suggestions }, request);
    }

    if (action === "details") {
      const placeId = text(body.placeId, 220);
      if (!placeId) return json({ error: "Place id is required." }, request, 400);
      const payload = await google(`/places/${encodeURIComponent(placeId)}?languageCode=tr`, apiKey, undefined, "id,displayName,formattedAddress,location,primaryType,rating,userRatingCount,googleMapsUri");
      return json({ place: normalizedPlace(payload) }, request);
    }

    const lat = number(body.lat, -90, 90);
    const lng = number(body.lng, -180, 180);
    if (lat === null || lng === null) return json({ error: "Location is required." }, request, 400);
    const category = text(body.category, 30);
    const typeMap: Record<string, string[]> = {
      breakfast: ["breakfast_restaurant", "cafe"], lunch: ["restaurant"], dinner: ["restaurant"], cafe: ["cafe"], attractions: ["tourist_attraction", "museum"]
    };
    if (!typeMap[category]) return json({ error: "Unknown nearby category." }, request, 400);
    const payload = await google("/places:searchNearby", apiKey, {
      includedTypes: typeMap[category],
      maxResultCount: Math.min(20, Math.max(1, Number(body.limit) || 8)),
      languageCode: "tr",
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(10_000, Math.max(100, Number(body.radiusMeters) || 1_500)) } }
    }, "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.googleMapsUri");
    return json({ places: (payload.places || []).map(normalizedPlace) }, request);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Place search failed." }, request, 500);
  }
});
