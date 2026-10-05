import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.112.0";
import { denialResponse, failureReasonFor, quotaPolicy, reservationParams } from "../_shared/quota.js";

const GOOGLE_ROOT = "https://places.googleapis.com/v1";
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

function json(body: unknown, request: Request, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(request), ...extraHeaders, "Content-Type": "application/json; charset=utf-8" } });
}

function number(value: unknown, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function text(value: unknown, max = 160) {
  return String(value || "").trim().slice(0, max);
}

// An upstream (Google) failure. `status` is Google's HTTP status (0 when there was no response) and feeds
// failureReasonFor for the usage ledger; the client never sees it, only what clientFailure() derives.
class PlacesError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// What the client is told about a failed Google call. Fixed bodies only: Google's error text stays in the
// logs. 429 is reserved for the user's own quota (see denialResponse), so an upstream 429 is a 503 here.
function clientFailure(error: PlacesError): { status: number; body: { error: string; code: string } } {
  if (error.status === 429) return { status: 503, body: { error: "Place search is busy right now. Try again shortly.", code: "provider_rate_limited" } };
  if (error.status === 401 || error.status === 403) return { status: 503, body: { error: "Place search is temporarily unavailable.", code: "provider_unavailable" } };
  if (error.status === 504 || error.status === 0) return { status: 504, body: { error: "Place search timed out.", code: "provider_timeout" } };
  return { status: 502, body: { error: "Place search failed upstream.", code: "provider_error" } };
}

async function google(path: string, apiKey: string, body?: unknown, fields = "*") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    let response: Response;
    try {
      response = await fetch(`${GOOGLE_ROOT}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fields
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // DNS, TLS, connection reset: there is no HTTP status (0); the client sees a timeout.
      console.warn("Google Places request could not be sent", error instanceof Error ? error.name : "unknown");
      throw new PlacesError("Google Places is unreachable.", 0);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.warn("Google Places request failed", response.status, String(payload?.error?.message || "").slice(0, 180));
      throw new PlacesError(response.status === 429 ? "Google Places request limit reached." : "Google Places is temporarily unavailable.", response.status);
    }
    return payload;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new PlacesError("Google Places timed out.", 504);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
    if (!apiKey) return json({ error: "Google Places is not configured.", code: "places_not_configured" }, request, 503);

    // Validate first so malformed requests never use up quota, then describe the one provider call.
    let call: { path: string; body?: unknown; fields: string; respond: (payload: Record<string, unknown>) => unknown };
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
      call = {
        path: "/places:autocomplete",
        body: requestBody,
        fields: "suggestions.placePrediction.placeId,suggestions.placePrediction.text",
        respond: (payload) => ({
          suggestions: ((payload.suggestions || []) as Array<Record<string, unknown>>).map((item) => {
            const prediction = (item.placePrediction || {}) as Record<string, unknown>;
            const predictionText = (prediction.text || {}) as Record<string, unknown>;
            return { id: prediction.placeId, name: predictionText.text, provider: "google" };
          })
        })
      };
    } else if (action === "details") {
      const placeId = text(body.placeId, 220);
      if (!placeId) return json({ error: "Place id is required." }, request, 400);
      call = {
        path: `/places/${encodeURIComponent(placeId)}?languageCode=tr`,
        fields: "id,displayName,formattedAddress,location,primaryType,rating,userRatingCount,googleMapsUri",
        respond: (payload) => ({ place: normalizedPlace(payload) })
      };
    } else {
      const lat = number(body.lat, -90, 90);
      const lng = number(body.lng, -180, 180);
      if (lat === null || lng === null) return json({ error: "Location is required." }, request, 400);
      const category = text(body.category, 30);
      const typeMap: Record<string, string[]> = {
        breakfast: ["breakfast_restaurant", "cafe"], lunch: ["restaurant"], dinner: ["restaurant"], cafe: ["cafe"], attractions: ["tourist_attraction", "museum"]
      };
      if (!typeMap[category]) return json({ error: "Unknown nearby category." }, request, 400);
      call = {
        path: "/places:searchNearby",
        body: {
          includedTypes: typeMap[category],
          maxResultCount: Math.min(20, Math.max(1, Number(body.limit) || 8)),
          languageCode: "tr",
          locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: Math.min(10_000, Math.max(100, Number(body.radiusMeters) || 1_500)) } }
        },
        fields: "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.googleMapsUri",
        respond: (payload) => ({ places: ((payload.places || []) as Array<Record<string, unknown>>).map(normalizedPlace) })
      };
    }

    // Reserve the quota slot atomically before the paid Google call. The RPC runs with
    // the service role: clients have no access to the usage ledger.
    if (!serviceKey) return json({ error: "Place search limits cannot be checked right now.", code: "quota_unavailable" }, request, 503);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: reservation, error: reserveError } = await admin.rpc("reserve_provider_usage",
      reservationParams(userData.user.id, "google_places", action, quotaPolicy("google_places", Deno.env.toObject())));
    if (reserveError || !reservation) {
      console.error("places quota reservation failed", reserveError?.message || "empty response");
      return json({ error: "Place search limits cannot be checked right now.", code: "quota_unavailable" }, request, 503);
    }
    if (!reservation.allowed) {
      const denied = denialResponse("google_places", { allowed: false, reason: reservation.reason, retryAfterSeconds: reservation.retry_after_seconds });
      return json(denied.body, request, denied.status, denied.headers);
    }
    const reservationId = String(reservation.reservation_id);
    // Every reservation is settled exactly once: a successful Google response counts, anything else is recorded as a failure.
    const finish = async (succeeded: boolean, failureReason?: string) => {
      const { error: finishError } = await admin.rpc("finish_provider_usage", {
        p_reservation_id: reservationId,
        p_succeeded: succeeded,
        p_failure_reason: failureReason ?? null
      });
      if (finishError) console.error("places usage could not be settled", finishError.message);
    };

    try {
      const payload = await google(call.path, apiKey, call.body, call.fields);
      const result = call.respond(payload);
      await finish(true);
      return json(result, request);
    } catch (providerError) {
      await finish(false, failureReasonFor(providerError));
      if (providerError instanceof PlacesError) {
        const failure = clientFailure(providerError);
        return json(failure.body, request, failure.status);
      }
      throw providerError;
    }
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Place search failed." }, request, 500);
  }
});
