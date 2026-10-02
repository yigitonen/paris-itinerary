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

**Account deletion URL (Google Play Data safety / App Store):** `https://roamly-travel.yigitonen.chatgpt.site/delete-account`

## Completed web and backend work

- [x] Production Supabase schema with owner-scoped row-level security.
- [x] Protected AI Edge Function deployed; no provider secret is bundled in the client.
- [x] Guest mode, cloud account flow, trip editing, budget, journal, export/import, and integrated Route Studio.
- [x] Pace-sized AI days with breakfast, lunch, dinner, unique venues, and server-side validation.
- [x] Google-first place autocomplete/nearby architecture with a server-side usage cap.
- [x] Real Friends profiles, requests, acceptance/removal, grants, and row-level security.
- [x] PKCE Google/email authentication with production Sites and native callback allowlists; obsolete GitHub callbacks removed.
- [x] Offline app shell, guest persistence, and queued signed-in edits that synchronize after reconnection.
- [x] Native camera/photo picker, foreground location, recap sharing, local reminders, and custom deep-link integrations.
- [x] Responsive desktop/mobile layout, keyboard-accessible dialogs, and reduced-motion support.
- [x] Production builds and dependency audit.
- [x] Account deletion backend and public web page (code complete, see "Account deletion" below; needs the deploy steps before it works in production).

## Before signing and store submission

- [x] Complete a protected end-to-end AI plan smoke test with the server-side `GEMINI_API_KEY` on Google AI Studio Free Tier.
- [x] Passwordless email-link and Google sign-in only; no password is collected. Revisit leaked-password protection if passwords are added.
- [ ] Install Android Studio with Android SDK 36 and Java 21.
- [ ] Install current Xcode and select the Apple Developer Team.
- [ ] Replace temporary signing with the production keystore and distribution certificate.
- [ ] Complete Apple App Privacy and Google Play Data Safety forms using `privacy.html` as the source of truth.
- [ ] Capture App Store and Play Store screenshots from a physical device or simulator.
- [ ] Test camera, photo picker, location, notifications, sharing, deep links, VoiceOver, and TalkBack on physical devices.
- [ ] Archive a signed iOS build and create an Android App Bundle (`.aab`).

## Account deletion

Apple (5.1.1(v)) and Google Play both require account deletion inside the app and, for Play, at a public web URL.

Built:
- [x] Migration `20261002090000_account_deletion.sql`: `locals_waitlist.user_id` now cascades; `public.delete_account_data(uuid)` (service role only) removes waitlist rows by user id and by the account e-mail.
- [x] Edge Function `delete-account` (`POST {"confirm":"DELETE"}` with the user's JWT): cleanup, then `auth.admin.deleteUser`. All other user tables cascade from `auth.users`; there are no Storage objects.
- [x] Public page `/delete-account` (`delete-account.html`): e-mail link or Google sign-in, typed confirmation (SİL / DELETE), then deletion. Linked from the privacy policy and the support page.
- [x] Client helper `src/account.js` (`deleteAccount`, `clearLocalAccountData`) with unit tests, ready for the in-app UI.

Still to do before submission:
- [ ] Apply the migration and deploy the function: `supabase db push` and `supabase functions deploy delete-account` (JWT verification stays on).
- [ ] Add `https://roamly-travel.yigitonen.chatgpt.site/delete-account` to the Supabase Auth redirect URL allowlist (the e-mail link and Google sign-in return to it).
- [ ] **Wire the in-app "Hesabı sil" button** (Settings) to `deleteAccount(supabase)` from `src/account.js`. It is not connected yet, so in-app deletion is NOT available in the current build; do not submit to the App Store until it is.
- [ ] After wiring the button, mention in-app deletion in `privacy.html` (it currently describes only the web page and the support fallback).
- [ ] Smoke test with a throwaway account: delete from the web page and from the app, confirm the user, trips, profile and waitlist rows are gone and a second request returns 401.
- [ ] Enter the account deletion URL in Google Play Console (Data safety > Data deletion) and confirm the stated retention of provider backups.

## Data declarations

- Location: used only while the app is in use for map and nearby-place actions.
- Photos/camera: user-initiated memory capture only.
- User content: trips, journal, budget, and memories; device-local in guest mode and private cloud storage after sign-in.
- Contact info: email for account sync or a Locals early-access request. Deleted with the account (including waitlist entries made with the account e-mail).
- AI input: the trip brief is sent through Roamly's protected backend to Google Gemini only when the user requests an AI plan. On Google's free tier, submitted content may be used to improve Google products.
- Tracking/advertising: none.
