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
    { id: uid(), time: '08:30', title: 'Sant’Eustachio Il Caffè', category: 'Kahve', duration: '45 dk', notes: 'Güne ayakta içilen kısa bir espresso ile başla.', address: 'Piazza di S. Eustachio, Roma', lat: 41.8989, lng: 12.4742 },
    { id: uid(), time: '10:00', title: 'Pantheon', category: 'Tarih', duration: '1 saat', notes: 'Kalabalık büyümeden içeri gir.', address: 'Piazza della Rotonda, Roma', lat: 41.8986, lng: 12.4769 },
    { id: uid(), time: '12:30', title: 'Roscioli Salumeria', category: 'Öğle yemeği', duration: '1,5 saat', notes: 'Rezervasyon iyi fikir. Karbonarayı paylaş.', address: 'Via dei Giubbonari 21, Roma', lat: 41.8943, lng: 12.4722 },
    { id: uid(), time: '15:00', title: 'Trastevere sokakları', category: 'Mahalle', duration: '2 saat', notes: 'Ana meydandan sap; Via della Lungaretta çevresini dolaş.', address: 'Trastevere, Roma', lat: 41.8897, lng: 12.4708 },
    { id: uid(), time: '19:15', title: 'Gianicolo gün batımı', category: 'Manzara', duration: '1 saat', notes: 'Yokuş için taksi seçeneğini açık tut.', address: 'Piazzale Giuseppe Garibaldi, Roma', lat: 41.8914, lng: 12.4615 }
  ];
  trip.days[1].title = 'Monti ve tasarım';
  trip.days[2].title = 'Borghese ve kuzey';
  trip.days[3].title = 'Yavaş bir kapanış';
  trip.expenses = [
    { id: uid(), title: 'Otel', category: 'Konaklama', amount: 540, currency: 'EUR', createdAt: new Date().toISOString() },
    { id: uid(), title: 'Havalimanı treni', category: 'Ulaşım', amount: 36, currency: 'EUR', createdAt: new Date().toISOString() }
  ];
  return trip;
}

