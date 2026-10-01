import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

let activeMap;

export function destroyRouteMap() {
  activeMap?.remove();
  activeMap = null;
}

export function renderRouteMap(element, stops = []) {
  destroyRouteMap();
  if (!element) return;
  const located = stops.filter((stop) => Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lng)));
  if (!located.length) {
    element.innerHTML = '<div class="map-empty"><strong>Harita için bir yer seç.</strong><span>Arama sonucundan eklenen duraklar burada rotaya dönüşür.</span></div>';
    return;
  }
  element.innerHTML = '';
  activeMap = L.map(element, { zoomControl: true, scrollWheelZoom: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(activeMap);
  const points = located.map((stop, index) => {
    const point = [Number(stop.lat), Number(stop.lng)];
    L.marker(point, {
      icon: L.divIcon({ className: 'roamly-map-marker', html: `<span><b>${index + 1}</b></span>`, iconSize: [30, 30], iconAnchor: [15, 15] })
    }).addTo(activeMap).bindPopup(`<strong>${String(stop.title || '').replace(/[<>&"]/g, '')}</strong><br>${String(stop.time || '').replace(/[<>&"]/g, '')}`);
    return point;
  });
  if (points.length > 1) L.polyline(points, { color: '#153c35', weight: 4, opacity: .8, dashArray: '8 8' }).addTo(activeMap);
  activeMap.fitBounds(L.latLngBounds(points).pad(.18), { maxZoom: 15 });
  setTimeout(() => activeMap?.invalidateSize(), 50);
}
