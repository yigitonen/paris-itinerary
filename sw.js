const CACHE='roamly-v2.0.0';
const CORE=[
  './','./index.html','./app.html','./privacy.html','./support.html','./manifest.webmanifest',
  './icons/icon-192.webp','./icons/icon-512.webp','./assets/vendor/lucide.min.js',
  './assets/media/rome.jpg','./assets/media/lisbon.jpg','./assets/media/paris.jpg',
  './assets/media/cappadocia.jpg','./assets/media/barcelona.jpg','./assets/media/food.jpg',
  './assets/media/profile-cover.jpg','./assets/media/elif.jpg','./assets/media/ece.jpg',
  './assets/media/mert.jpg','./assets/media/can.jpg','./assets/media/duru.jpg',
  './assets/media/arda.jpg','./assets/media/sena.jpg','./assets/media/coffee.jpg',
  './assets/media/street.jpg','./assets/media/marais.jpg'
];

async function cacheUrl(cache,url){
  try{const response=await fetch(url,{cache:'reload'});if(response.ok)await cache.put(url,response)}catch{}
}

async function installApp(){
  const cache=await caches.open(CACHE);
  await Promise.all(CORE.map(url=>cacheUrl(cache,url)));
  try{
    const html=await (await fetch('./index.html',{cache:'reload'})).text();
    const linked=[...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match=>match[1]).filter(url=>!url.startsWith('data:')&&!url.startsWith('http'));
    await Promise.all([...new Set(linked)].map(url=>cacheUrl(cache,url)));
  }catch{}
  await self.skipWaiting();
}

self.addEventListener('install',event=>event.waitUntil(installApp()));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||!event.request.url.startsWith(self.location.origin))return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request).then(response=>{const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));return response}).catch(async()=>await caches.match(event.request)||await caches.match('./index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy))}return response})));
});
