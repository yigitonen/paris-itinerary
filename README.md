# Roamly

Roamly is a Turkish-first travel workspace for planning a trip, shaping each
day, tracking expenses, connecting with friends, and keeping a private journal.
The map, route tools, nearby discovery, search, budget, and journal all live in
one interface and save to the same trip.

## Product model

- Guest mode works immediately and stores trips on the device.
- Signing in enables private cloud sync through Supabase. Previously opened cloud
  trips remain editable offline and queued changes synchronize after reconnection.
- AI planning runs only through the protected `plan-trip` Supabase Edge
  Function. The Gemini key never enters the browser or native bundle.
- Place autocomplete, place details, and nearby discovery run only through the
  protected `places` Edge Function and need a signed-in account. If a Google
  Places key is not configured, search is unavailable and stops can still be
  entered by hand.
- Friends are real Supabase profiles and connection requests protected by
  row-level security; no fabricated social feed or sample counters are shown.
- When AI is unavailable, Roamly says so and offers a blank editable plan. It
  never presents a canned itinerary as model output.
- Roamly Locals is an honest early-access waitlist until identity, safety,
  support, and marketplace operations are ready.

## Local development

```sh
npm install
npm run dev
npm run build
```

`npm run build:sites` creates the Sites deployment shape under `dist/client`
and `dist/server`. The normal build remains under `dist` for Capacitor.

## Supabase and Gemini

The live schema is defined in
`supabase/migrations/`. It contains private owner-scoped trips, the Locals
waitlist, Friends profiles/connections, and a server-only Places usage ledger,
all protected by grants and row-level security.

AI planning uses Gemini 3.1 Flash Lite. Add a Google AI Studio key as the
`GEMINI_API_KEY` Supabase Edge Function secret. The free tier can be used
without placing a provider key in the client, subject to Google's current
quotas and data-use terms. Use a key whose Google AI Studio project is on the
Free Tier; a paid Prepay project stops serving requests when its credit balance
reaches zero and does not automatically fall back to free usage.

Roamly allows each signed-in user up to three AI plans in a rolling 24-hour
window, with a one-minute cooldown, to protect the shared free allowance.

The planner uses Google Maps grounding to research important museums, local
advice and recurring traveler experience, select real venues, and organize each
day into adjacent neighborhoods before producing a strict Turkish itinerary.
Every Maps-matched stop links to its Google Maps source.
Traveler guidance is stored as a paraphrased recurring pattern, never as a
fabricated quote.

The optional `GEMINI_MODEL` secret can override the default
`gemini-3.1-flash-lite`. Deploy with:

```sh
supabase functions deploy plan-trip
```

For Google Places, enable Places API (New), create a server-restricted key, and
add it as `GOOGLE_PLACES_API_KEY`. Then deploy the protected function:

```sh
supabase secrets set GOOGLE_PLACES_API_KEY=your_server_key
supabase functions deploy places
```

Roamly caps Google Places traffic per signed-in user. The key is optional;
without it, place search and nearby discovery are turned off and stops can
still be entered by hand.

Do not add provider keys to `src/config.js`, `.env` variables exposed by Vite,
or either native project.

## Native iOS and Android

Roamly uses Capacitor 8 with app identifier `com.yigitonen.roamly`.

```sh
npm run mobile:sync
npm run mobile:ios
npm run mobile:android
```

The native projects are in `ios/` and `android/`. Signing, store screenshots,
and physical-device permission testing are tracked in
`STORE_RELEASE_CHECKLIST.md`.

## Route Studio

The Route Studio is built into every trip. It shows the day on a live map,
checks pace and breakfast/lunch/dinner coverage, keeps meals anchored while
optimizing nearby activities, shifts the schedule when running late, searches
nearby places, opens TikTok traveler research, and creates a full-day Google
Maps route. All changes save to the same trip.
