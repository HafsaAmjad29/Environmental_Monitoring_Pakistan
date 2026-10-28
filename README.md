# EnvMon Pakistan – Environmental Monitoring Web GIS (Assignment 2)

Database-driven Web GIS: **PostgreSQL/PostGIS → Node.js/Express API → Leaflet website**.
Users can search/filter stations, add and edit stations, and add observation records. All changes are saved in PostgreSQL.

## Requirements
Node.js 18+, PostgreSQL 14+ with PostGIS (installed via Stack Builder on Windows).

## Setup
1. **Create the database** (pgAdmin Query Tool or terminal):
   `CREATE DATABASE envmon;`
2. **Create tables and load data:**
   `psql -U postgres -d envmon -f sql/create_and_populate.sql`
   (This enables PostGIS, creates `stations` and `observations`, inserts 26 stations and 130 observations.)
3. **Configure the connection:** in `server/`, copy `.env.example` to `.env` and put your own PostgreSQL user and password in `DATABASE_URL`. Do not submit `.env`.
4. **Install and run:**
   ```
   cd server
   npm install
   npm start
   ```
5. Open **http://localhost:3000**.

## API
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/stations?type=&province=&status=&q=` | Stations as GeoJSON, filtered |
| GET | `/api/provinces` | Province list for the filter |
| GET | `/api/stats` | Station count by type |
| GET | `/api/stations/:id/observations` | Last 20 records of a station |
| POST | `/api/stations` | Add a station |
| PUT | `/api/stations/:id` | Update a station |
| POST | `/api/stations/:id/observations` | Add an observation |
| DELETE | `/api/stations/:id` | Delete a station (extra) |

## Validation
Server side: name length, allowed type/status/source values, coordinates inside Pakistan (lat 23.5–37.2, lon 60.8–77.9), elevation range, and ranges for rainfall, temperature and PM2.5. Database `CHECK` constraints repeat these rules. Queries are parameterised.

## Data note
Station names are real towns with approximate coordinates. The seeded records are **sample data** (`data_source = 'Sample'`), and observation values are randomly generated for demonstration. They are not official measurements. Stations you add are labelled `Student`.

## Testing persistence
Edit a station's status (or add a record), refresh the page (the change remains), then check in pgAdmin:
`SELECT name, status FROM stations WHERE name = '...';`
