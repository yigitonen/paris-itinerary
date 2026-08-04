# Roamly

Roamly is a Turkish-first travel workspace for planning a trip, shaping each
day, tracking expenses, and keeping a private journal. The main experience is
`index.html`; the deeper map and route-optimisation workspace remains in
`app.html` and opens the same active trip.

## Product model

- Guest mode works immediately and stores trips on the device.
- Signing in enables private cloud sync through Supabase.
- AI planning runs only through the protected `plan-trip` Supabase Edge
  Function. The AgentRouter key never enters the browser or native bundle.
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

## Supabase and AgentRouter

The live schema is defined in
`supabase/migrations/202608040001_core_travel.sql`. It contains private
owner-scoped trips and the Locals waitlist, both protected by row-level
security.

Before using AI planning, add `AGENTIC_API_KEY` as a Supabase Edge Function
secret. Optional secrets are `AGENTIC_API_BASE_URL`,
`AGENTROUTER_ROUTE_KEY`, and `AGENTROUTER_MODEL`. Deploy with:

```sh
supabase functions deploy plan-trip
```

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

## Advanced route studio

The studio supports editable day plans, drag-and-drop stops, walking links,
route optimisation, bookings, memories, recap export, and JSON backup/import.
Changes are saved to the same cloud trip when the user is signed in.
