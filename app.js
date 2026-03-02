/* ============================================================================
   Trapping Dashboard - Enhanced with Project/Trapline Filtering
   ========================================================================== */

/* ------------------------------- CONFIG ---------------------------------- */
const _keys = window.DASHBOARD_KEYS || {};

const CONFIG = {
  API_KEY:            _keys.TRAPNZ_API_KEY || '',
  WFS_BASE:           `https://io.trap.nz/geo/trapnz-projects/wfs/${_keys.TRAPNZ_API_KEY || 'MISSING_KEY'}/default`,
  MAPBOX_TOKEN:       _keys.MAPBOX_TOKEN || '',
  REFRESH_INTERVAL:   300000, // 5 minutes
  PROJECT_NAME:       'Sandfly Traps',
  CHART_CANVAS_HEIGHT: 260, // px; prevents responsive resize loops
};

/* ------------------------------- STATE ----------------------------------- */
const STATE = {
  initialized: false,
  isLoading: false,
  refreshTimerId: null,

  // All data (unfiltered)
  allTraps: [],
  allRecords: [],

  // Filtered data (what gets displayed)
  traps: [],
  records: [],

  // Current filters
  filters: {
    project: 'all',
    trapline: 'all'
  },

  // Available filter values
  availableProjects: new Set(),
  availableTraplines: new Set(),

  map: null,
  markers: [],
  charts: {
    catchTrends: null,
    annualTrends: null,
  },

  fp: {
    analytics: '',
    header: '',
    map: '',
  },

  ui: {
    lastNotes: {
      page: 1,
      perPage: 10,
      onlyWithNotes: true,
      query: '',
      sort: 'date_desc',
      items: [],
    }
  }
}

/* ---------------------------- SAFE LOG HELPERS --------------------------- */
function log(...a) { console.log('🧭', ...a); }
function warn(...a) { console.warn('⚠️', ...a); }
function err(...a) { console.error('❌', ...a); }

function updateStatus(message, type = 'info') {
  const statusElement = document.getElementById('dataStatus');
  const connectionElement = document.getElementById('connectionStatus');

  if (statusElement) {
    statusElement.textContent = message;
    statusElement.className = `status-${type}`;
  }

  if (connectionElement) {
    if (type === 'success') {
      connectionElement.textContent = '🔗 Connected to TrapNZ API';
      connectionElement.className = 'status-success';
    } else if (type === 'error') {
      connectionElement.textContent = '❌ TrapNZ API Error';
      connectionElement.className = 'status-error';
    } else if (type === 'loading') {
      connectionElement.textContent = '🔄 Connecting to TrapNZ API';
      connectionElement.className = 'status-loading';
    }
  }
}

/* ----------------------------- TEXT HELPERS ------------------------------ */
// consistent fallbacks for project & trapline across all renders/filters
function getProject(props = {}) {
  return props.project ?? props.project_name ?? props.Project ?? props.PROJECT ?? '—';
}
function getTrapline(props = {}) {
  return props.line ?? props.trapline ?? props.trap_line ?? props.trap_line_name ??
         props.Line ?? props.LINE ?? '—';
}
// basic HTML escape to avoid odd chars/injection in innerHTML inserts
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/* ----------------------------- BOOTSTRAP --------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  if (STATE.initialized) return;
  STATE.initialized = true;

  if (typeof mapboxgl === 'undefined') {
    err('Mapbox GL JS not loaded');
    updateStatus('❌ Map library not available', 'error');
    return;
  }
  mapboxgl.accessToken = CONFIG.MAPBOX_TOKEN;

  initializeMap();
  setupEventListeners();
  setupFilterEventListeners();

  loadDashboardData();

  if (STATE.refreshTimerId) clearInterval(STATE.refreshTimerId);
  STATE.refreshTimerId = setInterval(() => {
    loadDashboardData();
  }, CONFIG.REFRESH_INTERVAL);

  log('✅ Enhanced Dashboard with Filters initialized');
});

/* --------------------------- EVENT LISTENERS ----------------------------- */
function setupEventListeners() {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadDashboardData());

  const satToggleA = document.getElementById('styleToggle');
  const satToggleB = document.getElementById('toggleSatellite');
  [satToggleA, satToggleB].forEach(btn => {
    if (btn) btn.addEventListener('click', toggleMapStyle);
  });

  const fitBtn = document.getElementById('fitBounds');
  if (fitBtn) fitBtn.addEventListener('click', fitAllBounds);

  const closeModal = document.getElementById('closeModal');
  if (closeModal) closeModal.addEventListener('click', () => {
    const m = document.getElementById('trapModal');
    if (m) m.style.display = 'none';
  });

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportReport);

  const sizeCanvases = () => {
    const ids = ['catchTrendsChart', 'annualCatchChart'];
    ids.forEach(id => {
      const c = document.getElementById(id);
      if (!c) return;
      c.removeAttribute('style');
      c.width = c.parentElement ? c.parentElement.clientWidth : 600;
      c.height = CONFIG.CHART_CANVAS_HEIGHT;
    });
  };

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => sizeCanvases(), 150);
  });
  sizeCanvases();

  log('✅ Event listeners set up');
}

function setupFilterEventListeners() {
  const projectFilter = document.getElementById('projectFilter');
  const traplineFilter = document.getElementById('traplineFilter');
  const clearFiltersBtn = document.getElementById('clearFilters');

  if (projectFilter) {
    projectFilter.addEventListener('change', (e) => {
      STATE.filters.project = e.target.value;
      applyFilters();
      updateUI();
    });
  }

  if (traplineFilter) {
    traplineFilter.addEventListener('change', (e) => {
      STATE.filters.trapline = e.target.value;
      applyFilters();
      updateUI();
    });
  }

  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      clearAllFilters();
    });
  }

  log('✅ Filter event listeners set up');
}

/* ---------------------------- FILTER LOGIC ------------------------------- */
function populateFilterOptions() {
  STATE.availableProjects.clear();
  STATE.availableTraplines.clear();

  STATE.allTraps.forEach(trap => {
    const props = trap.properties || {};
    const project = getProject(props);
    const line = getTrapline(props);
    if (project && project !== '—') STATE.availableProjects.add(project);
    if (line && line !== '—') STATE.availableTraplines.add(line);
  });

  const projectFilter = document.getElementById('projectFilter');
  if (projectFilter) {
    const currentValue = projectFilter.value;
    projectFilter.innerHTML = '<option value="all">All Projects</option>';
    Array.from(STATE.availableProjects).sort().forEach(project => {
      const option = document.createElement('option');
      option.value = project;
      option.textContent = project;
      projectFilter.appendChild(option);
    });
    if (STATE.availableProjects.has(currentValue)) projectFilter.value = currentValue;
  }

  const traplineFilter = document.getElementById('traplineFilter');
  if (traplineFilter) {
    const currentValue = traplineFilter.value;
    traplineFilter.innerHTML = '<option value="all">All Traplines</option>';
    Array.from(STATE.availableTraplines).sort().forEach(trapline => {
      const option = document.createElement('option');
      option.value = trapline;
      option.textContent = trapline;
      traplineFilter.appendChild(option);
    });
    if (STATE.availableTraplines.has(currentValue)) traplineFilter.value = currentValue;
  }

  log(`Filter options populated: ${STATE.availableProjects.size} projects, ${STATE.availableTraplines.size} traplines`);
}

function applyFilters() {
  STATE.traps = STATE.allTraps.filter(trap => {
    const props = trap.properties || {};
    const project = getProject(props);
    const line = getTrapline(props);

    if (STATE.filters.project !== 'all' && project !== STATE.filters.project) return false;
    if (STATE.filters.trapline !== 'all' && line !== STATE.filters.trapline) return false;

    return true;
  });

  const filteredTrapIds = new Set(STATE.traps.map(t => t.properties?.trap_id).filter(Boolean));
  STATE.records = STATE.allRecords.filter(record => filteredTrapIds.has(record.properties?.trap_id));

  updateFilterStatus();
  log(`Filters applied: ${STATE.traps.length}/${STATE.allTraps.length} traps, ${STATE.records.length}/${STATE.allRecords.length} records`);
}

function updateFilterStatus() {
  const filterStatusEl = document.getElementById('filterStatus');
  if (!filterStatusEl) return;

  const activeFilters = [];
  if (STATE.filters.project !== 'all') activeFilters.push(`Project: ${STATE.filters.project}`);
  if (STATE.filters.trapline !== 'all') activeFilters.push(`Trapline: ${STATE.filters.trapline}`);

  if (activeFilters.length > 0) {
    filterStatusEl.style.display = 'block';
    filterStatusEl.innerHTML = `🔍 Active Filters: ${escapeHtml(activeFilters.join(' • '))} | Showing ${STATE.traps.length} of ${STATE.allTraps.length} traps`;
  } else {
    filterStatusEl.style.display = 'none';
  }
}

function clearAllFilters() {
  STATE.filters.project = 'all';
  STATE.filters.trapline = 'all';

  const projectFilter = document.getElementById('projectFilter');
  const traplineFilter = document.getElementById('traplineFilter');
  if (projectFilter) projectFilter.value = 'all';
  if (traplineFilter) traplineFilter.value = 'all';

  applyFilters();
  updateUI();
  log('All filters cleared');
}

/* ---------------------------- DATA LOADING ------------------------------- */
// Force UTF-8 decode to avoid mojibake (â€" / ðŸ…)
async function fetchJsonUtf8(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  const txt = new TextDecoder('utf-8').decode(buf);
  return JSON.parse(txt);
}

async function loadDashboardData() {
  if (STATE.isLoading) {
    log('⏳ Skip: load in progress');
    return;
  }
  STATE.isLoading = true;
  updateStatus('🔄 Loading data…', 'loading');

  try {
    const [trapsOk, recordsOk] = await Promise.all([
      loadTrapsData(),
      loadRecordsData()
    ]);

    if (!trapsOk || !recordsOk) {
      updateStatus('⚠️ Partial data loaded', 'warning');
      return;
    }

    populateFilterOptions();
    applyFilters();
    updateUI();
    updateStatus('✅ Data loaded successfully', 'success');
  } catch (e) {
    err('Error loading dashboard data:', e);
    updateStatus(`❌ Error: ${e.message}`, 'error');
  } finally {
    STATE.isLoading = false;
  }
}

function updateUI() {
  updateHeaderStats();
  updateMapData();
  updateAnalytics();
  updateReportsTable();
}

async function loadTrapsData() {
  const url = `${CONFIG.WFS_BASE}?service=WFS&request=GetFeature&typeName=trapnz-projects:my-projects-traps&outputFormat=application/json&maxFeatures=1000`;
  try {
    const data = await fetchJsonUtf8(url);
    STATE.allTraps = Array.isArray(data.features) ? data.features : [];
    log(`✅ Loaded ${STATE.allTraps.length} traps`);
    return true;
  } catch (e) {
    err('loadTrapsData', e);
    STATE.allTraps = [];
    return false;
  }
}

async function loadRecordsData() {
  const url = `${CONFIG.WFS_BASE}?service=WFS&request=GetFeature&typeName=trapnz-projects:my-projects-trap-records&outputFormat=application/json&maxFeatures=50000`;
  try {
    const data = await fetchJsonUtf8(url);
    STATE.allRecords = Array.isArray(data.features) ? data.features : [];
    log(`✅ Loaded ${STATE.allRecords.length} records`);
    return true;
  } catch (e) {
    err('loadRecordsData', e);
    STATE.allRecords = [];
    return false;
  }
}

/* ------------------------------ MAP ------------------------------------- */
let currentMapStyle = 'mapbox://styles/mapbox/satellite-streets-v12';

function initializeMap() {
  STATE.map = new mapboxgl.Map({
    container: 'map',
    style: currentMapStyle,
    center: [170.540, -45.909], // Dunedin-ish
    zoom: 11
  });
}

function toggleMapStyle() {
  if (!STATE.map) return;
  currentMapStyle = currentMapStyle.includes('satellite')
    ? 'mapbox://styles/mapbox/streets-v12'
    : 'mapbox://styles/mapbox/satellite-streets-v12';
  STATE.map.setStyle(currentMapStyle);
}

function fitAllBounds() {
  if (!STATE.map || STATE.traps.length === 0) return;
  const bounds = new mapboxgl.LngLatBounds();
  STATE.traps.forEach(t => {
    const coords = t.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) bounds.extend(coords);
  });
  STATE.map.fitBounds(bounds, { padding: 50 });
}

function updateMapData() {
  if (!STATE.map) return;

  const newestByTrap = new Map();
  for (const r of STATE.records) {
    const id = r?.properties?.trap_id;
    const d = r?.properties?.record_date;
    if (!id || !d) continue;
    const prev = newestByTrap.get(id);
    if (!prev || new Date(d) > new Date(prev)) newestByTrap.set(id, d);
  }

  const mapKey = JSON.stringify({
    traps: STATE.traps.map(t => t?.properties?.trap_id).sort(),
    newest: Array.from(newestByTrap.entries()).sort()
  });
  if (mapKey === STATE.fp.map) return;
  STATE.fp.map = mapKey;

  for (const m of STATE.markers) m.remove();
  STATE.markers = [];

  const bounds = new mapboxgl.LngLatBounds();
  for (const trap of STATE.traps) {
    const props = trap.properties || {};
    const coords = trap.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const lastDate = newestByTrap.get(props.trap_id);
    const daysSinceCheck = lastDate
      ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000)
      : 999;

    let markerColor = '#e74c3c';
    if (daysSinceCheck <= 7) markerColor = '#27ae60';
    else if (daysSinceCheck <= 14) markerColor = '#f39c12';

    const project = getProject(props);
    const trapline = getTrapline(props);

    const marker = new mapboxgl.Marker({ color: markerColor })
      .setLngLat(coords)
      .setPopup(new mapboxgl.Popup({ offset: 25 }).setHTML(`
        <div style="padding: 15px; max-width: 300px;">
          <h3 style="margin: 0 0 10px 0; color: #2c3e50;">Trap ${escapeHtml(props.code || props.trap_id)}</h3>
          <p style="margin: 0 0 5px 0;"><strong>Project:</strong> ${escapeHtml(project)}</p>
          <p style="margin: 0 0 5px 0;"><strong>Trapline:</strong> ${escapeHtml(trapline)}</p>
          <p style="margin: 0 0 5px 0;"><strong>Type:</strong> ${escapeHtml(props.trap_type || '—')}</p>
          <p style="margin: 0 0 5px 0;"><strong>Installed:</strong> ${props.date_installed ? new Date(props.date_installed).toLocaleDateString('en-NZ') : '—'}</p>
          <p style="margin: 0 0 5px 0;"><strong>Last Check:</strong> ${lastDate ? new Date(lastDate).toLocaleDateString('en-NZ') : 'Never'}</p>
          <p style="margin: 0 0 10px 0;"><strong>Days Ago:</strong> ${isFinite(daysSinceCheck) && daysSinceCheck < 999 ? daysSinceCheck : 'N/A'}</p>
          <button onclick="showTrapDetails('${String(props.trap_id).replace(/'/g, "\\'")}')" style="
            background:#3498db;color:white;border:none;padding:8px 15px;border-radius:5px;cursor:pointer;font-size:.9em;">
            View Details
          </button>
        </div>`))
      .addTo(STATE.map);

    STATE.markers.push(marker);
    bounds.extend(coords);
  }

  if (STATE.markers.length) STATE.map.fitBounds(bounds, { padding: 50 });
}

/* ----------------------------- HEADER STATS ------------------------------ */
function updateHeaderStats() {
  const totalTrapsElement = document.getElementById('totalTraps');
  const recentChecksElement = document.getElementById('recentChecks');
  const totalCatchesElement = document.getElementById('totalCatches');
  const lastUpdateElement = document.getElementById('lastUpdate');

  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);

  const recentChecks = STATE.records.filter(r => {
    const d = r?.properties?.record_date;
    return d && new Date(d) >= weekAgo;
  }).length;

  const totalCatches = STATE.records.filter(r => {
    const s = r?.properties?.species_caught;
    return s && s !== 'None' && s.trim() !== '';
  }).length;

  const key = `${STATE.traps.length}|${STATE.records.length}|${recentChecks}|${totalCatches}`;
  if (key !== STATE.fp.header) {
    STATE.fp.header = key;
    if (totalTrapsElement) totalTrapsElement.textContent = STATE.traps.length;
    if (recentChecksElement) recentChecksElement.textContent = recentChecks;
    if (totalCatchesElement) totalCatchesElement.textContent = totalCatches;
  }
  if (lastUpdateElement) {
    lastUpdateElement.textContent = new Date().toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
  }
}

/* ------------------------------- ANALYTICS ------------------------------- */
function updateAnalytics() {
  const newest = STATE.records.length
    ? STATE.records.map(r => r.properties.record_date).sort().slice(-1)[0]
    : 'NONE';

  const fp = `${STATE.traps.length}|${STATE.records.length}|${newest}`;
  if (fp === STATE.fp.analytics) return;
  STATE.fp.analytics = fp;

  drawMonthlyCatchTrendsChart();
  drawAnnualCatchChart();
  drawTopPerformers12mo();
  drawWorstPerformers12mo();
  drawSpeciesBreakdown('species12mo', last12MonthCutoff());
  drawCheckActivity12mo();
  drawTopPerformersAllTime();
  drawWorstPerformersAllTime();
  drawSpeciesBreakdown('speciesAllTime', null);
  drawTrapTypePerformance();
  drawOverdueTraps();
  updateLastNotesPanel();
}

/* Helpers used by analytics */
function isCatch(record) {
  const s = record?.properties?.species_caught;
  return !!(s && s !== 'None' && s.trim() !== '');
}

function getTrapName(trapId) {
  const t = STATE.traps.find(tt => tt?.properties?.trap_id === trapId);
  return (t?.properties?.code) || trapId;
}

function last12MonthBuckets() {
  const out = [];
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    const label = dt.toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' });
    out.push({ key, label, start: dt, end: new Date(dt.getFullYear(), dt.getMonth() + 1, 1) });
  }
  return out;
}

/* Linear regression: returns fitted y values for each x index */
function linearRegressionLine(values) {
  const n = values.length;
  if (n < 2) return values.slice();
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += values[i];
    sumXY += i * values[i]; sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return values.map(() => sumY / n);
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return values.map((_, i) => Math.round((slope * i + intercept) * 10) / 10);
}

function drawMonthlyCatchTrendsChart() {
  const canvas = document.getElementById('catchTrendsChart');
  if (!canvas) return;

  if (STATE.charts.catchTrends) {
    STATE.charts.catchTrends.destroy();
    STATE.charts.catchTrends = null;
  }

  const buckets = last12MonthBuckets();
  const counts = new Array(buckets.length).fill(0);

  for (const r of STATE.records) {
    if (!isCatch(r)) continue;
    const dt = new Date(r.properties.record_date);
    for (let i = 0; i < buckets.length; i++) {
      if (dt >= buckets[i].start && dt < buckets[i].end) { counts[i]++; break; }
    }
  }

  STATE.charts.catchTrends = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [
        {
          label: 'Catches',
          data: counts,
          backgroundColor: 'rgba(52, 152, 219, 0.75)',
          borderColor: '#2980b9',
          borderWidth: 1,
          order: 2,
        },
        {
          label: 'Trend',
          data: linearRegressionLine(counts),
          type: 'line',
          borderColor: '#e74c3c',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0,
          fill: false,
          order: 1,
        }
      ]
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: true, position: 'top' } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

function drawAnnualCatchChart() {
  const canvas = document.getElementById('annualCatchChart');
  if (!canvas) return;

  if (STATE.charts.annualTrends) {
    STATE.charts.annualTrends.destroy();
    STATE.charts.annualTrends = null;
  }

  // Tally catches by calendar year
  const countsByYear = new Map();
  for (const r of STATE.records) {
    if (!isCatch(r)) continue;
    const yr = new Date(r.properties.record_date).getFullYear();
    if (!isFinite(yr)) continue;
    countsByYear.set(yr, (countsByYear.get(yr) || 0) + 1);
  }

  if (countsByYear.size === 0) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const years = Array.from(countsByYear.keys()).sort((a, b) => a - b);
  const counts = years.map(y => countsByYear.get(y));

  STATE.charts.annualTrends = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: years.map(String),
      datasets: [
        {
          label: 'Catches',
          data: counts,
          backgroundColor: 'rgba(39, 174, 96, 0.75)',
          borderColor: '#1e8449',
          borderWidth: 1,
          order: 2,
        },
        {
          label: 'Trend',
          data: linearRegressionLine(counts),
          type: 'line',
          borderColor: '#e74c3c',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0,
          fill: false,
          order: 1,
        }
      ]
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: true, position: 'top' } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
}

/* ---- Performer helpers ---- */

/* Tally catches and total checks from a set of records */
function calcPerformerStats(records) {
  const catches = new Map();
  const checks = new Map();
  for (const r of records) {
    const id = r.properties?.trap_id;
    if (!id) continue;
    checks.set(id, (checks.get(id) || 0) + 1);
    if (isCatch(r)) catches.set(id, (catches.get(id) || 0) + 1);
  }
  return { catches, checks };
}

function rateColor(pct) {
  if (pct >= 30) return '#27ae60';
  if (pct >= 10) return '#f39c12';
  return '#e74c3c';
}

function renderPerformersList(containerId, items, emptyMsg) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = items.length
    ? items.map((t, i) => `
        <div class="performer-item">
          <div class="performer-rank">#${i + 1}</div>
          <div class="performer-info">
            <div class="performer-name">Trap ${escapeHtml(t.name)}</div>
            <div class="performer-location">${t.catches} catches · ${t.checks} checks</div>
          </div>
          <div class="performer-rate-badge" style="background:${rateColor(t.rate)};">${t.rate}%</div>
        </div>`).join('')
    : `<div class="loading">${escapeHtml(emptyMsg)}</div>`;
}

function buildRankedList(records, minChecks, order, limit = 5) {
  const { catches, checks } = calcPerformerStats(records);
  return Array.from(checks.entries())
    .filter(([, c]) => c >= minChecks)
    .map(([id, c]) => {
      const caught = catches.get(id) || 0;
      return { name: getTrapName(id), catches: caught, checks: c, rate: Math.round(caught / c * 100) };
    })
    .sort(order)
    .slice(0, limit);
}

/* Shared cutoff helper */
function last12MonthCutoff() {
  return last12MonthBuckets()[0].start;
}

/* ---- Species breakdown ---- */
function drawSpeciesBreakdown(containerId, cutoff) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const tally = new Map();
  for (const r of STATE.records) {
    if (!isCatch(r)) continue;
    if (cutoff && new Date(r.properties.record_date) < cutoff) continue;
    const sp = (r.properties.species_caught || '').trim();
    tally.set(sp, (tally.get(sp) || 0) + 1);
  }

  if (!tally.size) {
    container.innerHTML = '<div class="loading">No catches recorded</div>';
    return;
  }

  const sorted = Array.from(tally.entries()).sort(([, a], [, b]) => b - a);
  const max = sorted[0][1];

  container.innerHTML = sorted.map(([sp, n]) => `
    <div class="performer-item">
      <div class="performer-info">
        <div class="performer-name">${escapeHtml(sp)}</div>
      </div>
      <div class="species-bar-bg">
        <div class="species-bar-fill" style="width:${Math.round(n / max * 100)}%;"></div>
      </div>
      <div class="species-count">${n}</div>
    </div>`).join('');
}

/* ---- Check activity (12 months) ---- */
function drawCheckActivity12mo() {
  const container = document.getElementById('checkActivity12mo');
  if (!container) return;

  const cutoff = last12MonthCutoff();
  const period = STATE.records.filter(r => new Date(r.properties.record_date) >= cutoff);

  const totalChecks = period.length;
  const totalTraps  = STATE.traps.length;
  const checkedIds  = new Set(period.map(r => r.properties?.trap_id).filter(Boolean));
  const pctVisited  = totalTraps ? Math.round(checkedIds.size / totalTraps * 100) : 0;
  const avgChecks   = totalTraps ? (totalChecks / totalTraps).toFixed(1) : '0';

  // Most active month in the period
  const byMonth = new Map();
  for (const r of period) {
    const key = r.properties.record_date?.slice(0, 7);
    if (key) byMonth.set(key, (byMonth.get(key) || 0) + 1);
  }
  let busiestLabel = '—', busiestCount = 0;
  for (const [key, count] of byMonth) {
    if (count > busiestCount) {
      busiestCount = count;
      const [yr, mo] = key.split('-');
      busiestLabel = new Date(+yr, +mo - 1, 1).toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' });
    }
  }

  container.innerHTML = `
    <div class="activity-stats">
      <div class="activity-stat">
        <span class="activity-stat-number">${totalChecks}</span>
        <span class="activity-stat-label">Total checks</span>
      </div>
      <div class="activity-stat">
        <span class="activity-stat-number">${pctVisited}%</span>
        <span class="activity-stat-label">Traps visited</span>
      </div>
      <div class="activity-stat">
        <span class="activity-stat-number">${avgChecks}</span>
        <span class="activity-stat-label">Avg checks / trap</span>
      </div>
      <div class="activity-stat">
        <span class="activity-stat-number" style="font-size:1.1em;">${busiestLabel}</span>
        <span class="activity-stat-label">Busiest month (${busiestCount} checks)</span>
      </div>
    </div>`;
}

/* ---- Trap type performance ---- */
function drawTrapTypePerformance() {
  const container = document.getElementById('trapTypePerf');
  if (!container) return;

  // Map trap_id → trap_type
  const typeByTrap = new Map();
  for (const t of STATE.traps) {
    const id   = t.properties?.trap_id;
    const type = (t.properties?.trap_type || 'Unknown').trim();
    if (id) typeByTrap.set(id, type);
  }

  const catchesByType = new Map();
  const checksByType  = new Map();
  for (const r of STATE.records) {
    const id   = r.properties?.trap_id;
    const type = typeByTrap.get(id) || 'Unknown';
    checksByType.set(type, (checksByType.get(type) || 0) + 1);
    if (isCatch(r)) catchesByType.set(type, (catchesByType.get(type) || 0) + 1);
  }

  const rows = Array.from(checksByType.entries())
    .filter(([, c]) => c >= 5)
    .map(([type, checks]) => {
      const caught = catchesByType.get(type) || 0;
      const rate   = Math.round(caught / checks * 100);
      return { type, caught, checks, rate };
    })
    .sort((a, b) => b.rate - a.rate);

  if (!rows.length) {
    container.innerHTML = '<div class="loading">Not enough data yet</div>';
    return;
  }

  container.innerHTML = rows.map(row => `
    <div class="performer-item">
      <div class="performer-info">
        <div class="performer-name">${escapeHtml(row.type)}</div>
        <div class="performer-location">${row.caught} catches · ${row.checks} checks</div>
      </div>
      <div class="performer-rate-badge" style="background:${rateColor(row.rate)};">${row.rate}%</div>
    </div>`).join('');
}

/* ---- Overdue traps ---- */
function drawOverdueTraps() {
  const container = document.getElementById('overdueTraps');
  if (!container) return;

  const newestByTrap = new Map();
  for (const r of STATE.records) {
    const id = r.properties?.trap_id;
    const d  = r.properties?.record_date;
    if (!id || !d) continue;
    const prev = newestByTrap.get(id);
    if (!prev || d > prev) newestByTrap.set(id, d);
  }

  function isRetired(props) {
    const status = (props?.status || props?.trap_status || '').toLowerCase();
    if (status.includes('retired') || status.includes('removed')) return true;
    const code = (props?.code || '').toLowerCase();
    if (code.includes('(retired)') || code.includes('(removed)')) return true;
    return false;
  }

  const overdue = STATE.traps
    .filter(t => !isRetired(t.properties))
    .map(t => {
      const id   = t.properties?.trap_id;
      const last = newestByTrap.get(id);
      const days = last
        ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000)
        : Infinity;
      return { name: t.properties?.code || id, days, last };
    })
    .filter(t => isFinite(t.days) && t.days > 14)   // exclude never-checked
    .sort((a, b) => b.days - a.days)
    .slice(0, 12);

  if (!overdue.length) {
    container.innerHTML = '<div class="loading" style="color:#27ae60;">✅ All traps checked within 14 days</div>';
    return;
  }

  container.innerHTML = overdue.map(t => {
    const daysLabel = `${t.days}d ago`;
    const color     = t.days > 30 ? '#e74c3c' : '#f39c12';
    return `
      <div class="performer-item">
        <div class="performer-info">
          <div class="performer-name">Trap ${escapeHtml(t.name)}</div>
          <div class="performer-location">${t.last ? `Last: ${new Date(t.last).toLocaleDateString('en-NZ')}` : 'No record'}</div>
        </div>
        <div class="performer-rate-badge" style="background:${color};">${daysLabel}</div>
      </div>`;
  }).join('');
}

function drawTopPerformers12mo() {
  const cutoff = last12MonthBuckets()[0].start;
  const period = STATE.records.filter(r => new Date(r.properties.record_date) >= cutoff);
  const items = buildRankedList(period, 2, (a, b) => b.rate - a.rate || b.catches - a.catches, 9);
  renderPerformersList('topPerformers12mo', items, 'Need ≥2 checks per trap to rank');
}

function drawWorstPerformers12mo() {
  const cutoff = last12MonthBuckets()[0].start;
  const period = STATE.records.filter(r => new Date(r.properties.record_date) >= cutoff);
  const items = buildRankedList(period, 3, (a, b) => a.rate - b.rate || a.catches - b.catches, 9);
  renderPerformersList('worstPerformers12mo', items, 'Need ≥3 checks per trap to rank');
}

function drawTopPerformersAllTime() {
  const items = buildRankedList(STATE.records, 3, (a, b) => b.rate - a.rate || b.catches - a.catches, 13);
  renderPerformersList('topPerformersAllTime', items, 'Need ≥3 checks per trap to rank');
}

function drawWorstPerformersAllTime() {
  const items = buildRankedList(STATE.records, 5, (a, b) => a.rate - b.rate || a.catches - b.catches, 13);
  renderPerformersList('worstPerformersAllTime', items, 'Need ≥5 checks per trap to rank');
}

/* ----------------------------- LAST NOTES -------------------------------- */
function setLastNotesState(patch = {}) {
  Object.assign(STATE.ui.lastNotes, patch);
  renderLastNotesPanel();
}

function computeLastNotesFromRecords() {
  if (!STATE.records?.length) return [];

  const NOTE_FIELD = 'record_notes';
  const byTrap = new Map();

  for (const r of STATE.records) {
    const p = r.properties || {};
    const id = p.trap_id;
    const dt = p.record_date ? new Date(p.record_date) : null;
    const note = (p[NOTE_FIELD] || '').trim();

    if (!id || !dt) continue;
    if (!note) continue;

    const prev = byTrap.get(id);
    if (!prev || dt > prev.date) byTrap.set(id, { date: dt, note });
  }

  const items = STATE.traps.map(t => {
    const pid = t.properties.trap_id;
    const code = t.properties.code || pid;
    const entry = byTrap.get(pid);
    return {
      trap_id: pid,
      code,
      date: entry?.date || null,
      note: entry?.note || ''
    };
  });

  items.sort((a, b) => {
    if (a.date && b.date) return b.date - a.date;
    if (a.date) return -1;
    if (b.date) return 1;
    return String(a.code).localeCompare(String(b.code));
  });

  return items;
}

async function updateLastNotesPanel() {
  const container = document.getElementById('lastNotes');
  if (container) container.innerHTML = `<div class="loading">Preparing notes…</div>`;

  const items = computeLastNotesFromRecords();
  STATE.ui.lastNotes.items = items;
  STATE.ui.lastNotes.page = 1;
  renderLastNotesPanel();
}

function renderLastNotesPanel() {
  const container = document.getElementById('lastNotes');
  if (!container) return;

  const wasActive = document.activeElement && document.activeElement.id === 'ln-search';
  const caret = wasActive ? {
    start: document.activeElement.selectionStart,
    end: document.activeElement.selectionEnd
  } : null;

  const state = STATE.ui.lastNotes;
  const allItems = state.items || [];

  const q = state.query.trim().toLowerCase();
  let filtered = allItems.filter(it => {
    const hasNote = !!it.note;
    if (state.onlyWithNotes && !hasNote) return false;
    if (!q) return true;
    const hay = `trap ${it.code} ${it.note}`.toLowerCase();
    return hay.includes(q);
  });

  filtered.sort((a, b) => {
    if (state.sort === 'date_desc') {
      if (a.date && b.date) return b.date - a.date;
      if (a.date) return -1; if (b.date) return 1;
      return String(a.code).localeCompare(String(b.code));
    }
    if (state.sort === 'date_asc') {
      if (a.date && b.date) return a.date - b.date;
      if (a.date) return 1; if (b.date) return -1;
      return String(a.code).localeCompare(String(b.code));
    }
    if (state.sort === 'trap_asc')  return String(a.code).localeCompare(String(b.code));
    if (state.sort === 'trap_desc') return String(b.code).localeCompare(String(a.code));
    return 0;
  });

  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / state.perPage));
  const page = Math.min(state.page, pages);
  const start = (page - 1) * state.perPage;
  const pageItems = filtered.slice(start, start + state.perPage);

  const listHTML = pageItems.map(it => `
    <div class="ln-item">
      <div class="ln-row">
        <div class="ln-trap">Trap ${escapeHtml(it.code)}</div>
        <div class="ln-date">${it.date ? new Date(it.date).toLocaleDateString('en-NZ') : '—'}</div>
      </div>
      <div class="ln-note">${it.note ? escapeHtml(it.note) : '<span class="muted">No note</span>'}</div>
    </div>
  `).join('');

  container.innerHTML = `
    <div class="notes-controls notes-controls--stacked">
      <div class="control">
        <label for="ln-search">Search</label>
        <input id="ln-search" class="input" placeholder="Search notes or trap…" value="${escapeHtml(state.query)}">
      </div>
      <div class="control">
        <label><input id="ln-only" type="checkbox" ${state.onlyWithNotes ? 'checked' : ''}> Only with notes</label>
      </div>
      <div class="control">
        <label for="ln-sort">Sort</label>
        <select id="ln-sort" class="select">
          <option value="date_desc" ${state.sort==='date_desc'?'selected':''}>Newest first</option>
          <option value="date_asc"  ${state.sort==='date_asc'?'selected':''}>Oldest first</option>
          <option value="trap_asc"  ${state.sort==='trap_asc'?'selected':''}>Trap (A→Z)</option>
          <option value="trap_desc" ${state.sort==='trap_desc'?'selected':''}>Trap (Z→A)</option>
        </select>
      </div>
      <div class="control">
        <label for="ln-size">Page size</label>
        <select id="ln-size" class="select">
          <option value="10" ${state.perPage===10?'selected':''}>10 / page</option>
          <option value="20" ${state.perPage===20?'selected':''}>20 / page</option>
          <option value="50" ${state.perPage===50?'selected':''}>50 / page</option>
        </select>
      </div>
      <div class="control export-row">
        <div class="export-chooser">
          <label for="ln-export-which">Export</label>
          <select id="ln-export-which" class="select">
            <option value="visible">Visible page</option>
            <option value="all">All (filtered)</option>
          </select>
        </div>
        <button id="ln-export" class="export-btn">⬇️ Export CSV</button>
      </div>
    </div>
    <div class="last-notes-list">
      ${listHTML || '<div class="muted">No traps match your filters.</div>'}
    </div>
    <div class="notes-pager">
      <button id="ln-prev" class="page-btn" ${page<=1?'disabled':''}>Prev</button>
      <span class="pager-text">Page ${page} of ${pages} · ${total} traps</span>
      <button id="ln-next" class="page-btn" ${page>=pages?'disabled':''}>Next</button>
    </div>
  `;

  const $ = id => document.getElementById(id);
  $('ln-search').oninput   = e => setLastNotesState({ query: e.target.value, page: 1 });
  $('ln-only').onchange    = e => setLastNotesState({ onlyWithNotes: !!e.target.checked, page: 1 });
  $('ln-sort').onchange    = e => setLastNotesState({ sort: e.target.value, page: 1 });
  $('ln-size').onchange    = e => setLastNotesState({ perPage: Number(e.target.value), page: 1 });
  $('ln-prev').onclick     = () => setLastNotesState({ page: Math.max(1, page - 1) });
  $('ln-next').onclick     = () => setLastNotesState({ page: Math.min(pages, page + 1) });

  const toCSV = rows => {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return rows.map(r => r.map(esc).join(',')).join('\n');
  };
  $('ln-export').onclick = () => {
    const which = $('ln-export-which').value;
    const rows = [
      ['Trap','Last note date','Note'],
      ...((which === 'visible') ? pageItems : filtered).map(it => [
        `Trap ${it.code}`,
        it.date ? new Date(it.date).toLocaleDateString('en-NZ') : '',
        it.note || ''
      ])
    ];
    const blob = new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = which === 'visible' ? 'trap-last-notes_visible.csv' : 'trap-last-notes_all.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
}

/* ----------------------------- REPORTS TABLE ----------------------------- */
function updateReportsTable() {
  const tableBody = document.getElementById('trapsTableBody');
  if (!tableBody) return;

  const newestByTrap = new Map();
  for (const r of STATE.records) {
    const id = r?.properties?.trap_id;
    const d = r?.properties?.record_date;
    if (!id || !d) continue;
    const prev = newestByTrap.get(id);
    if (!prev || new Date(d) > new Date(prev)) newestByTrap.set(id, d);
  }

  const rows = STATE.traps.map(trap => {
    const props = trap.properties || {};
    const lastDate = newestByTrap.get(props.trap_id);
    const daysSinceCheck = lastDate
      ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000)
      : 999;

    let statusClass = 'status-overdue';
    let statusText = 'Overdue';
    if (daysSinceCheck <= 7) {
      statusClass = 'status-recent';
      statusText = 'Recent';
    } else if (daysSinceCheck <= 14) {
      statusClass = 'status-warning';
      statusText = 'Warning';
    }

    const project = getProject(props);
    const trapline = getTrapline(props);

    return `
      <tr>
        <td>${escapeHtml(props.code || props.trap_id)}</td>
        <td>${escapeHtml(project)}</td>
        <td>${escapeHtml(trapline)}</td>
        <td>${escapeHtml(props.trap_type || '—')}</td>
        <td>${lastDate ? new Date(lastDate).toLocaleDateString('en-NZ') : 'Never'}</td>
        <td>${isFinite(daysSinceCheck) && daysSinceCheck < 999 ? daysSinceCheck : 'N/A'}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        <td><button class="action-btn" onclick="showTrapDetails('${String(props.trap_id).replace(/'/g, "\\'")}')">View</button></td>
      </tr>
    `;
  });

  tableBody.innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="8" class="loading">No traps match current filters</td></tr>';
}

/* ----------------------------- TRAP MODAL -------------------------------- */
function showTrapDetails(trapId) {
  const idStr = String(trapId);
  const trap = STATE.allTraps.find(t => String(t.properties.trap_id) === idStr);
  if (!trap) {
    console.warn('Trap not found for id:', trapId);
    return;
  }

  const props = trap.properties || {};
  const trapRecords = STATE.allRecords
    .filter(r => String(r.properties.trap_id) === idStr)
    .sort((a, b) => new Date(b.properties.record_date) - new Date(a.properties.record_date));

  const last = trapRecords[0];
  const daysSinceCheck = last
    ? Math.floor((Date.now() - new Date(last.properties.record_date).getTime()) / 86400000)
    : 'N/A';

  const modal = document.getElementById('trapModal');
  const body = document.getElementById('modalTrapContent');
  const title = document.getElementById('modalTrapTitle');
  if (!modal || !body || !title) return;

  const project = getProject(props);
  const trapline = getTrapline(props);

  title.textContent = `Trap ${props.code || props.trap_id}`;
  body.innerHTML = `
    <div>
      <p><strong>Project:</strong> ${escapeHtml(project)}</p>
      <p><strong>Trapline:</strong> ${escapeHtml(trapline)}</p>
      <p><strong>Type:</strong> ${escapeHtml(props.trap_type || '—')}</p>
      <p><strong>Installed:</strong> ${props.date_installed ? new Date(props.date_installed).toLocaleDateString('en-NZ') : '—'}</p>
      <p><strong>Last check:</strong> ${last ? new Date(last.properties.record_date).toLocaleDateString('en-NZ') : 'Never'}</p>
      <p><strong>Days since check:</strong> ${daysSinceCheck}</p>

      <h4>Recent Activity (Last 10 Records)</h4>
      <div class="records-list">
        ${trapRecords.slice(0, 10).map(r => `
          <div class="record-item">
            <div class="record-date">${new Date(r.properties.record_date).toLocaleDateString('en-NZ')}</div>
            <div class="record-details">
              ${r.properties.species_caught && r.properties.species_caught !== 'None'
                ? `🎯 Caught: ${escapeHtml(r.properties.species_caught)}`
                : '✅ Checked - No catch'}
              ${r.properties.recorded_by ? ` (${escapeHtml(r.properties.recorded_by)})` : ''}
            </div>
            ${r.properties.record_notes
              ? `<div class="record-notes">📝 ${escapeHtml(r.properties.record_notes)}</div>`
              : ''}
          </div>`).join('')}
      </div>
    </div>
  `;
  modal.style.display = 'block';
}

/* ----------------------------- EXPORT REPORT ----------------------------- */
function exportReport() {
  if (!STATE.traps.length) {
    alert('No trap data to export yet — wait for data to load.');
    return;
  }

  const newestByTrap = new Map();
  for (const r of STATE.allRecords) {
    const id = r?.properties?.trap_id;
    const d = r?.properties?.record_date;
    if (!id || !d) continue;
    const prev = newestByTrap.get(id);
    if (!prev || new Date(d) > new Date(prev)) newestByTrap.set(id, d);
  }

  const catchesByTrap = new Map();
  for (const r of STATE.allRecords) {
    const id = r?.properties?.trap_id;
    if (!id || !isCatch(r)) continue;
    catchesByTrap.set(id, (catchesByTrap.get(id) || 0) + 1);
  }

  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const headers = ['Code', 'Project', 'Trapline', 'Type', 'Last Check', 'Days Ago', 'Status', 'Total Catches'];

  const rows = STATE.traps.map(trap => {
    const props = trap.properties || {};
    const lastDate = newestByTrap.get(props.trap_id);
    const daysSince = lastDate
      ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000)
      : null;

    let status = 'Overdue';
    if (daysSince !== null && daysSince <= 7) status = 'Recent';
    else if (daysSince !== null && daysSince <= 14) status = 'Warning';

    return [
      props.code || props.trap_id,
      getProject(props),
      getTrapline(props),
      props.trap_type || '',
      lastDate ? new Date(lastDate).toLocaleDateString('en-NZ') : 'Never',
      daysSince !== null ? daysSince : 'N/A',
      status,
      catchesByTrap.get(props.trap_id) || 0,
    ].map(esc).join(',');
  });

  const csv = [headers.map(esc).join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trap-report_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------- GLOBAL EXPORTS ----------------------------- */
window.showTrapDetails = showTrapDetails;

log('🎯 Trapping Dashboard loaded');
