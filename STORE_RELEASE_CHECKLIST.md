# Roamly 1.0 — Store release checklist

## Identity

- App name: **Roamly**
- Bundle ID / application ID: `com.yigitonen.roamly`
- Version: `1.0.0` (`versionCode` / build `1`)
- Primary language: Turkish
- Category: Travel
- Content rating target: 4+ / Everyone

## Store copy

The submission pack in [`docs/STORE_SUBMISSION.md`](docs/STORE_SUBMISSION.md) holds the full listing drafts (Turkish and English, with character counts checked by `node scripts/check-store-listing.mjs`), the App Privacy and Data safety answers, content-rating answers, App Review notes, the permission list and the screenshot plan. Where it differs from the lines below, the pack wins; its open questions are marked `TODO(owner)`.

**Subtitle (App Store):** Seyahatini kendi ritminde planla (32 characters, over the 30 limit; the pack proposes "Kendi ritminde seyahat planı")

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
- [x] Native recap sharing, local reminders, and custom deep-link integrations.
- [x] Responsive desktop/mobile layout, keyboard-accessible dialogs, and reduced-motion support.
- [x] Production builds and dependency audit.
- [x] Account deletion backend and public web page (code complete, see "Account deletion" below; needs the deploy steps before it works in production).

## Before signing and store submission

- [x] Complete a protected end-to-end AI plan smoke test with the server-side `GEMINI_API_KEY` on Google AI Studio Free Tier.
- [x] Passwordless email-link and Google sign-in only; no password is collected. Revisit leaked-password protection if passwords are added.
- [x] iOS sign-in is email magic-link only: the Google button is hidden on native iOS (`signInOptions` in `src/auth-options.js`; web and Android keep Google). App Store guideline 4.8 requires Sign in with Apple whenever an app offers a third-party login such as Google, and Sign in with Apple is not implemented yet. Adding it later (Apple capability, Supabase Apple provider, button on iOS) would allow re-enabling Google on iOS by flipping the rule in `signInOptions`.
- [ ] On a physical iPhone, confirm the email link opens the app through the `roamly://` callback and signs in, and that no Google button appears in the sign-in dialog. App Review needs a way to sign in, so give reviewers a test email inbox or a pre-created account in the review notes.
- [ ] Install Android Studio with Android SDK 36 and Java 21.
- [ ] Install current Xcode and select the Apple Developer Team.
- [ ] Replace temporary signing with the production keystore and distribution certificate.
- [ ] Complete Apple App Privacy and Google Play Data Safety forms using `privacy.html` as the source of truth; draft answers are in sections 3 and 4 of [`docs/STORE_SUBMISSION.md`](docs/STORE_SUBMISSION.md).
- [ ] Capture App Store and Play Store screenshots from a physical device or simulator (plan, sizes and `scripts/store-screenshots.mjs` in section 8 of [`docs/STORE_SUBMISSION.md`](docs/STORE_SUBMISSION.md)).
- [ ] Test notifications, sharing, deep links, VoiceOver, and TalkBack on physical devices.
- [ ] Archive a signed iOS build and create an Android App Bundle (`.aab`).

## Account deletion

Apple (5.1.1(v)) and Google Play both require account deletion inside the app and, for Play, at a public web URL.

Built:
- [x] Migration `20261002090000_account_deletion.sql`: `locals_waitlist.user_id` now cascades; `public.delete_account_data(uuid)` (service role only) removes waitlist rows by user id and by the account e-mail.
- [x] Edge Function `delete-account` (`POST {"confirm":"DELETE"}` with the user's JWT): cleanup, then `auth.admin.deleteUser`. All other user tables cascade from `auth.users`; there are no Storage objects.
- [x] Public page `/delete-account` (`delete-account.html`): e-mail link or Google sign-in, typed confirmation (SİL / DELETE), then deletion. Linked from the privacy policy and the support page.
- [x] Client helper `src/account.js` (`deleteAccount`, `clearLocalAccountData`) with unit tests; used by the in-app flow.

Still to do before submission:
- [ ] Apply the migration and deploy the function: `supabase db push` and `supabase functions deploy delete-account` (JWT verification stays on).
- [ ] Add `https://roamly-travel.yigitonen.chatgpt.site/delete-account` to the Supabase Auth redirect URL allowlist (the e-mail link and Google sign-in return to it).
- [x] In-app "Hesabı sil" (Ayarlar, signed-in only, hidden for guests): confirmation modal with the list of deleted data, "Önce yedek indir", typed SİL, online check, reminders cancelled first, then `deleteAccount(supabase)` and return to guest mode. Implemented; still needs verification on a real iOS and Android device (see the smoke test below).
- [ ] After wiring the button, mention in-app deletion in `privacy.html` (it currently describes only the web page and the support fallback).
- [ ] Smoke test with a throwaway account: delete from the web page and from the app (signed-in Ayarlar > Hesabı sil; also check native reminders are gone and guest trips remain), confirm the user, trips, profile and waitlist rows are gone and a second request returns 401.
- [ ] Enter the account deletion URL in Google Play Console (Data safety > Data deletion) and confirm the stated retention of provider backups.

## Data declarations

- Location: device location is not accessed. Nearby places and weather use approximate coordinates of stops already in the trip.
- Photos/camera: not accessed; the app requests no camera or photo-library permission.
- User content: trips, journal, budget, and memories; device-local in guest mode and private cloud storage after sign-in.
- Contact info: email for account sync or a Locals early-access request. Deleted with the account (including waitlist entries made with the account e-mail).
- AI input: city, start date, day count, style, pace and the optional note are sent through Roamly's protected backend to Google Gemini only when the user requests an AI plan, and only after an in-app consent dialog (versioned, stored on the device, withdrawable in Settings; declining sends nothing). Retention and product-improvement use depend on Google's Gemini API terms for the tier in use; re-check them before declaring Data Safety answers.
- Tracking/advertising: none.
