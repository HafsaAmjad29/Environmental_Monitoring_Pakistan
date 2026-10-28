require('dotenv').config();
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Authentication: signed, expiring token (no extra dependency). Credentials come from .env ----
const { AUTH_USER, AUTH_PASS, AUTH_SECRET } = process.env;
const sign = d => crypto.createHmac('sha256', AUTH_SECRET || 'unset').update(d).digest('base64url');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function auth(req, res, next) {
  const [payload, sig] = (req.headers.authorization || '').replace('Bearer ', '').split('.');
  if (!payload || !sig || !AUTH_SECRET || !safeEq(sig, sign(payload))) return res.status(401).json({ errors: ['Please log in to make changes.'] });
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (p.exp < Date.now()) return res.status(401).json({ errors: ['Session expired. Please log in again.'] });
    req.user = p.u; next();
  } catch { res.status(401).json({ errors: ['Invalid session. Please log in again.'] }); }
}

const TYPES = ['Weather Station', 'Rain Gauge', 'Air Quality', 'River Gauge'];
const STATUSES = ['Active', 'Inactive', 'Maintenance'];
const SOURCES = ['Official', 'Student', 'Sample'];
const num = v => (v === '' || v === null || v === undefined ? null : Number(v));

function validateStation(b) {
  const e = [];
  const name = String(b.name || '').trim();
  if (name.length < 3 || name.length > 100) e.push('Name must be 3-100 characters.');
  if (!TYPES.includes(b.station_type)) e.push('Invalid station type.');
  if (!String(b.province || '').trim()) e.push('Province is required.');
  if (!STATUSES.includes(b.status)) e.push('Invalid status.');
  if (!SOURCES.includes(b.data_source)) e.push('Invalid data source.');
  const lat = num(b.lat), lon = num(b.lon), el = num(b.elevation_m);
  if (!Number.isFinite(lat) || lat < 23.5 || lat > 37.2) e.push('Latitude must be between 23.5 and 37.2 (Pakistan).');
  if (!Number.isFinite(lon) || lon < 60.8 || lon > 77.9) e.push('Longitude must be between 60.8 and 77.9 (Pakistan).');
  if (el !== null && (!Number.isInteger(el) || el < -50 || el > 9000)) e.push('Elevation must be a whole number from -50 to 9000 m.');
  return { e, v: { name, type: b.station_type, province: String(b.province || '').trim(), city: String(b.city || '').trim() || null, el, status: b.status, src: b.data_source, lat, lon } };
}

function validateObs(b) {
  const e = [];
  const r = num(b.rainfall_mm), t = num(b.temperature_c), p = num(b.pm25);
  if (r === null && t === null && p === null) e.push('Enter at least one value.');
  if (r !== null && !(r >= 0 && r <= 1000)) e.push('Rainfall must be 0-1000 mm.');
  if (t !== null && !(t >= -50 && t <= 60)) e.push('Temperature must be -50 to 60 C.');
  if (p !== null && !(p >= 0 && p <= 1000)) e.push('PM2.5 must be 0-1000.');
  return { e, v: { r, t, p } };
}

const SELECT = `
  SELECT s.id, s.name, s.station_type, s.province, s.city, s.elevation_m, s.status, s.data_source,
         ST_X(s.geom) AS lon, ST_Y(s.geom) AS lat,
         (SELECT row_to_json(o) FROM (SELECT observed_at, rainfall_mm, temperature_c, pm25
            FROM observations WHERE station_id = s.id ORDER BY observed_at DESC LIMIT 1) o) AS latest,
         (SELECT COUNT(*) FROM observations WHERE station_id = s.id)::int AS obs_count
  FROM stations s`;

const toFeature = r => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
  properties: (({ lon, lat, ...p }) => p)(r)
});
const wrap = (res, fn) => fn().catch(err => { console.error(err); res.status(500).json({ errors: ['Server or database error.'] }); });
const badId = (req, res) => { if (!Number.isInteger(+req.params.id)) { res.status(400).json({ errors: ['Invalid id.'] }); return true; } };

app.post('/api/login', (req, res) => {
  if (!AUTH_USER || !AUTH_PASS || !AUTH_SECRET) return res.status(503).json({ errors: ['Login is not configured. Set AUTH_USER, AUTH_PASS and AUTH_SECRET in server/.env.'] });
  const { username, password } = req.body || {};
  if (!safeEq(username || '', AUTH_USER) || !safeEq(password || '', AUTH_PASS)) return res.status(401).json({ errors: ['Wrong username or password.'] });
  const payload = Buffer.from(JSON.stringify({ u: AUTH_USER, exp: Date.now() + 8 * 3600e3 })).toString('base64url');
  res.json({ token: payload + '.' + sign(payload), user: AUTH_USER });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));
app.get('/api/health', (req, res) => wrap(res, async () => {
  const { rows } = await pool.query('SELECT (SELECT COUNT(*) FROM stations)::int AS stations, (SELECT COUNT(*) FROM observations)::int AS observations, now() AS server_time');
  res.json({ status: 'ok', ...rows[0] });
}));

// List + filter (type, province, status, name search) -> GeoJSON
app.get('/api/stations', (req, res) => wrap(res, async () => {
  const w = [], p = [];
  if (req.query.type)     { p.push(req.query.type);     w.push(`s.station_type = $${p.length}`); }
  if (req.query.province) { p.push(req.query.province); w.push(`s.province = $${p.length}`); }
  if (req.query.status)   { p.push(req.query.status);   w.push(`s.status = $${p.length}`); }
  if (req.query.source)   { p.push(req.query.source);   w.push(`s.data_source = $${p.length}`); }
  if (req.query.q)        { p.push('%' + req.query.q + '%'); w.push(`s.name ILIKE $${p.length}`); }
  const { rows } = await pool.query(`${SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.name`, p);
  res.json({ type: 'FeatureCollection', features: rows.map(toFeature) });
}));

app.get('/api/provinces', (req, res) => wrap(res, async () => {
  const { rows } = await pool.query('SELECT DISTINCT province FROM stations ORDER BY province');
  res.json(rows.map(r => r.province));
}));

app.get('/api/stats', (req, res) => wrap(res, async () => {
  const { rows } = await pool.query('SELECT station_type, COUNT(*)::int AS count FROM stations GROUP BY station_type ORDER BY count DESC');
  res.json(rows);
}));

app.get('/api/stations/:id/observations', (req, res) => wrap(res, async () => {
  if (badId(req, res)) return;
  const { rows } = await pool.query('SELECT id, observed_at, rainfall_mm, temperature_c, pm25 FROM observations WHERE station_id = $1 ORDER BY observed_at DESC LIMIT 20', [req.params.id]);
  res.json(rows);
}));

app.post('/api/stations', auth, (req, res) => wrap(res, async () => {
  const { e, v } = validateStation(req.body);
  if (e.length) return res.status(400).json({ errors: e });
  const { rows } = await pool.query(
    `INSERT INTO stations (name, station_type, province, city, elevation_m, status, data_source, geom)
     VALUES ($1,$2,$3,$4,$5,$6,$7, ST_SetSRID(ST_MakePoint($8,$9),4326)) RETURNING id`,
    [v.name, v.type, v.province, v.city, v.el, v.status, v.src, v.lon, v.lat]);
  res.status(201).json({ id: rows[0].id });
}));

app.put('/api/stations/:id', auth, (req, res) => wrap(res, async () => {
  if (badId(req, res)) return;
  const { e, v } = validateStation(req.body);
  if (e.length) return res.status(400).json({ errors: e });
  const r = await pool.query(
    `UPDATE stations SET name=$1, station_type=$2, province=$3, city=$4, elevation_m=$5, status=$6, data_source=$7,
       geom = ST_SetSRID(ST_MakePoint($8,$9),4326) WHERE id=$10`,
    [v.name, v.type, v.province, v.city, v.el, v.status, v.src, v.lon, v.lat, req.params.id]);
  if (!r.rowCount) return res.status(404).json({ errors: ['Station not found.'] });
  res.json({ ok: true });
}));

app.post('/api/stations/:id/observations', auth, (req, res) => wrap(res, async () => {
  if (badId(req, res)) return;
  const { e, v } = validateObs(req.body);
  if (e.length) return res.status(400).json({ errors: e });
  const s = await pool.query('SELECT 1 FROM stations WHERE id = $1', [req.params.id]);
  if (!s.rowCount) return res.status(404).json({ errors: ['Station not found.'] });
  await pool.query('INSERT INTO observations (station_id, rainfall_mm, temperature_c, pm25) VALUES ($1,$2,$3,$4)', [req.params.id, v.r, v.t, v.p]);
  res.status(201).json({ ok: true });
}));

// Optional extra: delete a station
app.delete('/api/stations/:id', auth, (req, res) => wrap(res, async () => {
  if (badId(req, res)) return;
  const r = await pool.query('DELETE FROM stations WHERE id = $1', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ errors: ['Station not found.'] });
  res.json({ ok: true });
}));

app.use('/api', (req, res) => res.status(404).json({ errors: ['Unknown API endpoint.'] }));
app.use((err, req, res, next) => res.status(400).json({ errors: [err.type === 'entity.parse.failed' ? 'Malformed JSON in request body.' : 'Bad request.'] }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`EnvMon running at http://localhost:${port}`));
