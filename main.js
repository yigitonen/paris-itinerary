const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

const IMG = {
  avatar1:'assets/media/ece.jpg',
  avatar2:'assets/media/mert.jpg',
  avatar3:'assets/media/can.jpg',
  avatar4:'assets/media/duru.jpg',
  avatar5:'assets/media/arda.jpg',
  rome:'assets/media/rome.jpg',
  lisbon:'assets/media/lisbon.jpg',
  paris:'assets/media/paris.jpg',
  cappadocia:'assets/media/cappadocia.jpg',
  barcelona:'assets/media/barcelona.jpg',
  food:'assets/media/food.jpg'
};

const stories = [
  ['Ece','Tokyo',IMG.avatar1,true],['Mert','Berlin',IMG.avatar2,false],['Can','Atina',IMG.avatar3,true],['Duru','Bali',IMG.avatar4,false],['Arda','Kaş',IMG.avatar5,false],['Sena','Paris','assets/media/sena.jpg',false]
];
const feedItems = [
  {name:'Ece Karaca',handle:'@eceyolda · 2 sa',avatar:IMG.avatar1,image:IMG.lisbon,place:'Alfama, Lisboa',likes:428,caption:'Lizbon’un en güzel yanı plansız saptığın sokaklar olabilir. Pastel de nata sayısını açıklamıyorum.',route:'Lizbon’da 48 saat',meta:'12 durak · 18,4 km · 4 kaydedilen yer'},
  {name:'Mert Aksoy',handle:'@mertaround · dün',avatar:IMG.avatar2,image:IMG.cappadocia,place:'Göreme, Kapadokya',likes:812,caption:'Saat 05.10 alarmına değen manzaralar serisi. Bu rota gün doğumundan sonra kalabalıktan kaçıyor.',route:'Kapadokya gün doğumu rotası',meta:'7 durak · 9,2 km · 386 kez kaydedildi'}
];
const baseTrips = [
  {id:'rome',city:'Roma',country:'İtalya',dates:'12–16 Ağustos',days:4,status:'upcoming',image:IMG.rome,places:18,people:2,budget:1240},
  {id:'lisbon',city:'Lizbon',country:'Portekiz',dates:'18–22 Mayıs 2025',days:4,status:'past',image:IMG.lisbon,places:27,people:2,budget:980},
  {id:'paris',city:'Paris',country:'Fransa',dates:'15–17 Temmuz 2026',days:2,status:'upcoming',image:IMG.paris,places:16,people:2,budget:720},
  {id:'cappadocia',city:'Kapadokya',country:'Türkiye',dates:'3–6 Ekim 2024',days:3,status:'past',image:IMG.cappadocia,places:14,people:4,budget:490}
];
const cityData = {
  roma:{image:IMG.rome,places:[['08:30','Sant’Eustachio Il Caffè','Kahve & cornetto','assets/media/coffee.jpg'],['10:00','Pantheon & Piazza Navona','Tarih · 1,5 saat',IMG.rome],['12:45','Roscioli Salumeria','Öğle yemeği · rezervasyon önerilir',IMG.food],['15:00','Trastevere sokakları','Yürüyüş · fotoğraf molaları','assets/media/street.jpg'],['19:30','Gianicolo gün batımı','Manzara · 45 dk',IMG.lisbon]]},
  paris:{image:IMG.paris,places:[['09:00','Café de Flore','Kahvaltı · 1 saat',IMG.food],['10:30','Musée d’Orsay','Sanat · 2 saat',IMG.paris],['13:00','Jardin des Tuileries','Yürüyüş · piknik',IMG.paris],['15:00','Le Marais','Mahalle keşfi · 2 saat','assets/media/marais.jpg'],['20:00','Seine kıyısında gün batımı','Manzara · 1 saat',IMG.paris]]},
  lizbon:{image:IMG.lisbon,places:[['08:30','Manteigaria','Pastel de nata & kahve',IMG.food],['10:00','Alfama','Mahalle yürüyüşü · 2 saat',IMG.lisbon],['13:00','Time Out Market','Öğle yemeği · 1 saat',IMG.food],['16:00','Tram 28 rotası','Şehir turu · 1,5 saat',IMG.lisbon],['19:15','Senhora do Monte','Gün batımı · 1 saat',IMG.lisbon]]},
  barcelona:{image:IMG.barcelona,places:[['09:00','Satan’s Coffee Corner','Kahvaltı · 45 dk',IMG.food],['10:30','Sagrada Família','Mimari · 2 saat',IMG.barcelona],['13:30','La Boqueria','Tapas · 1 saat',IMG.food],['16:00','Gothic Quarter','Mahalle yürüyüşü',IMG.barcelona],['19:30','Bunkers del Carmel','Gün batımı',IMG.barcelona]]}
};
let state = JSON.parse(localStorage.getItem('roamly-state') || 'null') || {view:'discover',trips:baseTrips,expenses:[{name:'Otel',amount:540},{name:'Ulaşım',amount:186},{name:'Yeme & içme',amount:118}],journal:[]};
let activeTrip = state.trips[0];
let selectedVibe='Dengeli', selectedGroup='Partnerimle', selectedDay=0;

function save(){ localStorage.setItem('roamly-state',JSON.stringify(state)); }
function icons(){ if(window.lucide) lucide.createIcons({attrs:{'aria-hidden':'true'}}); }
function escapeHtml(v){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function toast(msg){const t=$('#toast');$('span',t).textContent=msg;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),2400)}
window.roamlyToast=toast;
function showView(name){
  $$('.view').forEach(v=>v.classList.toggle('active',v.dataset.viewPanel===name));
  $$('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  if(name==='trips') renderTrips();
  window.scrollTo({top:0,behavior:'smooth'});state.view=name;save();icons();
}
window.roamlyShowView=showView;
function openModal(id){$(id).classList.add('open');$(id).setAttribute('aria-hidden','false');document.body.style.overflow='hidden';icons()}
function closeModals(){ $$('.modal-shell').forEach(m=>{m.classList.remove('open');m.setAttribute('aria-hidden','true')});document.body.style.overflow=''; }

function renderStories(){ $('#stories').innerHTML=stories.map(s=>`<button class="story" data-action="story"><span class="story-img"><img src="${s[2]}" alt="${s[0]}">${s[3]?'<span class="story-live">LIVE</span>':''}</span><strong>${s[0]}</strong><small>${s[1]}</small></button>`).join(''); }
function renderFeed(){ $('#feed').innerHTML=feedItems.map((f,i)=>`<article class="feed-card"><header class="feed-head"><img src="${f.avatar}" alt=""><div><strong>${f.name}</strong><small>${f.handle}</small></div><button aria-label="Diğer"><i data-lucide="more-horizontal"></i></button></header><div class="feed-media" style="background-image:url('${f.image}')"><span class="place-label"><i data-lucide="map-pin"></i>${f.place}</span></div><div class="feed-body"><div class="feed-actions"><button class="like-button" data-liked="false"><i data-lucide="heart"></i><span>${f.likes}</span></button><button><i data-lucide="message-circle"></i><span>${i?31:18}</span></button><button><i data-lucide="send"></i></button><button class="save"><i data-lucide="bookmark"></i></button></div><p><strong>${f.name.split(' ')[0]}</strong> ${f.caption}</p><div class="feed-route"><span><i data-lucide="route"></i></span><div><strong>${f.route}</strong><small>${f.meta}</small></div><button data-action="save-route">Rotayı kaydet</button></div></div></article>`).join('');icons(); }
function renderTrips(filter='all'){
  const trips=state.trips.filter(t=>filter==='all'||t.status===filter);
  $('#tripList').innerHTML=trips.map(t=>`<button class="trip-item" data-trip="${t.id}"><div class="trip-item-media" style="background-image:url('${t.image||IMG.rome}')"><span class="trip-status">${t.status==='past'?'TAMAMLANDI':'YAKLAŞIYOR'}</span><span class="trip-members"><img src="${IMG.avatar1}" alt=""><img src="${IMG.avatar2}" alt=""></span></div><div class="trip-item-body"><h3>${escapeHtml(t.city)}</h3><p>${escapeHtml(t.country||'Yeni keşif')} · ${escapeHtml(t.dates)}</p><div class="trip-meta"><span><i data-lucide="calendar-days"></i>${t.days} gün</span><span><i data-lucide="map-pin"></i>${t.places||12} yer</span><span><i data-lucide="wallet"></i>€${t.budget||900}</span></div></div></button>`).join('') || '<p class="page-sub">Bu bölümde henüz bir seyahat yok.</p>';
  icons();
}
function renderPhotos(){ const data=[[IMG.lisbon,'Lizbon','Mayıs 2025'],[IMG.paris,'Paris','Temmuz 2026'],[IMG.cappadocia,'Kapadokya','Ekim 2024'],[IMG.barcelona,'Barselona','Nisan 2024'],[IMG.food,'Tatlar','48 kayıt'],[IMG.rome,'Roma','Yaklaşıyor']];$('#photoGrid').innerHTML=data.map(x=>`<button class="photo-tile" style="background-image:url('${x[0]}')"><span><strong>${x[1]}</strong><small>${x[2]}</small></span></button>`).join(''); }
function normalizeCity(city){const s=city.toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g,'');if(s.includes('paris'))return'paris';if(s.includes('lizbon')||s.includes('lisbon'))return'lizbon';if(s.includes('barcelona')||s.includes('barselona'))return'barcelona';return'roma'}
function planStops(trip,day){
  const key=trip.key||normalizeCity(trip.city), base=(cityData[key]||cityData.roma).places;
  return base.map((p,i)=>{const hour=(parseInt(p[0])+day)%24;return [String(hour).padStart(2,'0')+p[0].slice(2),p[1],p[2],p[3]]});
}
function renderTrip(trip=activeTrip){
  activeTrip=trip;const stops=planStops(trip,selectedDay);const total=state.expenses.reduce((a,x)=>a+Number(x.amount),0);const img=trip.image||(cityData[trip.key]||cityData.rome).image;
  $('#tripDetail').innerHTML=`<div class="trip-cover" style="background-image:url('${img}')"><button class="icon-button trip-back" data-view="trips"><i data-lucide="arrow-left"></i></button><div class="trip-cover-copy"><span class="live-pill"><span></span>${trip.status==='past'?'TAMAMLANDI':'YAKLAŞAN SEYAHAT'}</span><h1>${escapeHtml(trip.city)}</h1><p>${escapeHtml(trip.dates)} · ${trip.days} gün · ${trip.people||2} gezgin</p></div></div><div class="trip-detail-inner"><div class="trip-toolbar"><button class="secondary" data-action="group"><i data-lucide="users"></i> Grup</button><button class="secondary" data-action="budget"><i data-lucide="wallet-cards"></i> Bütçe</button><button class="secondary" data-action="new-journal"><i data-lucide="pen-line"></i> Journal</button><button class="secondary" data-action="reels"><i data-lucide="play"></i> Reels</button><a class="secondary" href="app.html"><i data-lucide="route"></i> Gelişmiş rota</a><div class="route-live"><span></span> Otomatik rota takibi açık</div></div><div class="day-switcher">${Array.from({length:trip.days},(_,i)=>`<button class="${i===selectedDay?'active':''}" data-day="${i}"><strong>${i+1}. Gün</strong><small>${i===0?'MERKEZ & TARİH':i===1?'MAHALLELER':'KEŞİF ROTASI'}</small></button>`).join('')}</div><div class="trip-layout"><div><div class="route-map"><div class="map-route-line"></div><i class="map-pin p1"><span>1</span></i><i class="map-pin p2"><span>2</span></i><i class="map-pin p3"><span>3</span></i><div class="map-summary"><span><strong>8,4 km</strong> yürüyüş</span><span><strong>5 durak</strong></span><span><strong>€46</strong> tahmini</span></div></div><div class="itinerary"><div class="itinerary-head"><h2>${selectedDay+1}. gün planı</h2><button data-action="optimize"><i data-lucide="wand-sparkles"></i> Rotayı iyileştir</button></div>${stops.map((s,i)=>`<div class="stop-row"><span class="stop-number">${i+1}</span><article class="stop-card"><img class="stop-card-img" src="${s[3]}" alt=""><div class="stop-card-main"><span class="stop-time">${s[0]}</span><h3>${s[1]}</h3><p>${s[2]}</p><div class="stop-actions"><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s[1]+' '+trip.city)}" target="_blank" rel="noopener">Yol tarifi</a><button data-action="favorite">♡ Favori</button><button data-action="add-photo">＋ Fotoğraf</button></div></div></article></div>`).join('')}</div></div><aside class="trip-side"><section class="side-card"><h3><i data-lucide="wallet-cards"></i> Bütçe özeti</h3><div class="budget-ring"><span><strong>€${total}</strong><small>€${trip.budget||1240} bütçeden</small></span></div><div class="budget-lines"><div><span>Konaklama</span><strong>€540</strong></div><div><span>Yeme & içme</span><strong>€118</strong></div><div><span>Ulaşım</span><strong>€186</strong></div></div><button class="secondary" data-action="budget">Harcamaları aç</button></section><section class="side-card"><h3><i data-lucide="users"></i> Seyahat grubu</h3><div class="group-faces"><img src="${IMG.avatar1}" alt=""><img src="${IMG.avatar2}" alt=""><button data-action="group"><i data-lucide="plus"></i></button></div><p class="page-sub">Planı birlikte düzenleyin, harcamaları bölüşün ve konum paylaşın.</p><button class="secondary" data-action="group">Grubu yönet</button></section><section class="side-card"><h3><i data-lucide="cloud-download"></i> Offline hazır</h3><p class="page-sub">Plan, rotalar ve kayıtların bu cihazda. İnternet olmasa da yoluna devam et.</p></section></aside></div></div>`;
  showView('trip-detail');icons();
}
function openSheet(html){$('#sheetContent').innerHTML=html;openModal('#sheetModal');icons()}
function friendsSheet(){openSheet(`<div class="modal-top"><div><span class="eyebrow">SOSYAL ÇEVREN</span><h2>Arkadaşlar</h2></div><button class="icon-button" data-action="close-modal"><i data-lucide="x"></i></button></div><div class="input-shell"><i data-lucide="search"></i><input placeholder="İsim veya kullanıcı adı ara"></div><div class="sheet-list">${stories.slice(0,5).map((s,i)=>`<div class="friend-row"><img src="${s[2]}" alt=""><div><strong>${s[0]} ${['Karaca','Aksoy','Demir','Aydın','Koç'][i]}</strong><small>@${s[0].toLocaleLowerCase('tr')}yolda · ${12+i*7} ortak arkadaş</small></div><button data-action="add-friend">Ekle</button></div>`).join('')}</div>`)}
function groupSheet(){const t=activeTrip||state.trips[0];openSheet(`<div class="modal-top"><div><span class="eyebrow">${escapeHtml(t.city.toLocaleUpperCase('tr'))} · ${escapeHtml(t.dates)}</span><h2>Seyahat grubu</h2></div><button class="icon-button" data-action="close-modal" aria-label="Kapat"><i data-lucide="x"></i></button></div><p class="page-sub">Planı, bütçeyi ve anıları birlikte yönetin.</p><div class="sheet-list"><div class="friend-row"><img src="${IMG.avatar1}" alt=""><div><strong>Elif Yılmaz</strong><small>Plan sahibi · konum açık</small></div><span>✓</span></div><div class="friend-row"><img src="${IMG.avatar2}" alt=""><div><strong>Yiğit Önen</strong><small>Editör · konum açık</small></div><span>✓</span></div></div><button class="primary" style="width:100%;margin-top:18px" data-action="invite"><i data-lucide="user-plus"></i> Arkadaş davet et</button><p class="privacy-note"><i data-lucide="shield-check"></i> Canlı konum yalnızca seyahat günlerinde ve grupla paylaşılır.</p>`)}
function budgetSheet(){const t=activeTrip||state.trips[0],limit=t.budget||1240,total=state.expenses.reduce((a,x)=>a+Number(x.amount),0);openSheet(`<div class="modal-top"><div><span class="eyebrow">${escapeHtml(t.city.toLocaleUpperCase('tr'))} BÜTÇESİ</span><h2>Harcamalar</h2></div><button class="icon-button" data-action="close-modal" aria-label="Kapat"><i data-lucide="x"></i></button></div><div class="budget-big"><span>Toplam harcama</span><strong>€${total.toFixed(0)}</strong><small>€${limit.toLocaleString('tr-TR')} bütçenin %${Math.round(total/limit*100)}'i</small></div><form class="expense-form" id="expenseForm"><input name="expense" required placeholder="Harcama" aria-label="Harcama"><input name="amount" required type="number" min="1" placeholder="€" aria-label="Tutar"><button class="primary" aria-label="Ekle"><i data-lucide="plus"></i></button></form><div class="expense-list">${state.expenses.map(x=>`<div class="expense-row"><span>${escapeHtml(x.name)}</span><strong>€${Number(x.amount).toFixed(0)}</strong></div>`).join('')}</div>`)}
function journalSheet(){openSheet(`<div class="modal-top"><div><span class="eyebrow">SEYAHAT JOURNALI</span><h2>Bugünden ne kalsın?</h2></div><button class="icon-button" data-action="close-modal"><i data-lucide="x"></i></button></div><form id="journalForm"><input class="journal-field" name="title" required placeholder="Başlık"><textarea class="journal-field" name="text" required rows="7" placeholder="Sokaklar, tatlar, hisler…"></textarea><button class="primary" style="width:100%;margin-top:12px"><i data-lucide="save"></i> Anılarıma kaydet</button></form>`)}

function submitPlanner(e){
  e.preventDefault();const fd=new FormData($('#plannerForm'));const city=fd.get('city').trim(),days=Number(fd.get('days')),date=new Date(fd.get('date')+'T12:00:00'),key=normalizeCity(city);const end=new Date(date);end.setDate(end.getDate()+days-1);const fmt=d=>d.toLocaleDateString('tr-TR',{day:'numeric',month:'long'});const trip={id:'trip-'+Date.now(),city,country:'AI tarafından planlandı',dates:`${fmt(date)}–${fmt(end)}`,days,status:'upcoming',image:(cityData[key]||cityData.rome).image,places:days*5,people:selectedGroup==='Tek başıma'?1:2,budget:days*280,key,vibe:selectedVibe};
  state.trips.unshift(trip);save();activeTrip=trip;selectedDay=0;closeModals();
  const overlay=document.createElement('div');overlay.className='ai-loading';overlay.innerHTML=`<div><span class="brand-mark"><i data-lucide="sparkles"></i></span><h2>${escapeHtml(city)} planın hazırlanıyor</h2><p>Mahalleler, mesafeler, ilgi alanların ve en iyi saatler dengeleniyor…</p><div class="loading-line"><span></span></div></div>`;document.body.append(overlay);icons();
  setTimeout(()=>{overlay.remove();renderTrip(trip);toast(`${city} için ${days} günlük plan hazır`)},1450);
}

document.addEventListener('click',e=>{
  const btn=e.target.closest('button,a');if(!btn)return;
  if(btn.dataset.view){e.preventDefault();showView(btn.dataset.view);return}
  const a=btn.dataset.action;
  if(a==='open-planner'){openModal('#plannerModal')}
  else if(a==='close-modal')closeModals();
  else if(a==='open-trip'||a==='continue-route')renderTrip(state.trips.find(t=>t.id==='rome')||state.trips[0]);
  else if(a==='friends')friendsSheet();else if(a==='group')groupSheet();else if(a==='budget')budgetSheet();else if(a==='new-journal')journalSheet();
  else if(a==='reels'||a==='story'){closeModals();$('#reelsOverlay').classList.add('open');$('#reelsOverlay').setAttribute('aria-hidden','false');document.body.style.overflow='hidden';icons()}
  else if(a==='close-reels'){$('#reelsOverlay').classList.remove('open');$('#reelsOverlay').setAttribute('aria-hidden','true');document.body.style.overflow=''}
  else if(a==='add-friend'){btn.textContent='Eklendi ✓';btn.disabled=true;toast('Arkadaşlık isteği gönderildi')}
  else if(a==='invite'){navigator.clipboard?.writeText(location.href+'?invite=roma');toast('Davet bağlantısı kopyalandı')}
  else if(a==='save-route'){btn.textContent='Kaydedildi ✓';toast('Rota seyahatlerine eklendi')}
  else if(a==='favorite'){btn.textContent='♥ Favori';toast('Favorilerine eklendi')}
  else if(a==='add-photo')toast('Fotoğraf ekleme seyahat gününde hazır olacak');
  else if(a==='optimize')toast('Rota yürüyüş mesafesine göre iyileştirildi');
  else if(a==='offline-info')toast('Roma planı çevrimdışı kullanıma hazır');
  else if(a==='privacy')location.href='privacy.html';
  else if(a==='notifications')toast('Yeni 3 arkadaş aktiviten var');
  if(btn.classList.contains('like-button')){const liked=btn.dataset.liked==='true';btn.dataset.liked=String(!liked);btn.classList.toggle('liked',!liked);const span=$('span',btn);span.textContent=Number(span.textContent)+(liked?-1:1);const icon=$('svg',btn);if(icon)icon.style.fill=liked?'none':'#ff664d'}
  if(btn.dataset.trip){activeTrip=state.trips.find(t=>t.id===btn.dataset.trip);selectedDay=0;renderTrip(activeTrip)}
  if(btn.dataset.day!==undefined){selectedDay=Number(btn.dataset.day);renderTrip(activeTrip)}
  if(btn.dataset.tripFilter){$$('[data-trip-filter]').forEach(x=>x.classList.toggle('active',x===btn));renderTrips(btn.dataset.tripFilter)}
  if(btn.dataset.vibe){selectedVibe=btn.dataset.vibe;$$('[data-vibe]').forEach(x=>x.classList.toggle('selected',x===btn))}
  if(btn.dataset.group){selectedGroup=btn.dataset.group;$$('[data-group]').forEach(x=>x.classList.toggle('selected',x===btn))}
});
document.addEventListener('submit',e=>{
  if(e.target.id==='plannerForm')submitPlanner(e);
  if(e.target.id==='expenseForm'){e.preventDefault();const fd=new FormData(e.target);state.expenses.push({name:fd.get('expense'),amount:Number(fd.get('amount'))});save();budgetSheet();toast('Harcama eklendi')}
  if(e.target.id==='journalForm'){e.preventDefault();const fd=new FormData(e.target);state.journal.unshift({title:fd.get('title'),text:fd.get('text'),date:new Date().toISOString()});save();closeModals();toast('Journal anılarına kaydedildi')}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('#reelsOverlay').classList.remove('open');closeModals()}});
function setOnline(){document.body.classList.toggle('offline',!navigator.onLine)}window.addEventListener('online',setOnline);window.addEventListener('offline',setOnline);setOnline();
const minDate=new Date();minDate.setDate(minDate.getDate()+1);$('#planDate').value=minDate.toISOString().slice(0,10);$('#planDate').min=new Date().toISOString().slice(0,10);
renderStories();renderFeed();renderTrips();renderPhotos();showView(state.view==='trip-detail'?'discover':state.view);icons();
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
