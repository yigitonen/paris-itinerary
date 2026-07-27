# Roamly 1.0 — Store release checklist

## Identity

- App name: **Roamly**
- Bundle ID / application ID: `com.yigitonen.roamly`
- Version: `1.0.0` (`versionCode` / build `1`)
- Primary language: Turkish
- Category: Travel
- Content rating target: 4+ / Everyone

## Store copy

**Subtitle (App Store):** AI seyahat planlayıcın

**Short description (Google Play):** AI ile rotanı planla; grubunla gez, bütçeni ve anılarını tek yerde tut.

**Keywords:** seyahat,rota,gezi,plan,AI,travel,journal,bütçe,arkadaş,anı

**Privacy policy URL:** `https://yigitonen.github.io/paris-itinerary/privacy.html`

**Support URL:** `https://yigitonen.github.io/paris-itinerary/support.html`

## Before signing

- [ ] Install Android Studio with Android SDK 36 and Java 21.
- [ ] Install current Xcode and select the Apple Developer Team.
- [ ] Replace the temporary signing configuration with the production keystore / distribution certificate.
- [ ] Add the production Supabase URL and public anon key through the chosen environment configuration.
- [ ] Deploy the secure AI planning endpoint; never bundle an OpenAI or Maps secret in the app.
- [ ] Complete Apple App Privacy and Google Play Data Safety forms using `privacy.html` as the source of truth.
- [ ] Add real App Store / Play Store screenshots from a physical device or simulator.
- [ ] Test camera, photo picker, location, local notifications, sharing and deep links on physical iOS and Android devices.
- [ ] Run accessibility checks with VoiceOver and TalkBack.
- [ ] Archive a signed iOS build and create an Android App Bundle (`.aab`).

## Data declarations

- Location: used only while the app is in use for route progress and nearby stops.
- Photos/camera: user-initiated memory capture only.
- User content: trips, journal, budget and memories; local-first, cloud only when enabled.
- Contact info: email only when account/cloud sync is enabled.
- Tracking/advertising: none.
