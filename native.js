const isNative = Boolean(window.Capacitor?.isNativePlatform?.());

if (isNative) {
  bootNative().catch((error) => console.warn('Native bridge could not start', error));
}

async function bootNative() {
  const { Capacitor } = await import('@capacitor/core');
  document.documentElement.classList.add('native-app', `native-${Capacitor.getPlatform()}`);
  const [
    { App },
    { Browser },
    { Haptics, ImpactStyle },
    { Keyboard },
    { Network },
    { SplashScreen },
    { StatusBar, Style }
  ] = await Promise.all([
    import('@capacitor/app'),
    import('@capacitor/browser'),
    import('@capacitor/haptics'),
    import('@capacitor/keyboard'),
    import('@capacitor/network'),
    import('@capacitor/splash-screen'),
    import('@capacitor/status-bar')
  ]);

  await StatusBar.setStyle({ style: Style.Dark });
  if (Capacitor.getPlatform() === 'android') {
    await StatusBar.setBackgroundColor({ color: '#f6f7f2' });
  }
  await SplashScreen.hide();

  const applyNetwork = ({ connected }) => {
    document.body.classList.toggle('offline', !connected);
    window.dispatchEvent(new CustomEvent('roamly:network', { detail: { connected } }));
  };
  applyNetwork(await Network.getStatus());
  await Network.addListener('networkStatusChange', applyNetwork);

  document.addEventListener('click', async (event) => {
    const target = event.target.closest('button, a');
    if (!target) return;
    Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});

    if (target.tagName === 'A' && /^https?:\/\//.test(target.href)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      await Browser.open({ url: target.href, presentationStyle: 'popover' });
      return;
    }

  }, true);

  await Keyboard.addListener('keyboardWillShow', () => document.body.classList.add('keyboard-open'));
  await Keyboard.addListener('keyboardWillHide', () => document.body.classList.remove('keyboard-open'));

  await App.addListener('backButton', ({ canGoBack }) => {
    const openModal = document.querySelector('.modal.open');
    if (openModal) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return;
    }
    const detail = document.querySelector('[data-page="trip"].active');
    if (detail) {
      document.querySelector('[data-route="trips"]')?.click();
      return;
    }
    if (canGoBack) history.back();
    else App.minimizeApp();
  });

  const handleDeepLink = ({ url }) => {
    if (!url) return;
    const route = new URL(url).searchParams.get('route');
    document.querySelector(`[data-route="${route || 'home'}"]`)?.click();
  };
  await App.addListener('appUrlOpen', handleDeepLink);
  const launch = await App.getLaunchUrl();
  if (launch?.url) handleDeepLink(launch);
}
