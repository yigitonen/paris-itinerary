# Roamly — social, AI-powered travel companion

`index.html` is now the production-facing Roamly experience: a modern,
mobile-first travel product with a social discovery feed, AI itinerary flow,
day-by-day routes, groups, budget tracking, journal entries, reels, memories,
statistics and offline/PWA support. Everything is local-first and works without
an account for the demo.

`app.html` remains the advanced route workspace. It keeps the original map,
walking directions, editable stops, route optimiser, bookings, memories,
recap-card export, backup/import and Google Maps-list tools. Roamly links to it
from every trip so none of the original functionality is lost.

## Native iOS and Android

Roamly ships as a Capacitor 8 app with the identifier
`com.yigitonen.roamly`. The native projects live in `ios/` and `android/` and
include camera, photo, location, local notification, share sheet, network,
haptics, keyboard, status-bar, splash-screen and deep-link integrations.

```sh
npm install
npm run mobile:sync
npm run mobile:ios      # opens the Xcode project
npm run mobile:android  # opens the Android Studio project
```

The production web bundle is generated in `dist/`; packaged travel imagery is
included so the main experience works on a first offline launch. iOS signing
requires Xcode and an Apple Developer team. Android release builds require Java
21, Android Studio/SDK 36 and a private signing keystore. The remaining store
submission steps are tracked in `STORE_RELEASE_CHECKLIST.md`.

## Run locally

Serve this folder with any static file server and open `index.html`. Service
workers require `localhost` or HTTPS; opening the file directly will still run
the app, except for offline caching.

## Data model and production handoff

- The demo stores trips, expenses and journal entries in `localStorage`.
- The AI planner currently produces deterministic city-aware itineraries in the
  browser so the complete flow can be tested without an API key.
- For a multi-user launch, replace local persistence with the existing Supabase
  project, add row-level security and connect the planner submission to a secure
  server-side model endpoint. Never place an AI or Maps secret in client code.
- `manifest.webmanifest` and `sw.js` make the app installable and cache the app
  shell, packaged photos and route tools for offline use.

## Advanced Paris itinerary

The original route-planning engine now lives in **`app.html`**. It is the
generalization of the Paris page
  into a trip-tracking app — "Strava for vacations". Create a trip with a
  destination, start & end dates and whoever's going (solo, couple, or group);
  each trip gets the Paris-style day-by-day plan (day tabs, stop cards, walking
  legs, map, route optimizer, memories, bookings). While a trip is on, the app
  highlights where you should be right now; once the end date passes it turns
  into a **recap** — days, stops, km walked, places loved, photos — with a
  shareable recap card (PNG). Your existing Paris plan (including edits saved on
  this device) is migrated in automatically as the first trip. Local-first with
  Backup/Import; built as a mobile-first web app so it can later ship to the app
  stores via Capacitor.

## Features
- **Two day tabs** with clean, collapsible stop cards and an optional map.
- **Walking directions** on every leg — one tap opens Google Maps or Apple Maps
  with walking mode already selected.
- **Edit on your phone** — add, remove, reorder and edit stops. Changes are saved
  in your browser (this device), with **Backup / Import** to move them between devices.
- Walking distances/times are estimated live from coordinates, so they update as you edit.
- **Route optimizer** (⋯ menu) — works for **any city**: paste the places from a
  Google Maps list (one per line), set the destination, and get a day-by-day plan:
  places are located automatically (OpenStreetMap, biased to your city), clustered
  into days, and ordered to minimise walking. House rules: every day starts & ends
  at the hotel (located by name, or paste coordinates) and must include a breakfast,
  a lunch and a dinner (lunch no earlier than 12:30, dinner no earlier than 19:30).
  Short on meal spots? Tap **Suggest nearby spots** to get real cafés/bakeries/
  restaurants around your hotel (OpenStreetMap Overpass) and add them with one tap.
  Tag meals inline with `#breakfast` / `#lunch` / `#dinner`, or tap a place's
  category chip to change it.

## Editing tips
- Tap **✏️ Edit** to show the add / reorder / delete controls.
- To set a stop's location, paste a Google/Apple Maps **full** link (it contains the
  coordinates) or type `lat, lng`. Short `maps.app.goo.gl` links won't work.
- **⋯ menu → Backup** downloads your current plan as JSON; **Import** restores it.
- **⋯ menu → Reset** returns to the original plan.

## Hosting
Published with GitHub Pages from this repo's root (`index.html`).
