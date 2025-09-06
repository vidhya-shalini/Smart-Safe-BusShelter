// script.js — Robust handlers for all buttons and features
// Put <script src="script.js"></script> at the end of your HTML body.

// Wrap in DOMContentLoaded to ensure elements exist
document.addEventListener('DOMContentLoaded', () => {

  console.log('script.js loaded');

  // --- Helper: bind click to any of several possible IDs if present ---
  function bindIfExists(ids, handler) {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', handler);
        console.log(`bound handler to #${id}`);
      }
    });
  }

  // --- Toast helper ---
  const toastEl = document.getElementById('toast');
  function toast(msg, ms = 2200) {
    if (!toastEl) { console.log('toast:', msg); return; }
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    // ensure visible
    toastEl.style.opacity = '1';
    setTimeout(() => {
      toastEl.classList.add('hidden');
    }, ms);
  }

  // --- Map init (wait for Leaflet L) ---
  if (typeof L === 'undefined') {
    console.error('Leaflet (L) is not available. Make sure leaflet.js is loaded before script.js');
    toast('Map library not loaded');
    return;
  }

  const DEFAULT_CENTER = [13.0827, 80.2707]; // Chennai fallback
  const map = L.map('map', { zoomControl: true }).setView(DEFAULT_CENTER, 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // Icons
  const iconUser = L.icon({ iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png', iconSize: [25,41], iconAnchor:[12,41] });
  const iconShelter = L.divIcon({ html: '<div style="width:14px;height:14px;border-radius:6px;background:#ffd166;border:2px solid #fff"></div>', className: '' });
  const iconPolice = L.divIcon({ html: '<div style="width:14px;height:14px;border-radius:6px;background:#ff6b6b;border:2px solid #fff"></div>', className: '' });
  const iconBus = L.divIcon({ html: '<div style="width:14px;height:14px;border-radius:6px;background:#7cf3b6;border:2px solid #fff"></div>', className: '' });

  // State
  let userMarker = null;
  let shelterMarker = null;
  let policeMarkers = [];      // array of markers
  let busData = [];            // array of bus objects {id,route,pos:[lat,lng],eta}
  let busMarkers = {};         // map id -> marker
  let busTimers = [];          // movement timers

  // --- Location handling ---
  function dropShelter(latlng) {
    if (!shelterMarker) {
      shelterMarker = L.marker(latlng, { icon: iconShelter }).addTo(map).bindPopup('Smart Shelter');
    } else {
      shelterMarker.setLatLng(latlng);
    }
  }

  function setUserMarker(latlng) {
    if (!userMarker) {
      userMarker = L.marker(latlng, { icon: iconUser }).addTo(map).bindPopup('You are here');
    } else userMarker.setLatLng(latlng);
  }

  async function initLocation() {
    if (!navigator.geolocation) {
      map.setView(DEFAULT_CENTER, 13);
      dropShelter(DEFAULT_CENTER);
      toast('Geolocation not supported — using default.');
      return;
    }
    navigator.geolocation.getCurrentPosition(pos => {
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      setUserMarker(latlng);
      map.setView(latlng, 15);
      dropShelter(latlng);
      toast('Location detected');
    }, err => {
      console.warn('geolocation failed', err);
      map.setView(DEFAULT_CENTER, 13);
      dropShelter(DEFAULT_CENTER);
      toast('Location blocked/unavailable — using default.');
    }, { enableHighAccuracy: true, timeout: 8000 });
  }
  // Start location (non-blocking)
  initLocation();

  // --- Utility for nearest police ---
  function nearestPoliceTo(latlng) {
    if (!policeMarkers.length) return null;
    let best = null, bestD = Infinity;
    policeMarkers.forEach(m => {
      const d = map.distance(latlng, m.getLatLng());
      if (d < bestD) { bestD = d; best = m; }
    });
    return best ? { marker: best, dist: bestD } : null;
  }

  // --- Overpass (fetch police) with graceful fallback ---
  async function findNearbyPolice(latlng, radius = 2000) {
    const [lat, lon] = latlng;
    const query = `
[out:json][timeout:25];
(
  node["amenity"="police"](around:${radius},${lat},${lon});
  way["amenity"="police"](around:${radius},${lat},${lon});
  relation["amenity"="police"](around:${radius},${lat},${lon});
);
out center;
    `;
    // remove old markers
    policeMarkers.forEach(m => map.removeLayer(m));
    policeMarkers = [];
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query)
      });
      if (!res.ok) throw new Error('Overpass response ' + res.status);
      const json = await res.json();
      if (!json.elements || json.elements.length === 0) {
        toast('No police stations found nearby (Overpass).');
        return [];
      }
      json.elements.forEach(el => {
        const ll = el.type === 'node' ? [el.lat, el.lon] : [el.center.lat, el.center.lon];
        const name = (el.tags && (el.tags.name || el.tags['name:en'])) || 'Police Station';
        const m = L.marker(ll, { icon: iconPolice }).addTo(map).bindPopup(`<b>${name}</b>`);
        policeMarkers.push(m);
      });
      toast(`Found ${policeMarkers.length} police station(s).`);
      return policeMarkers;
    } catch (e) {
      console.error('Overpass failed:', e);
      // fallback: add a few simulated police points around latlng
      toast('Overpass failed — showing simulated police points.');
      const fallback = [
        [lat + 0.0015, lon + 0.0012],
        [lat - 0.0012, lon - 0.0016],
        [lat + 0.0020, lon - 0.0009]
      ];
      fallback.forEach((ll, i) => {
        const m = L.marker(ll, { icon: iconPolice }).addTo(map).bindPopup(`<b>Police (sim ${i+1})</b>`);
        policeMarkers.push(m);
      });
      return policeMarkers;
    }
  }

  // --- Bus simulation functions ---
  function setupBusesAround(centerLatLng) {
    // clear previous simulation
    Object.values(busMarkers).forEach(m => map.removeLayer(m));
    busMarkers = {};
    busTimers.forEach(t => clearInterval(t));
    busTimers = [];
    busData = [
      { id: '24B', route: 'Central → Tech Park', pos: [centerLatLng[0] + 0.0017, centerLatLng[1] - 0.0024], eta: 5 },
      { id: '45C', route: 'Market → University', pos: [centerLatLng[0] - 0.0020, centerLatLng[1] + 0.0015], eta: 12 },
      { id: '101', route: 'Airport → CBD', pos: [centerLatLng[0] + 0.0026, centerLatLng[1] + 0.0022], eta: 22 }
    ];
    // add markers
    busData.forEach(b => {
      const m = L.marker(b.pos, { icon: iconBus }).addTo(map).bindPopup(`<b>Bus ${b.id}</b><br>${b.route}<br>ETA ${b.eta} min`);
      busMarkers[b.id] = m;
    });
    // start movement
    startBusMovement();
    renderBusList();
  }

  function renderBusList() {
    const busListEl = document.getElementById('busList') || document.getElementById('bus-list');
    if (!busListEl) return;
    busListEl.innerHTML = '';
    if (!busData || busData.length === 0) {
      busListEl.innerHTML = '<div class="tiny muted">No active bus simulation.</div>';
      return;
    }
    busData.forEach(b => {
      const div = document.createElement('div');
      div.className = 'bus-item';
      div.innerHTML = `<div><strong>${b.id}</strong> <div class="tiny">• ${b.route}</div></div><div class="tiny">ETA: ${b.eta} min</div>`;
      busListEl.appendChild(div);
    });
  }

  function startBusMovement() {
    // stop old timers
    busTimers.forEach(t => clearInterval(t));
    busTimers = [];
    Object.entries(busMarkers).forEach(([id, marker]) => {
      const start = marker.getLatLng();
      let ang = Math.random() * Math.PI * 2;
      const timer = setInterval(() => {
        ang += 0.25;
        const r = 0.0008 + Math.random() * 0.0008;
        const nx = start.lat + Math.cos(ang) * r;
        const ny = start.lng + Math.sin(ang) * r;
        marker.setLatLng([nx, ny]);
        // update b.eta and popup
        for (const b of busData) {
          if (b.id === id) {
            b.eta = Math.max(1, b.eta + (Math.random() > 0.6 ? -1 : 1));
            marker.bindPopup(`<b>Bus ${b.id}</b><br>${b.route}<br>ETA ${b.eta} min`);
          }
        }
        renderBusList();
      }, 1200);
      busTimers.push(timer);
    });
  }

  // --- Button handlers (support multiple possible IDs) ---

  // Recenter / Locate button(s)
  bindIfExists(['btnRecenter', 'locate-btn', 'btnRecenter'], async () => {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => {
        const latlng = [pos.coords.latitude, pos.coords.longitude];
        setUserMarker(latlng);
        map.setView(latlng, 15);
        dropShelter(latlng);
        toast('Centered to your location');
      }, err => {
        toast('Unable to get location (allow permissions or use secure origin)');
        console.warn(err);
      });
    } else {
      toast('Geolocation not supported.');
    }
  });

  // Nearby Police
  bindIfExists(['btnNearbyPolice', 'police-btn', 'btnNearbyPolice'], async () => {
    const loc = userMarker ? userMarker.getLatLng() : (shelterMarker ? shelterMarker.getLatLng() : map.getCenter());
    const latlng = [loc.lat, loc.lng];
    await findNearbyPolice(latlng);
    if (policeMarkers.length) {
      const grp = L.featureGroup([...policeMarkers, ...(userMarker ? [userMarker] : []), ...(shelterMarker ? [shelterMarker] : [])]);
      map.fitBounds(grp.getBounds().pad(0.2));
    }
  });

  // Show / Track Buses
  // If 'btnTrackBus' toggles movement on/off, support both 'btnTrackBus' and 'bus-btn' and 'btnShowBus'
  bindIfExists(['btnTrackBus', 'bus-btn', 'btnShowBus', 'btnTrackBus'], () => {
    const center = shelterMarker ? shelterMarker.getLatLng() : (userMarker ? userMarker.getLatLng() : map.getCenter());
    const centerArr = [center.lat, center.lng];
    // If no buses present, start; else stop
    if (Object.keys(busMarkers).length === 0) {
      setupBusesAround(centerArr);
      toast('Bus simulation started');
    } else {
      // stop simulation
      busTimers.forEach(t => clearInterval(t));
      busTimers = [];
      Object.values(busMarkers).forEach(m => map.removeLayer(m));
      busMarkers = {};
      busData = [];
      renderBusList();
      toast('Bus simulation stopped');
    }
  });

  // Shuffle ETAs (if button exists)
  bindIfExists(['btnShuffle', 'btnShuffle'], () => {
    busData.forEach(b => b.eta = Math.max(1, b.eta + (Math.random() > 0.5 ? -1 : 1)));
    // update popups
    busData.forEach(b => {
      if (busMarkers[b.id]) busMarkers[b.id].bindPopup(`<b>Bus ${b.id}</b><br>${b.route}<br>ETA ${b.eta} min`);
    });
    renderBusList();
    toast('Bus ETAs shuffled');
  });

  // Clear POIs
  bindIfExists(['clearPOI', 'btnClearPOI'], () => {
    policeMarkers.forEach(m => map.removeLayer(m));
    policeMarkers = [];
    toast('Cleared police markers');
  });

  // Fit All
  bindIfExists(['fitAll', 'btnFitAll'], () => {
    const layers = [...policeMarkers, ...(userMarker ? [userMarker] : []), ...(shelterMarker ? [shelterMarker] : [])];
    if (!layers.length) { toast('No features to fit'); return; }
    const group = L.featureGroup(layers);
    map.fitBounds(group.getBounds().pad(0.25));
  });

  // Weather refresh
  bindIfExists(['btnWeather', 'btnWeatherRefresh'], () => {
    const center = userMarker ? userMarker.getLatLng() : (shelterMarker ? shelterMarker.getLatLng() : map.getCenter());
    // simple open-meteo call
    const lat = center.lat || center[0], lon = center.lng || center[1];
    fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`)
      .then(r => r.json())
      .then(j => {
        const temp = j.current_weather?.temperature ?? '--';
        const wind = j.current_weather?.windspeed ?? '--';
        document.getElementById('temp') && (document.getElementById('temp').textContent = `${temp} °C`);
        document.getElementById('wind') && (document.getElementById('wind').textContent = `${wind} km/h`);
        // AQI proxy
        const aqi = Math.round(Math.max(10, 140 - (wind * 6)));
        document.getElementById('aqi') && (document.getElementById('aqi').textContent = aqi);
        toast('Weather updated');
      })
      .catch(e => { console.error('Weather failed', e); toast('Weather update failed'); });
  });

  // Toggle light & water
  bindIfExists(['toggleLight'], () => {
    const el = document.getElementById('lightState') || document.getElementById('light-status');
    if (el) el.textContent = el.textContent === 'ON' ? 'OFF' : 'ON';
    toast('Light toggled');
  });
  bindIfExists(['toggleWater'], () => {
    const el = document.getElementById('waterState') || document.getElementById('water-mode');
    if (el) el.textContent = el.textContent === 'AUTO' || el.textContent === 'Enabled' ? 'OFF' : 'AUTO';
    toast('Water toggled');
  });

  // SOS button(s)
  bindIfExists(['btnSOS', 'sos-btn', 'btnSOS'], async () => {
    // If police list empty, attempt to fetch
    const origin = userMarker ? userMarker.getLatLng() : (shelterMarker ? shelterMarker.getLatLng() : map.getCenter());
    if (!origin) { toast('No origin available for SOS'); return; }
    if (policeMarkers.length === 0) {
      await findNearbyPolice([origin.lat || origin[0], origin.lng || origin[1]]);
      if (policeMarkers.length === 0) {
        // fallback: ask to call emergency
        if (confirm('No nearby police found. Call emergency number 112?')) {
          window.location.href = 'tel:112';
          return;
        } else {
          toast('SOS cancelled');
          return;
        }
      }
    }
    const near = nearestPoliceTo(origin);
    if (!near) { toast('No police marker available'); return; }
    near.marker.openPopup();
    map.setView(near.marker.getLatLng(), 16);
    const dest = near.marker.getLatLng();
    const originLat = origin.lat || origin[0];
    const originLng = origin.lng || origin[1];
    const url = `https://www.google.com/maps/dir/?api=1&origin=${originLat},${originLng}&destination=${dest.lat},${dest.lng}&travelmode=walking`;
    window.open(url, '_blank');
    // audible + vibrate + copy
    try { new Audio('https://www.soundjay.com/button/beep-07a.mp3').play().catch(()=>{}); if (navigator.vibrate) navigator.vibrate([200,100,200]); } catch(e) {}
    const sosMsg = `SOS! I need help. Location: https://www.google.com/maps?q=${originLat},${originLng}`;
    try { await navigator.clipboard.writeText(sosMsg); } catch(e) { console.warn('clipboard failed', e); }
    toast('SOS sent. Navigation opened & location copied.');
  });

  // --- Kickoff: ensure shelter exists, try to drop at center if not provided ---
  setTimeout(() => {
    if (!shelterMarker) dropShelter(map.getCenter());
    // optionally start bus sim for convenience uncomment if you want:
    // setupBusesAround([map.getCenter().lat, map.getCenter().lng]);
  }, 900);

  // --- Debug helper: log to console if user reports "buttons not working" ---
  console.log('Ready: bound events for buttons (if they exist). If a button is not working:');
  console.log('- Check that your HTML has the expected button ID (see bindIfExists list).');
  console.log('- Open Browser DevTools Console (F12) and look for errors.');
  console.log('- If using file:// protocol, some features (geolocation, fetch) may be blocked; run a local server.');

  // --- End DOMContentLoaded ---
}); // end DOMContentLoaded
