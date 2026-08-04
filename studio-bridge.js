import { completePkceCallback, startGoogleOAuth, supabase } from './src/repository.js';

async function openNativeOAuth(url) {
  if (!url || !window.Capacitor?.isNativePlatform?.()) return;
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url, presentationStyle: 'popover' });
}

window.RoamlyStudio = {
  supabase,
  async startGoogleOAuth(value) {
    const result = await startGoogleOAuth(value);
    if (!result.error) await openNativeOAuth(result.data?.url);
    return result;
  }
};

window.addEventListener('roamly:auth-callback', async (event) => {
  try {
    const result = await completePkceCallback(event.detail?.url);
    if (result.error) throw result.error;
  } catch (error) {
    console.warn('Native sign-in callback failed', error);
    alert('Sign-in could not be completed. Please try again.');
  }
});

window.dispatchEvent(new CustomEvent('roamly:studio-auth-ready'));
