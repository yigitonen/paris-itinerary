const MAIN_ROUTES = new Set(["home", "trips", "memories", "settings"]);

function cleanTripId(value) {
  const tripId = String(value || "").trim();
  return tripId && tripId.length <= 160 ? tripId : "";
}

export function parseNativeDestination(value) {
  try {
    const url = new URL(String(value || ""));
    const requestedRoute = String(url.searchParams.get("route") || "").toLowerCase();
    let route = MAIN_ROUTES.has(requestedRoute) ? requestedRoute : "home";
    let tripId = cleanTripId(url.searchParams.get("trip") || url.searchParams.get("tripId"));

    if (url.protocol === "roamly:") {
      const host = url.hostname.toLowerCase();
      if (host === "trip") {
        route = "trips";
        tripId ||= cleanTripId(url.pathname.split("/").filter(Boolean)[0]);
      } else if (MAIN_ROUTES.has(host) && !requestedRoute) {
        route = host;
      }
    }

    return { route, tripId };
  } catch {
    return { route: "home", tripId: "" };
  }
}
