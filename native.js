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
    { Camera, CameraResultType, CameraSource },
    { Geolocation },
    { Haptics, ImpactStyle },
    { Keyboard },
    { LocalNotifications },
    { Network },
    { Share },
    { SplashScreen },
    { StatusBar, Style }
  ] = await Promise.all([
    import('@capacitor/app'),
    import('@capacitor/browser'),
    import('@capacitor/camera'),
    import('@capacitor/geolocation'),
    import('@capacitor/haptics'),
    import('@capacitor/keyboard'),
    import('@capacitor/local-notifications'),
    import('@capacitor/network'),
    import('@capacitor/share'),
    import('@capacitor/splash-screen'),
    import('@capacitor/status-bar')
  ]);

  const notify = (message) => window.roamlyToast?.(message);
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

    if (target.dataset.action === 'add-photo') {
      event.preventDefault();
      event.stopImmediatePropagation();
      try {
        const photo = await Camera.getPhoto({
          quality: 86,
          allowEditing: false,
          resultType: CameraResultType.Uri,
          source: CameraSource.Prompt,
          saveToGallery: false,
          correctOrientation: true
        });
        localStorage.setItem('roamly-last-photo', JSON.stringify({ path: photo.webPath, at: Date.now() }));
        notify('Fotoğraf seyahat anılarına eklendi');
      } catch (error) {
        if (!String(error).toLowerCase().includes('cancel')) notify('Fotoğraf eklenemedi');
      }
    }

    if (target.dataset.action === 'invite') {
      event.preventDefault();
      event.stopImmediatePropagation();
      await Share.share({
        title: 'Roamly seyahat grubuma katıl',
        text: 'Rotayı birlikte planlayalım ve anıları burada biriktirelim.',
        url: 'https://yigitonen.github.io/paris-itinerary/?invite=roma',
        dialogTitle: 'Arkadaşını davet et'
      });
    }

    if (target.dataset.action === 'continue-route') {
      try {
        let permission = await Geolocation.checkPermissions();
        if (permission.location !== 'granted') permission = await Geolocation.requestPermissions();
        if (permission.location === 'granted') {
          const location = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 12000 });
          sessionStorage.setItem('roamly-location', JSON.stringify({ lat: location.coords.latitude, lng: location.coords.longitude, at: Date.now() }));
        }
      } catch (_) {
        notify('Konum alınamadı; kayıtlı rota açılıyor');
      }
    }

    if (target.dataset.action === 'notifications') {
      event.preventDefault();
      event.stopImmediatePropagation();
      let permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') permission = await LocalNotifications.requestPermissions();
      if (permission.display === 'granted') {
        await LocalNotifications.schedule({ notifications: [{
          id: 1208,
          title: 'Roma yaklaşıyor ✈️',
          body: 'Planında eksik kalan 3 rezervasyonu birlikte tamamlayalım.',
          schedule: { at: new Date(Date.now() + 5000) },
          extra: { route: 'trips/rome' }
        }] });
        notify('Seyahat bildirimleri açıldı');
      }
    }
  }, true);

  await Keyboard.addListener('keyboardWillShow', () => document.body.classList.add('keyboard-open'));
  await Keyboard.addListener('keyboardWillHide', () => document.body.classList.remove('keyboard-open'));

  await App.addListener('backButton', ({ canGoBack }) => {
    const openModal = document.querySelector('.modal-shell.open');
    const reels = document.querySelector('.reels-overlay.open');
    if (openModal || reels) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return;
    }
    const detail = document.querySelector('[data-view-panel="trip-detail"].active');
    if (detail) {
      window.roamlyShowView?.('trips');
      return;
    }
    if (canGoBack) history.back();
    else App.minimizeApp();
  });

  const handleDeepLink = ({ url }) => {
    if (!url) return;
    window.roamlyShowView?.('trips');
    const invite = new URL(url).searchParams.get('invite');
    if (invite) notify('Seyahat daveti açıldı');
  };
  await App.addListener('appUrlOpen', handleDeepLink);
  const launch = await App.getLaunchUrl();
  if (launch?.url) handleDeepLink(launch);
}
