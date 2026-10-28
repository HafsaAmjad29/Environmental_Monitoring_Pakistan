-- Environmental Monitoring Database (Pakistan) -- PostgreSQL + PostGIS
-- Run:  createdb envmon   then   psql -d envmon -f sql/create_and_populate.sql
CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS observations;
DROP TABLE IF EXISTS stations;

CREATE TABLE stations (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  station_type VARCHAR(30)  NOT NULL CHECK (station_type IN ('Weather Station','Rain Gauge','Air Quality','River Gauge')),
  province     VARCHAR(40)  NOT NULL,
  city         VARCHAR(60),
  elevation_m  INTEGER CHECK (elevation_m BETWEEN -50 AND 9000),
  status       VARCHAR(20)  NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive','Maintenance')),
  data_source  VARCHAR(20)  NOT NULL DEFAULT 'Sample' CHECK (data_source IN ('Official','Student','Sample')),
  geom         geometry(Point,4326) NOT NULL
               CHECK (ST_Y(geom) BETWEEN 23.5 AND 37.2 AND ST_X(geom) BETWEEN 60.8 AND 77.9)  -- inside Pakistan's extent
);
CREATE INDEX stations_geom_idx ON stations USING GIST (geom);

CREATE TABLE observations (
  id            SERIAL PRIMARY KEY,
  station_id    INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  rainfall_mm   NUMERIC(6,1) CHECK (rainfall_mm >= 0),
  temperature_c NUMERIC(4,1) CHECK (temperature_c BETWEEN -50 AND 60),
  pm25          NUMERIC(6,1) CHECK (pm25 >= 0)
);
CREATE INDEX obs_station_idx ON observations (station_id, observed_at DESC);

-- NOTE: names/locations are real towns with APPROXIMATE coordinates (lon, lat).
-- Records are documented SAMPLE data (data_source = 'Sample'), not official measurements.
INSERT INTO stations (name, station_type, province, city, elevation_m, status, data_source, geom) VALUES
('Islamabad Weather Station',  'Weather Station','Islamabad Capital Territory','Islamabad',540,'Active','Sample',ST_SetSRID(ST_MakePoint(73.05,33.68),4326)),
('Islamabad Air Monitor',      'Air Quality',    'Islamabad Capital Territory','Islamabad',530,'Active','Sample',ST_SetSRID(ST_MakePoint(73.07,33.70),4326)),
('Rawalpindi Chaklala Station','Weather Station','Punjab','Rawalpindi',508,'Active','Sample',ST_SetSRID(ST_MakePoint(73.10,33.61),4326)),
('Lahore Weather Station',     'Weather Station','Punjab','Lahore',217,'Active','Sample',ST_SetSRID(ST_MakePoint(74.36,31.52),4326)),
('Lahore Air Monitor',         'Air Quality',    'Punjab','Lahore',215,'Active','Sample',ST_SetSRID(ST_MakePoint(74.33,31.55),4326)),
('Faisalabad Rain Gauge',      'Rain Gauge',     'Punjab','Faisalabad',184,'Active','Sample',ST_SetSRID(ST_MakePoint(73.08,31.42),4326)),
('Multan Weather Station',     'Weather Station','Punjab','Multan',122,'Active','Sample',ST_SetSRID(ST_MakePoint(71.47,30.20),4326)),
('Bahawalpur Rain Gauge',      'Rain Gauge',     'Punjab','Bahawalpur',118,'Maintenance','Sample',ST_SetSRID(ST_MakePoint(71.68,29.40),4326)),
('Murree Rain Gauge',          'Rain Gauge',     'Punjab','Murree',2291,'Active','Sample',ST_SetSRID(ST_MakePoint(73.39,33.91),4326)),
('Mangla Dam River Gauge',     'River Gauge',    'Azad Jammu and Kashmir','Mangla',300,'Active','Sample',ST_SetSRID(ST_MakePoint(73.65,33.14),4326)),
('Muzaffarabad Station',       'Weather Station','Azad Jammu and Kashmir','Muzaffarabad',737,'Active','Sample',ST_SetSRID(ST_MakePoint(73.47,34.37),4326)),
('Karachi Weather Station',    'Weather Station','Sindh','Karachi',8,'Active','Sample',ST_SetSRID(ST_MakePoint(67.01,24.86),4326)),
('Karachi Air Monitor',        'Air Quality',    'Sindh','Karachi',10,'Active','Sample',ST_SetSRID(ST_MakePoint(67.08,24.92),4326)),
('Hyderabad Rain Gauge',       'Rain Gauge',     'Sindh','Hyderabad',13,'Active','Sample',ST_SetSRID(ST_MakePoint(68.37,25.39),4326)),
('Sukkur Barrage Gauge',       'River Gauge',    'Sindh','Sukkur',67,'Active','Sample',ST_SetSRID(ST_MakePoint(68.86,27.70),4326)),
('Jacobabad Weather Station',  'Weather Station','Sindh','Jacobabad',56,'Active','Sample',ST_SetSRID(ST_MakePoint(68.44,28.28),4326)),
('Peshawar Weather Station',   'Weather Station','Khyber Pakhtunkhwa','Peshawar',331,'Active','Sample',ST_SetSRID(ST_MakePoint(71.58,34.01),4326)),
('Peshawar Air Monitor',       'Air Quality',    'Khyber Pakhtunkhwa','Peshawar',325,'Inactive','Sample',ST_SetSRID(ST_MakePoint(71.52,34.00),4326)),
('Tarbela Dam River Gauge',    'River Gauge',    'Khyber Pakhtunkhwa','Tarbela',450,'Active','Sample',ST_SetSRID(ST_MakePoint(72.70,34.09),4326)),
('Chitral Rain Gauge',         'Rain Gauge',     'Khyber Pakhtunkhwa','Chitral',1500,'Active','Sample',ST_SetSRID(ST_MakePoint(71.79,35.85),4326)),
('Quetta Weather Station',     'Weather Station','Balochistan','Quetta',1680,'Active','Sample',ST_SetSRID(ST_MakePoint(67.00,30.18),4326)),
('Gwadar Weather Station',     'Weather Station','Balochistan','Gwadar',10,'Active','Sample',ST_SetSRID(ST_MakePoint(62.33,25.12),4326)),
('Khuzdar Rain Gauge',         'Rain Gauge',     'Balochistan','Khuzdar',1231,'Inactive','Sample',ST_SetSRID(ST_MakePoint(66.61,27.81),4326)),
('Gilgit Weather Station',     'Weather Station','Gilgit-Baltistan','Gilgit',1460,'Active','Sample',ST_SetSRID(ST_MakePoint(74.31,35.92),4326)),
('Skardu Weather Station',     'Weather Station','Gilgit-Baltistan','Skardu',2230,'Active','Sample',ST_SetSRID(ST_MakePoint(75.63,35.30),4326));

-- 5 sample observations per station (randomised values, for demonstration only)
INSERT INTO observations (station_id, observed_at, rainfall_mm, temperature_c, pm25)
SELECT s.id, now() - (g || ' days')::interval,
       ROUND((random()*15)::numeric,1),
       ROUND((8 + random()*28)::numeric,1),
       CASE WHEN s.station_type = 'Air Quality' THEN ROUND((30 + random()*150)::numeric,1) END
FROM stations s, generate_series(1,5) g;

-- ===== Example queries (retrieve, filter, count, update) =====
-- SELECT id, name, station_type, ST_Y(geom) AS lat, ST_X(geom) AS lon FROM stations;
-- SELECT * FROM stations WHERE station_type = 'Rain Gauge' AND province = 'Punjab';
-- SELECT station_type, COUNT(*) FROM stations GROUP BY station_type ORDER BY 2 DESC;
-- SELECT s.name, AVG(o.temperature_c) FROM stations s JOIN observations o ON o.station_id = s.id GROUP BY s.name;
-- SELECT name FROM stations WHERE ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(73.05,33.68),4326)::geography, 100000);
-- UPDATE stations SET status = 'Active' WHERE name = 'Bahawalpur Rain Gauge';
