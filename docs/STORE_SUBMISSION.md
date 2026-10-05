# Roamly 1.0 — Store submission pack

Draft material for App Store Connect and Google Play Console, written from what the code in this
repository does (revision of the `claude/zealous-wozniak-5qd785` branch, 2 October 2026). Anything the repository cannot
decide is marked `TODO(owner): …`. Release steps live in [`STORE_RELEASE_CHECKLIST.md`](../STORE_RELEASE_CHECKLIST.md);
backend runbook in [`OPERATIONS.md`](OPERATIONS.md).

Every listing field below sits in a fenced block `text <id> limit=<max> count=<n>`. Verify the counts (they are checked
as characters, newlines included) with:

```sh
node scripts/check-store-listing.mjs
```

## 0. What the app does (the facts every answer below rests on)

| Topic | What the code does | Where |
| --- | --- | --- |
| Modes | Guest mode needs no account: trips, journal and budget live in `localStorage` (`roamly-guest-v1`), seeded with one example trip (Roma) that starts 14 days after the first launch, so it always reads "YAKLAŞIYOR" for a new guest (an example already saved on a device keeps its dates). Signing in moves them to Supabase. | `src/repository.js`, `src/data.js` |
| Sign-in | Passwordless: e-mail link (PKCE) everywhere, Google OAuth on web and Android. Native iOS hides Google (guideline 4.8) until Sign in with Apple exists. Native callback `roamly://localhost/`. | `src/auth-options.js`, `src/repository.js` |
| AI plans | Signed-in only. After a versioned consent dialog the Edge Function `plan-trip` sends city, start date, day count (1–7), style, pace and the optional note to Google Gemini (model `gemini-3.1-flash-lite`, Google Maps grounding). No e-mail or user id is put in the prompt. Limits per user: 3 successful plans per rolling 24 h, 10 attempts, 1 per minute, 1 at a time; 200 plans per day for everyone. | `supabase/functions/plan-trip`, `src/ai-consent.js`, `supabase/functions/_shared/quota.js` |
| Place search | Signed-in only. Edge Function `places` sends the typed text (plus the trip city), or the coordinates of the day's existing stops, to Google Places (New). 120 successful calls per user per 24 h. | `supabase/functions/places`, `src/places.js` |
| Map and weather | Leaflet loads OpenStreetMap tiles directly from `tile.openstreetmap.org`; Open-Meteo is called directly with the coordinates of the trip's stops and its dates. Neither call carries an account id. | `src/map.js`, `src/weather.js` |
| Reminders | Optional per stop. Native only: local notifications; the OS permission prompt appears the first time a reminder is saved. | `native.js` (`scheduleTripReminder`), `main.js` |
| Social | "Arkadaşlar": signed-in users get a `profiles` row (handle, display name, avatar URL), can search other discoverable profiles (Ayarlar → Profil görünürlüğü turns this off for the user's own profile) and send, accept, decline or remove friend requests. No messaging, no shared trips, no feed. | `src/social.js`, `supabase/migrations/20260804200454_roamly_social_graph.sql` |
| Sharing | "Paylaş" opens the OS share sheet with a text recap (title, dates, day and stop counts, summary). Nothing is uploaded; there are no public trip pages. | `main.js` (`share-trip`), `src/sharing.js` |
| Locals | Pre-launch waitlist (e-mail, city, note) via RPC `join_locals_waitlist`; works for guests too. No marketplace, no payments. | `main.js`, `supabase/migrations/20261002120000_waitlist_join_rpc.sql` |
| External links | Opened in the in-app browser on native (`@capacitor/browser`): Google Maps place and route links, TikTok search links, and the Google Maps source links Gemini returns. There is no address bar. | `native.js`, `src/itinerary.js` |
| Account deletion | In-app (Ayarlar → "Hesabı sil", signed-in only) and web page `/delete-account`; Edge Function `delete-account` removes waitlist rows, then the auth user; all other tables cascade. | `src/account.js`, `supabase/functions/delete-account` |
| Analytics / ads / crash reporting | None. No such SDK in `package.json` (Capacitor plugins, `@supabase/supabase-js`, `leaflet` only), the Android Gradle files (no `google-services.json`, no Firebase) or the iOS Swift package. The server keeps a usage ledger (`provider_usage`: user id, provider, action, status, timestamps — no query text). | repo-wide search |
| Native permissions | Only notifications. No location, camera, photo-library, contacts or microphone code or permission. | section 7 |

## 1. App Store Connect listing draft

Primary language: Turkish (Türkiye). English (U.S.) is optional; see the note under 1.2.
Category suggestion: **Travel** (primary), **Lifestyle** (secondary).
Price: TODO(owner): confirm Free (the code has no in-app purchases, subscriptions or ads).

### 1.1 Turkish (primary)

**Name** (≤30)

```text apple-name-tr limit=30 count=26
Roamly: Seyahat Planlayıcı
```

**Subtitle** (≤30)

```text apple-subtitle-tr limit=30 count=28
Kendi ritminde seyahat planı
```

**Promotional text** (≤170)

```text apple-promo-tr limit=170 count=147
Şehri ve tarihi seç, günlerini kendi ritminde planla. Rotanı haritada gör; bütçeni ve anılarını tek yerde tut. Hesap açmadan hemen başlayabilirsin.
```

**Description** (≤4000)

```text apple-desc-tr limit=4000 count=2028
Roamly, seyahatini baştan sona tek yerde planlamanı sağlar: günlerin, durakların, rotan, bütçen ve anıların.

HESAP AÇMADAN BAŞLA
Uygulamayı ilk açtığında örnek bir seyahat seni bekler. Misafir modunda seyahatlerin, günlük notların ve bütçen yalnızca cihazında durur. Dilersen e-posta bağlantısıyla (şifre yok) hesap açıp planlarını buluta taşıyabilir, cihazlarında kaldığın yerden devam edebilirsin.

GÜNÜNÜ KENDİ RİTMİNDE KUR
• Her gün için durak, saat, kategori, süre ve not ekle; sırayı yukarı aşağı taşı.
• Rota Stüdyosu: günün duraklarını haritada gör, rotayı yakınlığa göre sırala, gecikince tüm saatleri kaydır.
• Kahvaltı, öğle ve akşam yemeği dengesini tek bakışta kontrol et.
• Rezervasyon durumunu ve onay kodunu durağın içinde sakla.
• Tam günü Google Maps'te aç.

YAPAY ZEKÂ İLE PLAN (İSTEĞE BAĞLI)
Şehri, başlangıç tarihini, gün sayısını, seyahat stilini ve temponu seç; Roamly, Google Gemini ve Google Maps verilerinden yararlanarak 7 güne kadar bir plan hazırlasın. Bunun için hesap gerekir ve bir şey gönderilmeden önce sana açık bir izin ekranı gösterilir. İzin vermezsen hiçbir şey gönderilmez; boş bir planla devam edebilirsin. İznini Ayarlar'dan istediğin zaman geri çekebilirsin. Saat, bilet ve kapanış bilgilerini gitmeden önce yeniden kontrol etmeyi unutma.

BÜTÇE, HAVA DURUMU, ANILAR
• Her seyahat için bütçe ve para birimi belirle, harcamalarını ekle, ilerlemeyi gör.
• Seyahat tarihlerin için hava tahminine bak.
• Günlük notlar yaz; hepsi Anılar'da toplanır.
• İstediğin durak için telefon hatırlatıcısı kur.

VERİLERİN SENDE
• Tüm seyahatlerini tek dosyada yedekle ve geri yükle; seyahat özetini paylaş.
• Önceden açtığın planlar internet olmadan da açılır.
• Reklam yok, reklam takibi yok. Roamly cihazının konumuna, kamerana ve fotoğraflarına erişmez.
• Hesabını ve buluttaki tüm verilerini uygulamadan ya da web sayfasından kalıcı olarak silebilirsin.

Not: Giriş yapan kullanıcılar durak eklerken Google Places ile yer arayabilir ve diğer Roamly kullanıcılarına arkadaşlık isteği gönderebilir.
```

**Keywords** (≤100, comma-separated, no spaces after commas). The name and subtitle are indexed already, so their words (seyahat, planı, kendi, ritminde) are left out.

```text apple-keywords-tr limit=100 count=90
gezi,rota,tatil,bütçe,günlük,anı,yapay,zeka,AI,harita,hava,şehir,hatırlatıcı,gezgin,travel
```

**What's New in 1.0** (≤4000)

```text apple-whatsnew-tr limit=4000 count=544
Roamly'nin ilk sürümü.

• Hesap açmadan başla: örnek bir seyahatle keşfet, planların cihazında kalsın.
• Günlerini kendi ritminde kur: duraklar, saatler, notlar, rezervasyon bilgisi.
• Rota Stüdyosu: günün rotasını haritada gör, yakınlığa göre sırala, saatleri kaydır.
• İsteğe bağlı yapay zekâ planı: açık izninle şehir, tarih ve tercihlerinden gün gün plan.
• Bütçe, hava durumu ve yolculuk günlüğü tek yerde.
• Duraklar için telefon hatırlatıcıları, yedekleme ve geri yükleme.
• Hesabını ve verilerini uygulamadan kalıcı olarak silebilirsin.
```

### 1.2 English (U.S.)

The app's interface is Turkish only (every string in `index.html` and `main.js`). The English description therefore says so
in its first paragraph. TODO(owner): decide whether to ship the English listing now, or wait for an English UI; App Review can
reject metadata that implies a language the app does not have.

**Name** (≤30)

```text apple-name-en limit=30 count=20
Roamly: Trip Planner
```

**Subtitle** (≤30)

```text apple-subtitle-en limit=30 count=27
Plan trips at your own pace
```

**Promotional text** (≤170)

```text apple-promo-en limit=170 count=162
Pick a city and dates, then shape each day at your own pace. See your route on the map and keep your budget and memories in one place. No account needed to start.
```

**Description** (≤4000)

```text apple-desc-en limit=4000 count=2010
Roamly lets you plan a trip from start to finish in one place: your days, stops, route, budget and memories. The app's interface is currently in Turkish.

START WITHOUT AN ACCOUNT
An example trip is waiting the first time you open the app. In guest mode your trips, journal notes and budget stay on your device only. If you like, sign in with an email link (no password) to move your plans to the cloud and pick them up on your other devices.

SHAPE EACH DAY YOUR WAY
• Add stops with time, category, duration and notes for every day, and reorder them.
• Route Studio: see the day's stops on a map, sort the route by proximity, and shift all times when you run late.
• Check the balance of breakfast, lunch and dinner at a glance.
• Keep booking status and confirmation codes inside each stop.
• Open the whole day in Google Maps.

AI PLANNING (OPTIONAL)
Choose a city, start date, number of days, travel style and pace, and Roamly prepares a plan of up to 7 days using Google Gemini and Google Maps data. It needs an account, and before anything is sent you see a clear consent screen. If you decline, nothing is sent and you can continue with an empty plan. You can withdraw your consent in Settings at any time. Always re-check opening hours, tickets and closures before you go.

BUDGET, WEATHER, MEMORIES
• Set a budget and currency for each trip, add expenses and watch your progress.
• See the weather forecast for your travel dates.
• Write journal notes; they all gather in Memories.
• Set a phone reminder for any stop.

YOUR DATA STAYS YOURS
• Back up and restore all your trips as a single file, and share a trip recap.
• Plans you have already opened work without an internet connection.
• No ads and no ad tracking. Roamly does not access your device location, camera or photos.
• Delete your account and all cloud data permanently from the app or from the web page.

Note: signed-in users can search places with Google Places when adding a stop and can send friend requests to other Roamly users.
```

**Keywords** (≤100)

```text apple-keywords-en limit=100 count=89
itinerary,route,journal,budget,map,weather,vacation,holiday,AI,travel,guide,city,reminder
```

**What's New in 1.0** (≤4000)

```text apple-whatsnew-en limit=4000 count=565
The first release of Roamly.

• Start without an account: explore with an example trip, and your plans stay on your device.
• Build each day at your own pace: stops, times, notes and booking details.
• Route Studio: see the day's route on a map, sort it by proximity, shift the schedule.
• Optional AI planning: with your explicit consent, a day-by-day plan from your city, dates and preferences.
• Budget, weather and a trip journal in one place.
• Phone reminders for stops, plus backup and restore.
• Delete your account and data permanently from inside the app.
```

### 1.3 Other App Store Connect fields

| Field | Value |
| --- | --- |
| Bundle ID | `com.yigitonen.roamly` (`ios/App/App.xcodeproj`, `capacitor.config.json`) |
| Version / build | `1.0` / `1` (`MARKETING_VERSION`, `CURRENT_PROJECT_VERSION`) |
| Minimum iOS | 15.0 |
| Privacy Policy URL | `https://roamly-travel.yigitonen.chatgpt.site/privacy.html` — TODO(owner): final domain (the host name is a hosting sub-domain; it is also hard-coded in the AI consent dialog in `index.html` and in the CORS allow-lists of the three Edge Functions) |
| Support URL | `https://roamly-travel.yigitonen.chatgpt.site/support.html` — TODO(owner): see finding F5 (the page's only contact channel is a public GitHub issue form) |
| Marketing URL | optional — TODO(owner) |
| Copyright | TODO(owner): developer or company name for "© 2026 …" |
| Seller / developer name | TODO(owner) |
| Support e-mail / review contact | TODO(owner) |
| Sign-in required for review? | No (guest mode); account-only features need a demo mailbox, see section 6 |
| Export compliance | The app only uses HTTPS/TLS through the OS. `Info.plist` now carries `<key>ITSAppUsesNonExemptEncryption</key><false/>`, so App Store Connect does not ask on every upload. TODO(owner): confirm with your own legal reading (standard-encryption exemption). |

## 2. Google Play listing draft

Category: **Travel & Local** → Travel. Tags: Travel planning, Itinerary. Contact e-mail, website and phone: TODO(owner).
Default language Turkish (tr-TR); add English (en-US) only under the same condition as 1.2.

### 2.1 Turkish (tr-TR)

**App name** (≤30)

```text play-title-tr limit=30 count=26
Roamly: Seyahat Planlayıcı
```

**Short description** (≤80)

```text play-short-tr limit=80 count=67
Rotanı, bütçeni ve anılarını tek yerde planla. Hesap açmadan başla.
```

**Full description** (≤4000)

```text play-full-tr limit=4000 count=2028
Roamly, seyahatini baştan sona tek yerde planlamanı sağlar: günlerin, durakların, rotan, bütçen ve anıların.

HESAP AÇMADAN BAŞLA
Uygulamayı ilk açtığında örnek bir seyahat seni bekler. Misafir modunda seyahatlerin, günlük notların ve bütçen yalnızca cihazında durur. Dilersen e-posta bağlantısıyla (şifre yok) hesap açıp planlarını buluta taşıyabilir, cihazlarında kaldığın yerden devam edebilirsin.

GÜNÜNÜ KENDİ RİTMİNDE KUR
• Her gün için durak, saat, kategori, süre ve not ekle; sırayı yukarı aşağı taşı.
• Rota Stüdyosu: günün duraklarını haritada gör, rotayı yakınlığa göre sırala, gecikince tüm saatleri kaydır.
• Kahvaltı, öğle ve akşam yemeği dengesini tek bakışta kontrol et.
• Rezervasyon durumunu ve onay kodunu durağın içinde sakla.
• Tam günü Google Maps'te aç.

YAPAY ZEKÂ İLE PLAN (İSTEĞE BAĞLI)
Şehri, başlangıç tarihini, gün sayısını, seyahat stilini ve temponu seç; Roamly, Google Gemini ve Google Maps verilerinden yararlanarak 7 güne kadar bir plan hazırlasın. Bunun için hesap gerekir ve bir şey gönderilmeden önce sana açık bir izin ekranı gösterilir. İzin vermezsen hiçbir şey gönderilmez; boş bir planla devam edebilirsin. İznini Ayarlar'dan istediğin zaman geri çekebilirsin. Saat, bilet ve kapanış bilgilerini gitmeden önce yeniden kontrol etmeyi unutma.

BÜTÇE, HAVA DURUMU, ANILAR
• Her seyahat için bütçe ve para birimi belirle, harcamalarını ekle, ilerlemeyi gör.
• Seyahat tarihlerin için hava tahminine bak.
• Günlük notlar yaz; hepsi Anılar'da toplanır.
• İstediğin durak için telefon hatırlatıcısı kur.

VERİLERİN SENDE
• Tüm seyahatlerini tek dosyada yedekle ve geri yükle; seyahat özetini paylaş.
• Önceden açtığın planlar internet olmadan da açılır.
• Reklam yok, reklam takibi yok. Roamly cihazının konumuna, kamerana ve fotoğraflarına erişmez.
• Hesabını ve buluttaki tüm verilerini uygulamadan ya da web sayfasından kalıcı olarak silebilirsin.

Not: Giriş yapan kullanıcılar durak eklerken Google Places ile yer arayabilir ve diğer Roamly kullanıcılarına arkadaşlık isteği gönderebilir.
```

**Release notes** (≤500 per language)

```text play-new-tr limit=500 count=168
Roamly'nin ilk sürümü: hesap açmadan başla, günlerini ve rotanı planla, bütçeni ve anılarını tek yerde tut. İsteğe bağlı yapay zekâ planı yalnızca açık izninle çalışır.
```

### 2.2 English (en-US)

**App name** (≤30)

```text play-title-en limit=30 count=20
Roamly: Trip Planner
```

**Short description** (≤80)

```text play-short-en limit=80 count=78
Plan your route, budget and memories in one place. No account needed to start.
```

**Full description** (≤4000)

```text play-full-en limit=4000 count=2010
Roamly lets you plan a trip from start to finish in one place: your days, stops, route, budget and memories. The app's interface is currently in Turkish.

START WITHOUT AN ACCOUNT
An example trip is waiting the first time you open the app. In guest mode your trips, journal notes and budget stay on your device only. If you like, sign in with an email link (no password) to move your plans to the cloud and pick them up on your other devices.

SHAPE EACH DAY YOUR WAY
• Add stops with time, category, duration and notes for every day, and reorder them.
• Route Studio: see the day's stops on a map, sort the route by proximity, and shift all times when you run late.
• Check the balance of breakfast, lunch and dinner at a glance.
• Keep booking status and confirmation codes inside each stop.
• Open the whole day in Google Maps.

AI PLANNING (OPTIONAL)
Choose a city, start date, number of days, travel style and pace, and Roamly prepares a plan of up to 7 days using Google Gemini and Google Maps data. It needs an account, and before anything is sent you see a clear consent screen. If you decline, nothing is sent and you can continue with an empty plan. You can withdraw your consent in Settings at any time. Always re-check opening hours, tickets and closures before you go.

BUDGET, WEATHER, MEMORIES
• Set a budget and currency for each trip, add expenses and watch your progress.
• See the weather forecast for your travel dates.
• Write journal notes; they all gather in Memories.
• Set a phone reminder for any stop.

YOUR DATA STAYS YOURS
• Back up and restore all your trips as a single file, and share a trip recap.
• Plans you have already opened work without an internet connection.
• No ads and no ad tracking. Roamly does not access your device location, camera or photos.
• Delete your account and all cloud data permanently from the app or from the web page.

Note: signed-in users can search places with Google Places when adding a stop and can send friend requests to other Roamly users.
```

**Release notes** (≤500 per language)

```text play-new-en limit=500 count=188
The first release of Roamly: start without an account, plan your days and route, and keep your budget and memories in one place. Optional AI planning works only with your explicit consent.
```

## 3. App Store "App Privacy" (nutrition label) answers

Rule applied (Apple): data counts as *collected* when it leaves the device and the developer or a partner can keep it longer than
needed to serve the request. Guest-mode trips never leave the device and are not declared. "Used to track you": **No** for every
type (no advertising or analytics SDK, no data broker, no data combined with third-party data for ads, no IDFA/IDFV use, no
`NSUserTrackingUsageDescription`, so no App Tracking Transparency prompt). Select **"Data Not Used to Track You"**.

| Data type (Apple category → type) | Collected? | Linked to the user's identity? | Purposes | What and when |
| --- | --- | --- | --- | --- |
| Contact Info → Email Address | Yes | Yes | App Functionality (sign-in link, account). Locals waitlist: TODO(owner) choose **Developer's Advertising or Marketing** or **Other Purposes** — the address is kept to contact people about the pilot | Supabase Auth when signing in; the `locals_waitlist` table when someone joins the waitlist (guests can, without an account) |
| Contact Info → Name | Yes (conservative) | Yes | App Functionality | `profiles.display_name`: Google full name (web/Android), otherwise the part of the e-mail before the `@`; shown to other signed-in users who search for friends. Not collected from guests. TODO(owner): iOS never receives a Google name, so you may omit Name for the iOS-only label if you accept that the derived name is covered by Email Address |
| User Content → Other User Content | Yes | Yes | App Functionality | Signed-in cloud copy of trips: destination, dates, stops, notes, booking details, budget and expenses, journal entries, imported saved places; Locals city and note; the free-text AI note |
| Identifiers → User ID | Yes | Yes | App Functionality | Supabase auth user UUID: owner of every trip, key of the profile, friend connections and the AI/place usage ledger |
| Search History | Yes (conservative) | No | App Functionality | Place-search text typed by signed-in users is forwarded to Google Places by the `places` function. Roamly does not store it (the ledger holds no text) and Google receives only Roamly's server key, so Roamly cannot link it to a person; Google's own retention applies. TODO(owner): confirm you want to declare this rather than treat the forward as real-time service |
| Location (Coarse/Precise) | **No** | — | — | The app never reads device location. Coordinates sent to Google Places and Open-Meteo are those of stops the user already put in a trip, not the user's whereabouts. TODO(owner): confirm this reading; the conservative alternative is *Coarse Location → App Functionality, not linked* |
| Usage Data (Product Interaction, Advertising Data, Other) | **No** | — | — | No analytics, no event logging, no ads |
| Diagnostics (Crash, Performance, Other) | **No** | — | — | No crash or performance SDK; the web/native bundle sends nothing on errors. Server side, Supabase and Edge Function platform logs record request metadata (including IP address) for operating the service; TODO(owner): check the retention settings in the Supabase dashboard and decide whether to declare *Other Diagnostic Data* |
| Financial Info, Health & Fitness, Sensitive Info, Contacts, Photos or Videos, Audio, Browsing History, Purchases, Other Data | **No** | — | — | Budget and expense lines are user-typed trip notes (declared under Other User Content), not payment or account data. The friend profile may carry a Google avatar *URL*; no photo is uploaded |

Notes for the review of this table:

- **Gemini data flow.** Only after the in-app consent dialog (`#aiConsentModal`, `AI_CONSENT_VERSION = 1`, stored in `localStorage`, withdrawable in Ayarlar) does the app call `plan-trip`. Sent to Google Gemini: city, start date, day count, style, pace, note. Not sent: e-mail, user id. Google may keep or use inputs depending on the Gemini API tier (`privacy.html` says so; the README says the free tier is used). On the free tier Google may use inputs to improve its products, which makes Google more than a pure processor. This is why Other User Content stays declared and why section 4 declares sharing conservatively. TODO(owner): re-read the current Gemini API terms for the tier you run in production before submitting.
- **Google Places.** The typed text with the trip city, and the average coordinates of the stops already on the selected day (`dayCenter`, unrounded), go to Google Places through `places`. Guests cannot trigger it.
- **Other third parties without an account id:** OpenStreetMap tile servers (map area and the device IP), Open-Meteo (stop coordinates and trip dates), Supabase (processor of everything cloud-side).
- Locals waitlist answers apply even to people who never create an account, so Email Address is collected from guests who join the list.

## 4. Google Play "Data safety" answers

Data collection and sharing: **"Yes, the app collects or shares required user data types."** Security practices:

| Question | Answer |
| --- | --- |
| Is all user data encrypted in transit? | **Yes** (HTTPS to Supabase and the Edge Functions; Android `usesCleartextTraffic="false"`) |
| Can users request that data be deleted? | **Yes** — in-app (Ayarlar → Hesabı sil) and web URL `https://roamly-travel.yigitonen.chatgpt.site/delete-account` (TODO(owner): final domain) |
| Independent security review | No |
| Committed to the Families Policy | No. `privacy.html` says Roamly is not for children under 13. TODO(owner): Target audience; the code and policy are consistent with 13+ or 18+ |

| Play category → type | Collected | Shared | Optional or required | Purposes | Notes |
| --- | --- | --- | --- | --- | --- |
| Personal info → Email address | Yes | No | Optional (guest mode needs none; required only to sign in or join the waitlist) | App functionality, Account management; waitlist: Communications about the pilot (TODO(owner): confirm) | Processed by Supabase for Roamly |
| Personal info → Name | Yes | No | Optional | App functionality | Google sign-in name or e-mail prefix, shown to other signed-in users in friend search |
| Personal info → User IDs | Yes | No | Optional | App functionality, Account management | Supabase user UUID |
| App activity → Other user-generated content | Yes | **Yes, conservatively** — Google LLC (Gemini) | Optional (AI plan needs an account and consent) | App functionality | Trips, notes, journal, budget; the AI note and trip details are sent to Gemini |
| App activity → In-app search history | Yes | **Yes, conservatively** — Google LLC (Places) | Optional (needs an account) | App functionality | Typed place queries are forwarded; Roamly does not store them |
| Location (approximate or precise) | **No** | — | — | — | No device location is read. Stop coordinates of the user's trip go to Google Places, Open-Meteo. TODO(owner): confirm |
| Financial info, Health and fitness, Messages, Photos and videos, Audio, Files and docs, Calendar, Contacts, Web browsing | **No** | — | — | — | — |
| App info and performance (crash logs, diagnostics, other) | **No** | — | — | — | No SDK. See the server-log note in section 3 |
| Device or other IDs | **No** | — | — | — | None read or sent |

**Service-provider exemption, handled carefully.** Google's form does not count a transfer to a *service provider that processes
the data on the developer's behalf and under its instructions* as "sharing". Two cases here:

1. **Supabase** (database, auth, Edge Functions) is a plain service provider: it stores and processes data for Roamly only.
   Not declared as sharing.
2. **Google Gemini and Google Places** are called by Roamly's server on Roamly's behalf, which fits the exemption on its face.
   The doubt is the Gemini **free tier**: Google's terms for it allow using submitted content to improve Google products
   (`privacy.html` warns about exactly this), which goes beyond acting on Roamly's instructions. Until you have confirmed the
   terms of the tier you will run in production, the conservative answer above ("Shared: yes, Google LLC, App functionality") is the safe one.
   Declaring sharing is never a violation; failing to declare it can be. TODO(owner): confirm the tier and, if you move to a paid tier whose terms
   forbid training on inputs, switch the two "Shared" cells to **No** under the service-provider exemption.

Requests that go straight from the device to a third party (OpenStreetMap tiles, Open-Meteo) carry no account id and no data type on the form
(map area, stop coordinates and dates, plus the device IP that every web request reveals). TODO(owner): confirm that you do not want to list them; the usual position is that you need not, and `privacy.html` already names both services.

## 5. Content rating questionnaires (suggested answers)

Facts: no violence, sexual content, gambling, drug content or profanity written by the app. Itinerary text is produced by
Gemini under a strict JSON schema (titles, notes, venue names) and restaurants may be bars or wine places, but there is no free-form chat.
Users never see other people's trips or journals.

**User-generated content, checked in `src/social.js`, `src/sharing.js`, the social-graph migration:**

- Journals, trips, budgets: private to the owner (row-level security `owner_id = auth.uid()`); never visible to friends.
- Friends: other signed-in users can find a profile by handle or display name unless the user turned off "Profil görünürlüğü" in Ayarlar (`discoverable`, default true); `privacy.html` section "Profil ve arkadaşlar" describes it
  and send a request. A profile shows display name, handle and avatar URL only. There is no messaging, no comments, no shared trips,
  no public profile page. "Paylaş" is the OS share sheet with plain text.
- The only user-authored text other users can see is therefore the display name (derived, not freely edited in the app) and handle.

| Question (IARC for Play, Apple age rating) | Suggested answer | Why |
| --- | --- | --- |
| Violence, blood, horror, sexual content, nudity, profanity, drugs/alcohol/tobacco depiction, gambling, contests | None / No | Nothing of the kind is authored or shown by the app |
| Users can interact with each other | Yes, limited: friend requests between accounts; no chat | Play IARC "Users interact" = yes (not communicating content); Apple "Messaging and Chat" = No |
| User-generated content shown to others | No (profile names only); journals are private | Apple "User-Generated Content" = No. TODO(owner): see finding F2 — Apple review may still ask for report/block for the friend search |
| Shares the user's location with others | No | No location code |
| Unrestricted web access | No (suggested) | No browser UI or address bar; links open fixed services (Google Maps, TikTok search, Gemini's Google Maps source links) in the in-app browser. TODO(owner): the TikTok search link can surface mature user content, so you may prefer to answer "Yes" or to rate 12+/13+ |
| In-app purchases, ads, digital goods | No | None in code |
| Generative AI content | Yes, optional: AI itinerary through Google Gemini, server-side validated schema | Mention if the questionnaire asks |
| Parental controls / age assurance | No | Not implemented |
| Collects personal info, shares location, children | Personal info: yes (e-mail, name). Location: no. Not directed at children under 13 | `privacy.html` |

Resulting rating target: **Apple 4+** (matches the checklist) and **IARC: Everyone / PEGI 3 / USK 0**.
TODO(owner): both are business decisions; the TikTok and friend-search points above are the ones that could raise it (Apple 9+ or 13+, IARC Teen).

## 6. App Review notes (paste into App Store Connect "Notes" and Play "App access")

```text
Roamly works without an account, so you can review almost everything immediately.

1. NO ACCOUNT NEEDED. Open the app: an example trip (Roma) is already there, saved on the device (guest mode).
   Try: Seyahatler > Roma > day tabs, the map, "Yer ara ve ekle", the Bütçe card, Anılar > "Yeni not", Ayarlar (top-right avatar).
   The interface is Turkish.

2. SIGN-IN (only for AI plans, place search suggestions, friends, cloud sync). Passwordless e-mail link:
   Ayarlar > "Hesapla devam et" > enter the demo e-mail > open the link we send > the app opens through roamly:// and signs in.
   Demo mailbox you can read: TODO(owner): create it and write address and password here. It must receive the e-mail link on a device
   the reviewer can use.
   Google sign-in is shown on Android and web. It is intentionally hidden on iOS until Sign in with Apple is added (guideline 4.8).

3. AI CONSENT. Signed in: "Yeni plan" (sparkle button) > fill the form > "AI planını oluştur". A consent dialog appears first, listing exactly
   what is sent to Google Gemini (city, start date, day count, style, pace, note; never e-mail or account id). "Vazgeç" sends nothing and
   "Boş planla başla" creates an empty plan. Consent is stored on the device and can be withdrawn in Ayarlar > "AI planlama izni".
   Limits to know: 3 successful AI plans per account per 24 hours, one per minute.

4. ACCOUNT DELETION. Signed in: Ayarlar > "Hesabı sil" (hidden for guests) > type SİL. Also at https://roamly-travel.yigitonen.chatgpt.site/delete-account
   (TODO(owner): final domain). Please use a throw-away account for this.

5. PERMISSIONS. The only permission the app ever asks for is notifications, and only when you save a reminder on a stop
   (stop form > "Rezervasyon ve hatırlatıcı" > Hatırlatıcı). No camera, photos, location, contacts, microphone or tracking.

6. FRIENDS (Arkadaşlar tab) needs signed-in accounts: TODO(owner): provide a second demo account (or say the tab can be skipped).
   There is no chat and no shared content; only friend requests.

7. "Roamly Locals" in Ayarlar is a pre-launch interest list (e-mail, city, note). There is no marketplace and no payment.

8. No in-app purchases, no ads, no analytics SDKs.

Contact: TODO(owner): name, phone and e-mail for the review team.
```

Pre-submission requirements that App Review will trip over if missing: the migrations and the three Edge Functions are deployed, the
auth redirect allow-list contains `roamly://localhost/` and the `/delete-account` URL (see the "Account deletion" section of the checklist, whose deploy steps are still unchecked),
and the demo mailbox actually receives the sign-in e-mail.

## 7. Permissions justification

Confirmed from `android/app/src/main/AndroidManifest.xml`, the manifests of the Capacitor plugins that Gradle merges in, and `ios/App/App/Info.plist`.

**Android**

| Permission | Declared by | Type | Justification |
| --- | --- | --- | --- |
| `INTERNET` | app manifest | Normal | Supabase, Edge Functions, map tiles, weather, in-app browser |
| `ACCESS_NETWORK_STATE` | app manifest, `@capacitor/network` | Normal | Show the offline notice and resume queued syncs when the connection returns |
| `POST_NOTIFICATIONS` | app manifest, `@capacitor/local-notifications` | Dangerous (runtime, Android 13+) | Stop reminders the user schedules. Requested only when the first reminder is saved (`scheduleTripReminder`). Not used for marketing |
| `VIBRATE` | `@capacitor/haptics` | Normal | Light tap feedback on buttons |
| `RECEIVE_BOOT_COMPLETED` | `@capacitor/local-notifications` | Normal | Re-schedule saved reminders after the phone restarts |
| `WAKE_LOCK` | `@capacitor/local-notifications` | Normal | Deliver a reminder while the device is asleep |

No location, camera, storage, contacts, microphone or phone permission, and no `SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM`.
Consequence for review answers: reminders use an inexact alarm on Android 12+ unless the user grants exact alarms, so they can arrive a few minutes late; do not promise to-the-minute delivery in the listing.
The merged manifest was derived from the sources, not from a built APK (no Android SDK here). TODO(owner): confirm once with Android Studio "Merged Manifest" or `aapt2 dump permissions` on the release `.aab`.
`allowBackup="false"`, `usesCleartextTraffic="false"`; one custom URL scheme `roamly` (sign-in callback and deep links) and a FileProvider that is not exported.

**iOS**

- `Info.plist` has no `NS…UsageDescription` key at all: nothing in the app needs camera, photos, location, microphone, contacts, Bluetooth, Face ID or tracking.
- Local notifications use the system prompt (no `Info.plist` key, no entitlement, no background mode). Shown when the first reminder is saved.
- URL scheme `roamly` (`CFBundleURLTypes`) for the sign-in callback.
- `ios/App/App/PrivacyInfo.xcprivacy` is in the App target (Copy Bundle Resources): no tracking, no tracking domains, the collected data types of section 3, and an empty `NSPrivacyAccessedAPITypes`. Checked against `@capacitor/ios` 8.4.2 and the nine plugins: none uses UserDefaults (Capacitor 8's `KeyValueStore` is file based), file timestamps, boot time, disk space or the active keyboard list, and Capacitor/CapacitorCordova ship their own empty manifests. `Info.plist` has `ITSAppUsesNonExemptEncryption = false`. TODO(owner): run *Product → Archive → Generate Privacy Report* once in Xcode and confirm it lists no missing required-reason API (add a `UserDefaults`/`CA92.1` entry if a plugin that needs it is added later).
- Devices: `TARGETED_DEVICE_FAMILY = "1,2"` (iPhone and iPad), portrait only on iPhone, all orientations on iPad.

## 8. Screenshot plan

### 8.1 Required sizes

| Store | Slot | Pixels | Notes |
| --- | --- | --- | --- |
| App Store | iPhone 6.9" | 1320 × 2868 native, **1290 × 2796** accepted | The script produces 1290 × 2796 (430 × 932 pt at 3×). One of the 6.9" or 6.5" sets is required; confirm the current rule in App Store Connect |
| App Store | iPhone 6.5" (only if no 6.9" set) | 1242 × 2688 or 1284 × 2778 | Not produced; scale the 6.9" set or add a profile in the script |
| App Store | iPad 13" | 2064 × 2752 or **2048 × 2732** | **Required because the project targets iPad** (`TARGETED_DEVICE_FAMILY = "1,2"`). See below |
| Google Play | Phone | **1080 × 1920** (9:16); 2–8 images, each side 320–3840 px | The script produces 1080 × 1920 (360 × 640 dp at 3×) |
| Google Play | Feature graphic | **1024 × 500**, PNG or JPEG, no transparency | Not produced. Suggested: the app mark on the cream `#f4f1e9` background with the TR tagline "Seyahatini kendi ritminde planla" |
| Google Play | App icon | 512 × 512 PNG | From `icons/` / `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` (1024 px) |
| Google Play | 7" / 10" tablet | optional | Needed only to be featured on large screens |

**iPad.** The project ships for iPad (`TARGETED_DEVICE_FAMILY = "1,2"`) and the trip detail layout was fixed for 768–1366 pt widths (stop cards no longer overflow; checked with Playwright). If you ship iPad, shoot 2048 × 2732 (`PROFILES=ipad node scripts/store-screenshots.mjs`), and look at them on a real iPad or simulator first. Alternatively set `TARGETED_DEVICE_FAMILY = 1` (iPhone only) and skip iPad screenshots. TODO(owner): confirm iPad for 1.0.

### 8.2 Shot list (eight screens, guest mode, example trip)

Order for the store listing (the first three show in search results): 01, 03, 04, 02, 05, 07, 08, 06. Play accepts at most 8.
Generated by `scripts/store-screenshots.mjs` (see 8.3); the file names carry the stem.

| # | Stem | Screen | Turkish caption (overlay) | English caption |
| --- | --- | --- | --- | --- |
| 1 | `01-bugun` | Bugün: example trip card and the day's first stops | Seyahatini kendi ritminde planla | Plan your trip at your own pace |
| 2 | `02-ai-plan` | "Seyahatini tarif et" form filled (Lizbon, Yeme içme, note) | Şehri ve temponu söyle, planı birlikte çıkaralım | Tell us the city and pace, we shape the plan |
| 3 | `03-rota` | Trip page: day tabs, "Gün tamam" pill, route map with six numbered stops | Günü haritada gör, rotayı düzenle | See the day on a map, tune the route |
| 4 | `04-duraklar` | Day 1 stop list: Kahvaltı, Tarih, Öğle yemeği cards | Kahvaltıdan akşam yemeğine her gün hazır | Breakfast to dinner, every day covered |
| 5 | `05-butce` | Weather card and Bütçe card (EUR 576 of 1.240); falls back to the budget card alone if the forecast is missing | Hava durumu ve bütçen tek bakışta | Weather and budget at a glance |
| 6 | `06-seyahatler` | Seyahatler library | Tüm seyahatlerin tek kütüphanede | All your trips in one library |
| 7 | `07-anilar` | Anılar with one journal note written through the real form | Günün sende bıraktığını sakla | Keep what the day left with you |
| 8 | `08-gizlilik` | Ayarlar: "Gizlilik ve destek" and "AI planlama izni" cards | Reklam takibi yok, konum erişimi yok | No ad tracking, no location access |

Captions must be added in a design tool: the script captures bare app screens. Do not add claims the app does not meet (no "ücretsiz AI" promise: the AI limit is 3 plans per day).

### 8.3 Generating the screenshots

```sh
npm run build
npx vite preview --port 4173            # keep running in a second terminal
npm i --no-save playwright && npx playwright install chromium   # or reuse an existing install (see the script header)
OUT_DIR=./store-screenshots node scripts/store-screenshots.mjs   # PORT, PROFILES, SHOT_TODAY are optional
```

- It drives the real UI in guest mode (no localStorage injection, no faked responses). The one typed-in item is the journal note for shot 7.
- **The example trip starts 14 days after the date the app first runs** (`createDemoTrip`), so it reads "YAKLAŞIYOR" on any date. The script still starts the browser clock a week before the trip begins (`SHOT_TODAY=real` disables this), which keeps the badge and day dates stable.
- Each shot is checked before it is saved: no toast, no loading overlay, no half-open modal, no horizontal overflow, no failed sync label, exact output size.
- Run on 2 October 2026 in a sandbox behind a TLS-inspecting proxy: OpenStreetMap tiles and Open-Meteo loaded for real (the script pins the proxy's CA instead of ignoring certificate errors). Open-Meteo is rate-limited and flaky from shared addresses; when it fails or answers with empty values the script says so and shot 5 starts at the budget card. Because the forecast is requested for August dates relative to the real date, even a successful answer is not a true "next week" forecast. **Re-shoot on a real network and ideally on a simulator/device** (real status bar, safe areas, home indicator), and check shot 7: the Anılar hero image is a fixed Lisbon photo (`styles.css`, `.memory-hero`) over a note about Rome.
- The browser render has no status bar; App Store Connect accepts it, but simulator captures look more authentic.

## 9. Findings: where the code and the existing documents disagree

| # | Finding | Where | Suggested fix |
| --- | --- | --- | --- |
| F2 | `privacy.html` now discloses the friend profile (done) and Ayarlar has an opt-out (done). Still open: the handle is built from the e-mail prefix plus six characters of the user id, and the display name falls back to the e-mail prefix, so a searchable profile can expose it; there is no report or block action for friend requests (App Store guideline 1.2 can apply). | `src/social.js` `profileFromUser`; `privacy.html` | Consider random handles and a block/report action before launch |
| F4 | `STORE_RELEASE_CHECKLIST.md` subtitle "Seyahatini kendi ritminde planla" is 32 characters; the limit is 30. | checklist "Store copy" | Use section 1.1 |
| F5 | The support page's only contact is a *public* GitHub issue form (`github.com/yigitonen/paris-itinerary/issues/new`, which needs a GitHub account), and `privacy.html` sends privacy requests to it. Apple expects a working support contact; privacy requests should not be public. | `support.html`, `privacy.html` | Add a support e-mail address (TODO(owner)) to both pages and the store fields |
| F6 | The checklist item "After wiring the button, mention in-app deletion in `privacy.html`" is stale: `privacy.html` already describes the in-app "Hesabı sil" button. | checklist | Tick it |
| F7 | The checklist lists "grants" under Friends; the code has friend connections only, no trip-sharing grants. | checklist "Completed" | Reword |
| F11 | Android reminders use inexact alarms on 12+ without the exact-alarm permission, so "bildirim zamanında gelir" cannot be promised. | `@capacitor/local-notifications` | Keep the claim out of the listing (it is) |

## 10. TODO(owner) list

1. Developer or company name, copyright line, App Store seller name, review contact name/phone/e-mail.
2. Support e-mail address; update `support.html` and `privacy.html` (F5).
3. Final production domain for the privacy, support and delete-account URLs (and the hard-coded copies in `index.html`, the Edge Functions' CORS lists and the Supabase redirect allow-list).
4. Demo mailbox for App Review (address and password) and, for Friends, a second demo account (section 6).
5. Price tier (Free assumed), territories, release method.
6. Decide the English listing (UI is Turkish only), the Locals waitlist purpose on the label (section 3), and whether to declare Name and Search History.
7. Confirm the Gemini API tier and its data terms; then fix the "Shared" cells of the Data safety form (section 4).
8. Age rating answers and Target audience (section 5), including the TikTok-link judgement.
9. iPad: confirm shipping iPad (section 8.1, layout is fixed); feature graphic; re-shoot screenshots on a real network or device with captions.
10. Decide on the open part of F2 (random handles, block/report).
11. Xcode privacy report (section 7) and confirm the export-compliance answer; Android merged-manifest check (section 7).
12. Deploy the pending migrations and the `delete-account` function, and add the redirect URLs, before review (checklist "Account deletion").
