import { parseNativeDestination } from './native-routing.js';

const isNative = Boolean(window.Capacitor?.isNativePlatform?.());

window.RoamlyNative = { isNative: false };

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

  window.RoamlyNative = {
    isNative: true,
    async pickMemoryPhoto() {
      const photo = await Camera.getPhoto({
        quality: 82,
        allowEditing: false,
        correctOrientation: true,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Prompt
      });
      return photo.dataUrl || '';
    },
    async getCurrentLocation() {
      await Geolocation.requestPermissions({ permissions: ['location'] });
      const position = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 15_000,
        maximumAge: 60_000
      });
      return {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy
      };
    },
    async shareRecap({ title, text, url }) {
      await Share.share({
        title: String(title || 'Roamly seyahat özeti'),
        text: String(text || ''),
        url: String(url || 'https://roamly-travel.yigitonen.chatgpt.site/'),
        dialogTitle: 'Seyahat özetini paylaş'
      });
    },
    async scheduleTripReminder({ id, title, body, at, extra = {} }) {
      const reminderId = Number(id);
      const reminderAt = new Date(at);
      if (!Number.isInteger(reminderId) || reminderId <= 0 || reminderId > 2_147_483_647) {
        throw new Error('Reminder id must be a positive 32-bit integer.');
      }
      if (!Number.isFinite(reminderAt.getTime()) || reminderAt.getTime() <= Date.now()) {
        throw new Error('Reminder time must be in the future.');
      }
      let permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') permission = await LocalNotifications.requestPermissions();
      if (permission.display !== 'granted') throw new Error('Notification permission was not granted.');
      await LocalNotifications.schedule({
        notifications: [{
          id: reminderId,
          title: String(title || 'Yaklaşan seyahat planı'),
          body: String(body || 'Bir sonraki durağın yaklaşıyor.'),
          schedule: { at: reminderAt },
          extra
        }]
      });
      return reminderId;
    },
    async cancelTripReminder(id) {
      const reminderId = Number(id);
      if (!Number.isInteger(reminderId) || reminderId <= 0) return;
      await LocalNotifications.cancel({ notifications: [{ id: reminderId }] });
    }
  };
  document.dispatchEvent(new CustomEvent('roamly:native-ready'));

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

  const openDestination = ({ route, tripId }) => {
    const open = () => {
      if (tripId) {
        const tripControl = [...document.querySelectorAll('[data-trip-open]')]
          .find((control) => control.dataset.tripOpen === tripId);
        if (tripControl) {
          tripControl.click();
          return true;
        }
      }
      const routeControl = [...document.querySelectorAll('[data-route]')]
        .find((control) => control.dataset.route === route);
      if (routeControl) {
        routeControl.click();
        return !tripId;
      }
      return false;
    };

    if (open()) return;
    let attempts = 0;
    const retry = setInterval(() => {
      attempts += 1;
      if (open() || attempts >= 20) clearInterval(retry);
    }, 150);
  };

  const handleDeepLink = ({ url }) => {
    if (!url) return;
    const callback = new URL(url);
    if (callback.protocol === 'roamly:' && (callback.searchParams.has('code') || callback.searchParams.has('error'))) {
      Browser.close().catch(() => {});
      window.dispatchEvent(new CustomEvent('roamly:auth-callback', { detail: { url } }));
      return;
    }
    openDestination(parseNativeDestination(url));
  };
  await App.addListener('appUrlOpen', handleDeepLink);
  const launch = await App.getLaunchUrl();
  if (launch?.url) handleDeepLink(launch);
}
