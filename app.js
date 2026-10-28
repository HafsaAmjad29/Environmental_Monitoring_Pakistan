
'use strict';

/* ==========================================
   ENVIRONMENTAL MONITORING PAKISTAN
   Leaflet + Express + PostgreSQL/PostGIS
   ========================================== */

// Helpers
const $ = id => document.getElementById(id);

const esc = s => String(s ?? '').replace(
  /[&<>"']/g,
  c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c])
);

const fmt = (v, unit = '') =>
  v === null || v === undefined ? '–' : v + unit;

// Station types and marker icons
const TYPES = {
  'Weather Station': {
    c: '#c62828',
    g: '<circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>'
  },
  'Rain Gauge': {
    c: '#1565c0',
    g: '<path d="M12 4c3 4 5 6.5 5 9a5 5 0 0 1-10 0c0-2.5 2-5 5-9z"/>'
  },
  'Air Quality': {
    c: '#7b1fa2',
    g: '<path d="M4 9h10a2.5 2.5 0 1 0-2.5-2.5M4 13h14a2.5 2.5 0 1 1-2.5 2.5M4 17h7"/>'
  },
  'River Gauge': {
    c: '#00796b',
    g: '<path d="M3 9c3-3 6 3 9 0s6 3 9 0M3 15c3-3 6 3 9 0s6 3 9 0"/>'
  }
};

const STATUS = {
  Active: 'Reporting normally',
  Maintenance: 'Under maintenance',
  Inactive: 'Not reporting'
};

const PK = [[23.5, 60.8], [37.2, 77.9]];

// Application state
const S = {
  fc: [],
  byId: {},
  sel: null,
  editId: null,
  obId: null,
  stats: [],
  pick: false,
  after: null,
  clusterOn: true,
  vis: Object.fromEntries(
    Object.keys(TYPES).map(t => [t, true])
  ),
  groups: {},
  markers: {},
  token: sessionStorage.getItem('em_token'),
  user: sessionStorage.getItem('em_user')
};

/* ========== NOTIFICATIONS ========== */

let toastTimer;

function toast(message) {
  const el = $('toast');

  el.textContent = message;
  el.classList.add('show');

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 3500);
}

function errList(id, errors) {
  $(id).innerHTML = [].concat(errors)
    .map(e => `<li>${esc(e)}</li>`)
    .join('');
}

/* ========== API ========== */

async function api(url, method = 'GET', body) {
  let response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body ? {
          'Content-Type': 'application/json'
        } : {}),
        ...(S.token ? {
          Authorization: 'Bearer ' + S.token
        } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    throw ['Cannot connect to the API. Check the server.'];
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401 && S.token) {
      setUser(null);
    }

    throw data.errors || [
      `Request failed (${response.status})`
    ];
  }

  return data;
}

function setApiStatus(ok) {
  const el = $('apiStatus');

  el.dataset.s = ok ? 'ok' : 'off';
  el.lastElementChild.textContent =
    ok ? 'API online' : 'API offline';
}

/* ========== MAP INITIALIZATION ========== */

const map = L.map('map', {
  minZoom: 4,
  maxBounds: [[15, 50], [45, 90]],
  zoomControl: true
}).fitBounds(PK);

// Two basemaps
const BASES = {
  'OpenStreetMap': L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }
  ),

  'Satellite (Esri)': L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      maxNativeZoom: 18,
      attribution: 'Tiles &copy; Esri'
    }
  )
};

// Default to OpenStreetMap
let baseName = 'OpenStreetMap';
BASES[baseName].addTo(map);

// Scale bar
L.control.scale({
  imperial: false,
  position: 'bottomleft'
}).addTo(map);

// Leaflet layer control
const layerControl = L.control.layers(
  BASES,
  {},
  {
    collapsed: true,
    position: 'topright'
  }
).addTo(map);

map.on('baselayerchange', e => {
  baseName = e.name;
});

map.on('overlayadd overlayremove', e => {
  const type = Object.keys(S.groups).find(
    t => S.groups[t] === e.layer
  );

  if (!type) return;

  S.vis[type] = e.type === 'overlayadd';
  renderLegend();
});

/* ========== STATION MARKERS ========== */

function pinHtml(station) {
  const t = TYPES[station.station_type];

  return `
    <span class="pin s-${esc(station.status || 'Active')}"
          style="background:${t.c}">
      <svg viewBox="0 0 24 24"
           width="16" height="16"
           fill="none" stroke="#fff"
           stroke-width="2"
           stroke-linecap="round"
           stroke-linejoin="round"
           aria-hidden="true">
        ${t.g}
      </svg>
    </span>
  `;
}

function makeGroups() {
  // Remove previous groups
  Object.values(S.groups).forEach(group => {
    layerControl.removeLayer(group);
    map.removeLayer(group);
  });

  S.groups = {};

  // Create one overlay per station type
  for (const type in TYPES) {
    const group = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 55,
      spiderfyOnMaxZoom: true,

      disableClusteringAtZoom:
        S.clusterOn ? undefined : 1,

      iconCreateFunction: cluster => {
        const n = cluster.getChildCount();

        const size =
          n < 5 ? 36 :
          n < 10 ? 44 : 52;

        return L.divIcon({
          className: 'cl',
          iconSize: [size, size],
          html: `
            <div style="background:${TYPES[type].c}">
              ${n}
            </div>
          `
        });
      }
    });

    S.groups[type] = group;

    layerControl.addOverlay(group, type);

    if (S.vis[type]) {
      map.addLayer(group);
    }
  }
}

function render() {
  Object.values(S.groups).forEach(g => g.clearLayers());

  S.markers = {};

  S.fc.forEach(station => {
    const marker = L.marker(
      [station.lat, station.lon],
      {
        title: station.name,
        alt: station.name,
        icon: L.divIcon({
          className: '',
          html: pinHtml(station),
          iconSize: [30, 30],
          iconAnchor: [15, 15],
          popupAnchor: [0, -14]
        })
      }
    );

    marker.bindPopup(() => `
      <div class="pop">
        <b>${esc(station.name)}</b>
        <span>${esc(station.station_type)} · ${esc(station.status)}</span>
        <br>
        <button data-a="details" data-id="${station.id}">
          View details
        </button>
      </div>
    `);

    marker.on('click', () => {
      select(station.id, false);
    });

    S.markers[station.id] = marker;
    S.groups[station.station_type].addLayer(marker);
  });

  $('sShown').textContent = S.fc.length;
  renderList();
}

function renderList() {
  $('list').innerHTML = S.fc.map(station => `
    <li>
      <button class="item${station.id === S.sel ? ' on' : ''}"
              data-id="${station.id}">
        <span class="dot"
              style="background:${TYPES[station.station_type].c}"></span>
        <span>
          <b>${esc(station.name)}</b>
          <small>
            ${esc(station.station_type)} ·
            ${esc(station.city || station.province)} ·
            ${esc(station.status)}
          </small>
        </span>
      </button>
    </li>
  `).join('');

  $('listEmpty').hidden = S.fc.length > 0;
  $('listCount').textContent = S.fc.length;
}

/* ========== DATABASE DATA ========== */

function getParams() {
  const params = new URLSearchParams();

  [
    ['type', 'fType'],
    ['province', 'fProv'],
    ['status', 'fStatus'],
    ['source', 'fSource'],
    ['q', 'q']
  ].forEach(([key, id]) => {
    const value = $(id).value.trim();

    if (value) params.set(key, value);
  });

  return params;
}

async function load({ fit = false, manual = false } = {}) {
  const btn = $('refreshBtn');
  btn.disabled = true;
  btn.textContent = '⟳ Refreshing...';

  try {
    const [fc, stats, health] = await Promise.all([
      api('/api/stations?' + getParams()),
      api('/api/stats'),
      api('/api/health')
    ]);

    S.fc = fc.features.map(feature => ({
      ...feature.properties,
      lon: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1]
    }));

    S.byId = Object.fromEntries(
      S.fc.map(s => [s.id, s])
    );

    S.stats = stats;

    $('sTotal').textContent = health.stations;
    $('sObs').textContent = health.observations;
    $('lastUpd').textContent = new Date().toLocaleTimeString();

    setApiStatus(true);
    render();
    renderLegend();

    if (S.sel && !S.byId[S.sel]) {
      S.sel = null;

      $('selBody').innerHTML =
        '<p class="empty">Select a station to see its details.</p>';
    } else if (S.sel) {
      renderSel();
    }

    if (fit && S.fc.length) {
      map.fitBounds(
        L.latLngBounds(
          S.fc.map(s => [s.lat, s.lon])
        ).pad(0.3),
        { maxZoom: 9 }
      );
    }

    if (manual) {
      toast(`${S.fc.length} stations loaded from PostgreSQL`);
    }

  } catch (error) {
    setApiStatus(false);
    toast([].concat(error).join(' '));
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Refresh';
  }
}

async function loadProvinces() {
  const provinces = await api('/api/provinces');
  const selected = $('fProv').value;

  $('fProv').length = 1;

  provinces.forEach(p => {
    $('fProv').add(new Option(p, p));
  });

  $('fProv').value = selected;

  $('provList').innerHTML = provinces
    .map(p => `<option value="${esc(p)}">`)
    .join('');
}

async function ping() {
  try {
    const health = await api('/api/health');

    setApiStatus(true);
    $('sTotal').textContent = health.stations;
    $('sObs').textContent = health.observations;
  } catch {
    setApiStatus(false);
  }
}

/* ========== MAP LEGEND ========== */

function renderLegend() {
  const counts = Object.fromEntries(
    S.stats.map(r => [r.station_type, r.count])
  );

  $('legend').innerHTML = `
    <h4>Station types</h4>
    <ul class="legend">
      ${Object.keys(TYPES).map(type => `
        <li>
          <label>
            <input type="checkbox"
                   data-vis="${type}"
                   ${S.vis[type] ? 'checked' : ''}>
            ${pinHtml({ station_type: type })}
            <span>${type}</span>
            <em>${counts[type] || 0}</em>
          </label>
        </li>
      `).join('')}
    </ul>

    <h4>Station status</h4>
    <ul class="legend">
      ${Object.keys(STATUS).map(status => `
        <li>
          <label>
            ${pinHtml({
              station_type: 'Rain Gauge',
              status
            })}
            <span>${status}</span>
          </label>
        </li>
      `).join('')}
    </ul>

    <h4>Data source</h4>
    <p>
      <span class="tag Official">Official</span>
      <span class="tag Student">Student</span>
      <span class="tag Sample">Sample</span>
    </p>

    <p class="hint">
      Use the layer control in the upper-right corner to
      select basemaps and station overlays.
    </p>
  `;
}

$('legend').addEventListener('change', e => {
  const type = e.target.dataset.vis;

  if (!type) return;

  S.vis[type] = e.target.checked;

  if (e.target.checked) {
    map.addLayer(S.groups[type]);
  } else {
    map.removeLayer(S.groups[type]);
  }
});

/* ========== SIDEBAR TABS ========== */

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tabName;

    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle(
      'active-panel',
      panel.dataset.panel === tabName
    );
  });

  $('side').scrollTop = 0;
  setTimeout(() => map.invalidateSize(), 100);
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    switchTab(btn.dataset.tab);
  });
});

$('legendToggle').addEventListener('click', () => {
  const legend = document.querySelector('.map-legend');
  legend.classList.toggle('collapsed');

  $('legendToggle').setAttribute(
    'aria-expanded',
    String(!legend.classList.contains('collapsed'))
  );
});

switchTab('overview');

/* ========== STATION SELECTION ========== */

function select(id, fly = true) {
  const station = S.byId[id];
  if (!station) return;

  S.sel = id;
  renderList();

  $('detSel').open = true;
  switchTab('overview');
  renderSel();

  if (fly) {
    const group = S.groups[station.station_type];

    if (!map.hasLayer(group)) {
      S.vis[station.station_type] = true;
      map.addLayer(group);
      renderLegend();
    }

    group.zoomToShowLayer(S.markers[id], () => {
      map.setView(
        [station.lat, station.lon],
        Math.max(map.getZoom(), 9)
      );

      S.markers[id].openPopup();
    });

    if (window.matchMedia('(max-width:860px)').matches) {
      document.body.classList.remove('drawer');
    }
  }
}

function renderSel() {
  const station = S.byId[S.sel];
  if (!station) return;

  $('selBody').innerHTML = `
    <div class="selhead">
      ${pinHtml(station)}
      <div>
        <h3>${esc(station.name)}</h3>
        <p>${esc(station.station_type)}</p>
      </div>
    </div>

    <dl class="kv">
      <dt>Status</dt>
      <dd>${esc(station.status)}</dd>

      <dt>Data source</dt>
      <dd>
        <span class="tag ${esc(station.data_source)}">
          ${esc(station.data_source)}
        </span>
      </dd>

      <dt>Province</dt>
      <dd>${esc(station.province)}</dd>

      <dt>City</dt>
      <dd>${esc(station.city || '–')}</dd>

      <dt>Elevation</dt>
      <dd>${fmt(station.elevation_m, ' m')}</dd>

      <dt>Coordinates</dt>
      <dd>${station.lat.toFixed(4)}, ${station.lon.toFixed(4)}</dd>
    </dl>

    <div class="row">
      <button class="btn primary" data-a="obs" data-id="${station.id}">
        Add record
      </button>
      <button class="btn" data-a="edit" data-id="${station.id}">
        Edit
      </button>
      <button class="btn danger" data-a="del" data-id="${station.id}">
        Delete
      </button>
    </div>

    <h4>Database Observations</h4>
    <div id="recBox">
      <p class="hint">Loading records...</p>
    </div>

    <h4>Live Environmental Conditions</h4>
    <div id="liveBox">
      <p class="hint">Loading live data...</p>
    </div>
  `;

  loadRecords(station.id);
  loadLive(station);
}

async function loadRecords(id) {
  try {
    const rows = await api(
      `/api/stations/${id}/observations`
    );

    const html = rows.length
      ? `
        <table>
          <tr>
            <th>Date</th>
            <th>Rain</th>
            <th>°C</th>
            <th>PM2.5</th>
          </tr>
          ${rows.slice(0, 8).map(o => `
            <tr>
              <td>${new Date(o.observed_at).toLocaleDateString()}</td>
              <td>${fmt(o.rainfall_mm)}</td>
              <td>${fmt(o.temperature_c)}</td>
              <td>${fmt(o.pm25)}</td>
            </tr>
          `).join('')}
        </table>
      `
      : '<p class="hint">No observations available.</p>';

    if (S.sel === id && $('recBox')) {
      $('recBox').innerHTML = html;
    }
  } catch (error) {
    if (S.sel === id && $('recBox')) {
      $('recBox').textContent =
        [].concat(error).join(' ');
    }
  }
}

/* ========== LIVE ENVIRONMENTAL DATA ========== */

function aqi(value) {
  if (value == null) return '–';
  if (value <= 50) return 'Good';
  if (value <= 100) return 'Moderate';
  if (value <= 150) return 'Unhealthy for sensitive groups';
  if (value <= 200) return 'Unhealthy';
  if (value <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

async function loadLive(station) {
  const coords =
    `latitude=${station.lat}&longitude=${station.lon}`;

  const [weather, air] = await Promise.allSettled([
    fetch(
      `https://api.open-meteo.com/v1/forecast?${coords}&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m`
    ).then(r => {
      if (!r.ok) throw new Error('Weather unavailable');
      return r.json();
    }),

    fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?${coords}&current=pm2_5,us_aqi`
    ).then(r => {
      if (!r.ok) throw new Error('Air quality unavailable');
      return r.json();
    })
  ]);

  if (S.sel !== station.id || !$('liveBox')) return;

  const wc = weather.status === 'fulfilled'
    ? weather.value.current
    : null;

  const ac = air.status === 'fulfilled'
    ? air.value.current
    : null;

  if (!wc && !ac) {
    $('liveBox').innerHTML =
      '<p class="hint">Live data unavailable.</p>';
    return;
  }

  $('liveBox').innerHTML = `
    <dl class="kv">
      ${wc ? `
        <dt>Temperature</dt>
        <dd>${fmt(wc.temperature_2m, ' °C')}</dd>

        <dt>Humidity</dt>
        <dd>${fmt(wc.relative_humidity_2m, ' %')}</dd>

        <dt>Precipitation</dt>
        <dd>${fmt(wc.precipitation, ' mm')}</dd>

        <dt>Wind speed</dt>
        <dd>${fmt(wc.wind_speed_10m, ' km/h')}</dd>
      ` : ''}

      ${ac ? `
        <dt>PM2.5</dt>
        <dd>${fmt(ac.pm2_5, ' µg/m³')}</dd>

        <dt>US AQI</dt>
        <dd>${fmt(ac.us_aqi)} (${aqi(ac.us_aqi)})</dd>
      ` : ''}
    </dl>

    <p class="hint">
      Modelled data from Open-Meteo. Not a direct
      measurement from this station.
    </p>
  `;
}

/* ========== AUTHENTICATION ========== */

function setUser(user, token) {
  S.user = user;
  S.token = token || null;

  try {
    if (user) {
      sessionStorage.setItem('em_token', S.token);
      sessionStorage.setItem('em_user', user);
    } else {
      sessionStorage.removeItem('em_token');
      sessionStorage.removeItem('em_user');
    }
  } catch {}

  $('loginBtn').hidden = !!user;
  $('userBox').hidden = !user;
  $('userName').textContent = user || '';

  $('authHint').textContent = user
    ? 'You can add and edit database records.'
    : 'Viewing is open to everyone. Log in to add or edit records.';
}

function gated(fn) {
  if (S.token) return fn();

  S.after = fn;
  errList('loginErr', []);
  $('dlgLogin').showModal();
  toast('Please log in to modify records.');
}

$('loginBtn').onclick = () => {
  S.after = null;
  errList('loginErr', []);
  $('dlgLogin').showModal();
};

$('logoutBtn').onclick = () => {
  setUser(null);
  toast('Logged out');
};

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();

  try {
    const result = await api(
      '/api/login',
      'POST',
      Object.fromEntries(new FormData(e.target))
    );

    setUser(result.user, result.token);

    e.target.reset();
    $('dlgLogin').close();
    toast('Welcome, ' + result.user);

    if (S.after) {
      const fn = S.after;
      S.after = null;
      fn();
    }

  } catch (error) {
    errList('loginErr', error);
  }
});

document.querySelectorAll('[data-close]').forEach(btn => {
  btn.onclick = () => btn.closest('dialog').close();
});

/* ========== ADD / EDIT STATION ========== */

function openStation(id) {
  gated(() => {
    S.editId = id || null;

    const form = $('stForm');

    form.reset();
    errList('stErr', []);

    $('stTitle').textContent =
      id ? 'Edit Station' : 'Add Station';

    if (id) {
      const station = S.byId[id];

      [
        'name', 'station_type', 'province',
        'city', 'elevation_m', 'status',
        'data_source', 'lat', 'lon'
      ].forEach(key => {
        form.elements[key].value = station[key] ?? '';
      });
    }

    $('dlgStation').showModal();
  });
}

$('btnAdd').onclick = () => openStation();

/* Pick coordinates on map */
$('btnPick').onclick = () => {
  S.pick = true;
  $('dlgStation').close();

  $('pickBanner').hidden = false;
  $('map').classList.add('picking');

  document.body.classList.remove('drawer');
};

function endPick() {
  S.pick = false;

  $('pickBanner').hidden = true;
  $('map').classList.remove('picking');
  $('dlgStation').showModal();
}

$('pickCancel').onclick = endPick;

map.on('click', async e => {
  if (!S.pick) return;

  const form = $('stForm').elements;

  form.lat.value = e.latlng.lat.toFixed(5);
  form.lon.value = e.latlng.lng.toFixed(5);

  endPick();

  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=en&lat=${e.latlng.lat}&lon=${e.latlng.lng}`;

    const response = await fetch(url);
    const result = await response.json();
    const address = result.address || {};

    const fix = {
      'Azad Kashmir': 'Azad Jammu and Kashmir',
      'Islamabad': 'Islamabad Capital Territory'
    };

    if (!form.city.value) {
      form.city.value =
        address.city ||
        address.town ||
        address.county ||
        address.state_district ||
        '';
    }

    if (!form.province.value && address.state) {
      form.province.value =
        fix[address.state] || address.state;
    }
  } catch {}
});

$('stForm').addEventListener('submit', async e => {
  e.preventDefault();
  errList('stErr', []);

  try {
    const id = S.editId;

    const result = await api(
      id ? `/api/stations/${id}` : '/api/stations',
      id ? 'PUT' : 'POST',
      Object.fromEntries(new FormData(e.target))
    );

    $('dlgStation').close();

    toast(
      id
        ? 'Station updated in PostgreSQL'
        : 'Station created in PostgreSQL'
    );

    // Clear filters so newly created records are visible
    if (!id) {
      ['fType', 'fProv', 'fStatus', 'fSource', 'q']
        .forEach(key => $(key).value = '');
    }

    await Promise.all([
      load(),
      loadProvinces()
    ]);

    if (!id && result.id) {
      select(result.id, true);
    } else if (id && S.byId[id]) {
      select(id, true);
    }
  } catch (error) {
    errList('stErr', error);
  }
});

/* ========== ADD OBSERVATION ========== */

function openObs(id) {
  gated(() => {
    S.obId = id;

    $('obForm').reset();
    errList('obErr', []);

    $('obTitle').textContent =
      'Add Observation: ' + S.byId[id].name;

    $('dlgObs').showModal();
  });
}

$('obForm').addEventListener('submit', async e => {
  e.preventDefault();

  const data = Object.fromEntries(
    new FormData(e.target)
  );

  if (
    !data.rainfall_mm &&
    !data.temperature_c &&
    !data.pm25
  ) {
    errList('obErr', 'Enter at least one measurement.');
    return;
  }

  try {
    await api(
      `/api/stations/${S.obId}/observations`,
      'POST',
      data
    );

    $('dlgObs').close();
    toast('Observation saved in PostgreSQL');

    await load();
  } catch (error) {
    errList('obErr', error);
  }
});

/* ========== DELETE STATION ========== */

function del(id) {
  gated(async () => {
    const station = S.byId[id];

    if (!confirm(
      `Delete "${station.name}" and all its observations?`
    )) return;

    try {
      await api(`/api/stations/${id}`, 'DELETE');

      S.sel = null;
      $('selBody').innerHTML =
        '<p class="empty">Station deleted.</p>';

      await Promise.all([
        load(),
        loadProvinces()
      ]);

      toast('Station deleted from PostgreSQL');
    } catch (error) {
      toast([].concat(error).join(' '));
    }
  });
}

/* ========== GLOBAL CLICK ACTIONS ========== */

document.addEventListener('click', e => {
  const action = e.target.closest('[data-a]');

  if (action) {
    const id = Number(action.dataset.id);
    const type = action.dataset.a;

    if (type === 'obs') openObs(id);
    else if (type === 'edit') openStation(id);
    else if (type === 'del') del(id);
    else if (type === 'details') {
      select(id, false);

      if (window.matchMedia('(max-width:860px)').matches) {
        document.body.classList.add('drawer');
      }
    }

    return;
  }

  const item = e.target.closest('#list [data-id]');

  if (item) {
    select(Number(item.dataset.id), true);
  }
});

/* ========== MOBILE SIDEBAR ========== */

$('menuBtn').onclick = () => {
  document.body.classList.toggle('drawer');
};

$('backdrop').onclick = () => {
  document.body.classList.remove('drawer');
};

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.body.classList.remove('drawer');
  }
});

/* ========== SEARCH AND FILTERS ========== */

$('refreshBtn').onclick = () => load({
  manual: true
});

['fType', 'fProv', 'fStatus', 'fSource'].forEach(id => {
  $(id).addEventListener('change', () => {
    load({ fit: true });
  });
});

let searchTimer;

$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);

  searchTimer = setTimeout(() => {
    load({ fit: true });
  }, 300);
});

$('btnReset').onclick = () => {
  ['fType', 'fProv', 'fStatus', 'fSource', 'q']
    .forEach(id => $(id).value = '');

  load();
  map.fitBounds(PK);
};

$('btnFit').onclick = () => {
  map.fitBounds(PK);
};

/* ========== CLUSTER CONTROL ========== */

$('optCluster').onchange = e => {
  S.clusterOn = e.target.checked;
  makeGroups();
  render();
  renderLegend();
};

/* ========== AUTO REFRESH ========== */

let autoTimer;

$('optAuto').onchange = e => {
  clearInterval(autoTimer);

  if (e.target.checked) {
    autoTimer = setInterval(() => load(), 60000);
    toast('Auto-refresh enabled');
  } else {
    toast('Auto-refresh disabled');
  }
};

/* ========== PLACE SEARCH ========== */

$('placeForm').addEventListener('submit', async e => {
  e.preventDefault();

  const query = $('placeQ').value.trim();
  if (!query) return;

  try {
    const url =
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=pk&accept-language=en&q=${encodeURIComponent(query)}`;

    const response = await fetch(url);
    if (!response.ok) throw new Error('Search unavailable');

    const results = await response.json();

    if (!results.length) {
      toast('No matching place found in Pakistan.');
      return;
    }

    map.flyTo([
      Number(results[0].lat),
      Number(results[0].lon)
    ], 10);

    toast(
      'Showing: ' +
      results[0].display_name.split(',').slice(0, 2).join(',')
    );
  } catch {
    toast('Location search is unavailable right now.');
  }
});

/* ========== USER LOCATION ========== */

$('btnLocate').onclick = () => {
  map.locate({
    setView: true,
    maxZoom: 11
  });
};

let userMarker;

map.on('locationfound', e => {
  if (userMarker) {
    map.removeLayer(userMarker);
  }

  userMarker = L.circleMarker(e.latlng, {
    radius: 8,
    color: '#fff',
    weight: 3,
    fillColor: '#1976d2',
    fillOpacity: 1
  }).addTo(map)
    .bindPopup('You are here')
    .openPopup();
});

map.on('locationerror', () => {
  toast('Location unavailable. Check browser permissions.');
});

/* ========== DATA EXPORT ========== */

function download(filename, mimeType, content) {
  const blob = new Blob([content], {
    type: mimeType
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  link.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('btnGeo').onclick = () => {
  const collection = {
    type: 'FeatureCollection',
    features: S.fc.map(
      ({ lat, lon, latest, ...properties }) => ({
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [lon, lat]
        },
        properties
      })
    )
  };

  download(
    'environmental-monitoring-pakistan.geojson',
    'application/geo+json',
    JSON.stringify(collection, null, 2)
  );
};

$('btnCsv').onclick = () => {
  const columns = [
    'id', 'name', 'station_type', 'province',
    'city', 'elevation_m', 'status',
    'data_source', 'lat', 'lon'
  ];

  const cell = value => {
    let v = String(value ?? '');

    // Prevent spreadsheet formula injection
    if (/^[=+\-@]/.test(v)) v = "'" + v;

    return '"' + v.replace(/"/g, '""') + '"';
  };

  const csv = [
    columns.join(','),
    ...S.fc.map(station =>
      columns.map(c => cell(station[c])).join(',')
    )
  ].join('\n');

  download(
    'environmental-monitoring-pakistan.csv',
    'text/csv',
    csv
  );
};

/* ========== THEME ========== */

$('themeBtn').onclick = () => {
  const root = document.documentElement;

  const newTheme =
    root.dataset.theme === 'dark'
      ? 'light'
      : 'dark';

  root.dataset.theme = newTheme;

  try {
    localStorage.setItem('em_theme', newTheme);
  } catch {}
};

try {
  const savedTheme = localStorage.getItem('em_theme');

  if (savedTheme === 'dark' || savedTheme === 'light') {
    document.documentElement.dataset.theme = savedTheme;
  }
} catch {}

/* ========== INITIALIZATION ========== */

// Populate station type selectors
Object.keys(TYPES).forEach(type => {
  $('fType').add(new Option(type, type));
  $('ft').add(new Option(type, type));
});

// Restore login session
setUser(S.user, S.token);

if (S.token) {
  api('/api/me').catch(() => {});
}

// Initialize station overlays
makeGroups();

// Load PostgreSQL records
loadProvinces().catch(() => {});
load();

// Keep API status updated
setInterval(ping, 30000);
