const CACHE='roamly-v1.1.0';
const CORE=['./','./index.html','./styles.css','./main.js','./native.js','./app.html','./privacy.html','./support.html','./manifest.webmanifest','./icons/icon-192.webp','./icons/icon-512.webp','./assets/vendor/lucide.min.js','./assets/media/rome.jpg','./assets/media/lisbon.jpg','./assets/media/paris.jpg','./assets/media/cappadocia.jpg','./assets/media/barcelona.jpg','./assets/media/food.jpg','./assets/media/profile-cover.jpg','./assets/media/elif.jpg','./assets/media/ece.jpg','./assets/media/mert.jpg','./assets/media/can.jpg','./assets/media/duru.jpg','./assets/media/arda.jpg','./assets/media/sena.jpg','./assets/media/coffee.jpg','./assets/media/street.jpg','./assets/media/marais.jpg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));return response}).catch(()=>event.request.mode==='navigate'?caches.match('./index.html'):undefined)));
});
