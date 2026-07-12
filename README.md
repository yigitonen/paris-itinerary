# Paris · 2-Day Itinerary — and Tripline

Two pages live here:

- **`index.html`** — the original mobile-friendly, editable Paris itinerary
  (15–17 July 2026). Untouched and safe to use during the trip.
- **`app.html` — Tripline** (working title): the generalization of the Paris page
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
