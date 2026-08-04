# Roamly 1.0 — Store release checklist

## Identity

- App name: **Roamly**
- Bundle ID / application ID: `com.yigitonen.roamly`
- Version: `1.0.0` (`versionCode` / build `1`)
- Primary language: Turkish
- Category: Travel
- Content rating target: 4+ / Everyone

## Store copy

**Subtitle (App Store):** Seyahatini kendi ritminde planla

**Short description (Google Play):** Rotanı planla; günlerini, bütçeni ve anılarını tek yerde tut.

**Keywords:** seyahat,rota,gezi,plan,AI,travel,journal,bütçe,anı

**Privacy policy URL:** `https://roamly-travel.yigitonen.chatgpt.site/privacy.html`

**Support URL:** `https://roamly-travel.yigitonen.chatgpt.site/support.html`

## Completed web and backend work

- [x] Production Supabase schema with owner-scoped row-level security.
- [x] Protected AI Edge Function deployed; no provider secret is bundled in the client.
- [x] Guest mode, cloud account flow, trip editing, budget, journal, export/import, and route-studio handoff.
- [x] Responsive desktop/mobile layout, keyboard-accessible dialogs, and reduced-motion support.
- [x] Production builds and dependency audit.

## Before signing and store submission

- [ ] Return the Gemini API project to the Free Tier (the current project's Prepay balance is depleted), replace the protected `GEMINI_API_KEY` secret if Google issues a new key, and complete a signed-in AI plan smoke test.
- [ ] Enable Supabase leaked-password protection for email authentication.
- [ ] Install Android Studio with Android SDK 36 and Java 21.
- [ ] Install current Xcode and select the Apple Developer Team.
- [ ] Replace temporary signing with the production keystore and distribution certificate.
- [ ] Complete Apple App Privacy and Google Play Data Safety forms using `privacy.html` as the source of truth.
- [ ] Capture App Store and Play Store screenshots from a physical device or simulator.
- [ ] Test camera, photo picker, location, notifications, sharing, deep links, VoiceOver, and TalkBack on physical devices.
- [ ] Archive a signed iOS build and create an Android App Bundle (`.aab`).

## Data declarations

- Location: used only while the app is in use for map and nearby-place actions.
- Photos/camera: user-initiated memory capture only.
- User content: trips, journal, budget, and memories; device-local in guest mode and private cloud storage after sign-in.
- Contact info: email for account sync or a Locals early-access request.
- AI input: the trip brief is sent through Roamly's protected backend to Google Gemini only when the user requests an AI plan. On Google's free tier, submitted content may be used to improve Google products.
- Tracking/advertising: none.
