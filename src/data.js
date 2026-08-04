const uid = () => crypto.randomUUID();

const addDays = (isoDate, offset) => {
  const date = new Date(`${isoDate}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

export const COVER_IMAGES = {
  rome: 'assets/media/rome.jpg',
  paris: 'assets/media/paris.jpg',
  lisbon: 'assets/media/lisbon.jpg',
  cappadocia: 'assets/media/cappadocia.jpg',
  barcelona: 'assets/media/barcelona.jpg',
  default: 'assets/media/street.jpg'
};

export const destinationKey = (destination = '') => {
  const normalized = destination.toLocaleLowerCase('tr-TR');
  if (normalized.includes('roma') || normalized.includes('rome')) return 'rome';
  if (normalized.includes('paris')) return 'paris';
  if (normalized.includes('lizbon') || normalized.includes('lisbon')) return 'lisbon';
  if (normalized.includes('kapadokya') || normalized.includes('cappadocia')) return 'cappadocia';
  if (normalized.includes('barselona') || normalized.includes('barcelona')) return 'barcelona';
  return 'default';
};

export function createManualTrip({ destination, startDate, days, style = 'Dengeli', pace = 'Rahat', note = '' }) {
  const duration = Math.max(1, Math.min(21, Number(days) || 3));
  const coverKey = destinationKey(destination);
  return {
    id: uid(),
    title: destination,
    destination,
    country: '',
    startDate,
    endDate: addDays(startDate, duration - 1),
    durationDays: duration,
    status: 'planning',
    style,
    pace,
    note,
    coverKey,
    budgetTotal: 0,
    currency: 'EUR',
    source: 'manual',
    summary: '',
    days: Array.from({ length: duration }, (_, index) => ({
      id: uid(),
      date: addDays(startDate, index),
      title: `${index + 1}. gün`,
      theme: index === 0 ? 'Varış ve şehre alışma' : 'Kendi ritminde keşif',
      stops: []
    })),
    expenses: [],
    journals: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

export function createDemoTrip() {
  const trip = createManualTrip({
    destination: 'Roma',
    startDate: '2026-08-12',
    days: 4,
    style: 'Yeme içme',
    pace: 'Rahat',
    note: 'İyi kahve, mahalleler ve gün batımı.'
  });
  trip.id = 'demo-rome';
  trip.country = 'İtalya';
  trip.status = 'upcoming';
  trip.source = 'demo';
  trip.summary = 'Roma’yı liste tüketmeden; iyi sofralar, kısa yürüyüşler ve mahalle ritmiyle keşfet.';
  trip.budgetTotal = 1240;
  trip.days[0].title = 'Tarihi merkez';
  trip.days[0].theme = 'Klasikleri sakin saatlerde gör';
  trip.days[0].stops = [
    { id: uid(), time: '08:30', title: 'Sant’Eustachio’da kahvaltı', category: 'Kahvaltı', mealRole: 'Breakfast', duration: '45 dk', notes: 'Güne espresso ve cornetto ile başla.', address: 'Piazza di S. Eustachio, Roma', lat: 41.8989, lng: 12.4742 },
    { id: uid(), time: '10:00', title: 'Pantheon', category: 'Tarih', duration: '1 saat', notes: 'Kalabalık büyümeden içeri gir.', address: 'Piazza della Rotonda, Roma', lat: 41.8986, lng: 12.4769 },
    { id: uid(), time: '12:30', title: 'Roscioli Salumeria', category: 'Öğle yemeği', duration: '1,5 saat', notes: 'Rezervasyon iyi fikir. Karbonarayı paylaş.', address: 'Via dei Giubbonari 21, Roma', lat: 41.8943, lng: 12.4722 },
    { id: uid(), time: '15:00', title: 'Trastevere sokakları', category: 'Mahalle', duration: '2 saat', notes: 'Ana meydandan sap; Via della Lungaretta çevresini dolaş.', address: 'Trastevere, Roma', lat: 41.8897, lng: 12.4708 },
    { id: uid(), time: '17:30', title: 'Gianicolo gün batımı', category: 'Manzara', duration: '1 saat', notes: 'Yokuş için taksi seçeneğini açık tut.', address: 'Piazzale Giuseppe Garibaldi, Roma', lat: 41.8914, lng: 12.4615 },
    { id: uid(), time: '19:30', title: 'Da Enzo al 29', category: 'Akşam yemeği', mealRole: 'Dinner', duration: '1,5 saat', notes: 'Sıraya kalmamak için erken git.', address: 'Via dei Vascellari 29, Roma', lat: 41.8865, lng: 12.4762 }
  ];
  trip.days[1].title = 'Monti ve tasarım';
  trip.days[1].theme = 'Antik Roma’dan mahalle masalarına';
  trip.days[1].stops = [
    { id: uid(), time: '08:30', title: 'Panella', category: 'Kahvaltı', mealRole: 'Breakfast', address: 'Via Merulana 54, Roma', lat: 41.8947, lng: 12.5012, notes: 'Fırından çıkanları paylaş.' },
    { id: uid(), time: '10:00', title: 'Kolezyum ve Forum', category: 'Tarih', address: 'Piazza del Colosseo, Roma', lat: 41.8902, lng: 12.4922, notes: 'Zamanlı bileti önceden al.' },
    { id: uid(), time: '13:00', title: 'La Barrique', category: 'Öğle yemeği', mealRole: 'Lunch', address: 'Via del Boschetto 41B, Roma', lat: 41.8955, lng: 12.4928, notes: 'Monti içinde sakin bir öğle molası.' },
    { id: uid(), time: '15:30', title: 'Monti sokakları', category: 'Mahalle', address: 'Piazza della Madonna dei Monti, Roma', lat: 41.8948, lng: 12.4908, notes: 'Bağımsız dükkânlara gir.' },
    { id: uid(), time: '19:30', title: 'Trattoria Monti', category: 'Akşam yemeği', mealRole: 'Dinner', address: 'Via di San Vito 13A, Roma', lat: 41.8951, lng: 12.5007, notes: 'Rezervasyon yap.' }
  ];
  trip.days[2].title = 'Borghese ve kuzey';
  trip.days[2].theme = 'Sanat, park ve zarif meydanlar';
  trip.days[2].stops = [
    { id: uid(), time: '08:30', title: 'Rosati', category: 'Kahvaltı', mealRole: 'Breakfast', address: 'Piazza del Popolo 5A, Roma', lat: 41.9106, lng: 12.4762 },
    { id: uid(), time: '10:00', title: 'Galleria Borghese', category: 'Sanat', address: 'Piazzale Scipione Borghese 5, Roma', lat: 41.9142, lng: 12.4922, notes: 'Zamanlı giriş zorunlu.' },
    { id: uid(), time: '13:00', title: 'Pizzeria Emma', category: 'Öğle yemeği', mealRole: 'Lunch', address: 'Via del Monte della Farina 28, Roma', lat: 41.8941, lng: 12.4746 },
    { id: uid(), time: '16:00', title: 'Villa Borghese', category: 'Doğa', address: 'Villa Borghese, Roma', lat: 41.9138, lng: 12.4852 },
    { id: uid(), time: '19:30', title: 'Retrobottega', category: 'Akşam yemeği', mealRole: 'Dinner', address: 'Via della Stelletta 4, Roma', lat: 41.9012, lng: 12.4753 }
  ];
  trip.days[3].title = 'Yavaş bir kapanış';
  trip.days[3].theme = 'Pazar, nehir ve son Roma sofrası';
  trip.days[3].stops = [
    { id: uid(), time: '08:30', title: 'Forno Campo de’ Fiori', category: 'Kahvaltı', mealRole: 'Breakfast', address: 'Campo de’ Fiori 22, Roma', lat: 41.8956, lng: 12.4722 },
    { id: uid(), time: '10:00', title: 'Campo de’ Fiori pazarı', category: 'Mahalle', address: 'Campo de’ Fiori, Roma', lat: 41.8957, lng: 12.4722 },
    { id: uid(), time: '13:00', title: 'Supplizio', category: 'Öğle yemeği', mealRole: 'Lunch', address: 'Via dei Banchi Vecchi 143, Roma', lat: 41.8973, lng: 12.4674 },
    { id: uid(), time: '15:30', title: 'Tiber kıyısı yürüyüşü', category: 'Doğa', address: 'Ponte Sisto, Roma', lat: 41.8928, lng: 12.4708 },
    { id: uid(), time: '19:00', title: 'Armando al Pantheon', category: 'Akşam yemeği', mealRole: 'Dinner', address: 'Salita de’ Crescenzi 31, Roma', lat: 41.8991, lng: 12.4768, notes: 'Son akşam için rezervasyon yap.' }
  ];
  trip.expenses = [
    { id: uid(), title: 'Otel', category: 'Konaklama', amount: 540, currency: 'EUR', createdAt: new Date().toISOString() },
    { id: uid(), title: 'Havalimanı treni', category: 'Ulaşım', amount: 36, currency: 'EUR', createdAt: new Date().toISOString() }
  ];
  return trip;
}
