// Which sign-in methods to offer on a platform. `platform` is Capacitor's getPlatform(): 'ios' | 'android' | 'web'.
// App Store guideline 4.8: an iOS app that offers Google sign-in must also offer Sign in with Apple. Until that exists
// the native iOS app is email-only; web and Android keep Google. Re-enable Google on iOS by adding Sign in with Apple first.
export function signInOptions(platform) {
  return { google: platform !== 'ios', email: true };
}
