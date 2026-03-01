# Trapping Dashboard

A real-time monitoring dashboard for TrapNZ trapping projects, providing better visualization and analytics than standard TrapNZ CSV exports.

## Features

- **Live data** from TrapNZ API (auto-refreshes every 5 minutes)
- **Interactive map** with colour-coded trap status markers (Mapbox GL)
- **Project & trapline filtering** — view one trapline at a time
- **Monthly catch trends** chart (last 12 months)
- **Top & worst performing traps** ranked by catches
- **Last notes per trap** — searchable, sortable, exportable to CSV
- **Detailed trap modal** with last 10 check records
- **Satellite / street view** toggle

## Quick Start

### 1. Add your API keys

Copy the example config and fill in your real keys:

```
cp config.example.js config.js
```

Edit `config.js`:

```js
window.DASHBOARD_KEYS = {
  TRAPNZ_API_KEY: 'your-trapnz-api-key',
  MAPBOX_TOKEN:   'your-mapbox-token',
};
```

> **Note:** `config.js` is gitignored and will never be committed.

### 2. Open the dashboard

Open `index.html` in any modern browser. No build step or server required.

## File Structure

```
sandfly-dashboard/
├── index.html          # Main dashboard
├── app.js              # Application logic and API integration
├── styles.css          # Styling
├── config.js           # Your API keys (gitignored — create from example)
├── config.example.js   # Key template (safe to commit)
└── README.md
```

## Map Marker Colours

| Colour | Meaning |
|--------|---------|
| Green  | Checked within 7 days |
| Orange | Checked 8–14 days ago |
| Red    | Overdue (>14 days) |

## API Details

Data is fetched live from the TrapNZ WFS API:

```
Traps:   GET /wfs/{API_KEY}/default?typeName=trapnz-projects:my-projects-traps
Records: GET /wfs/{API_KEY}/default?typeName=trapnz-projects:my-projects-trap-records
```

## Tech Stack

- **Mapping**: Mapbox GL JS v3
- **Charts**: Chart.js
- **Data**: TrapNZ WFS API
- Plain HTML / CSS / JavaScript — no framework or build step
