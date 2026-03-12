/* ============================================================
   app.js — Sandfly Trapping Dashboard: Main Application Logic
   ============================================================
   This is the heart of the dashboard. It runs entirely in the
   browser (not on the server) and is responsible for:

   1. FETCHING DATA — talking to the TrapNZ WFS (Web Feature
      Service) API to download trap locations and check records.
      WFS is a standard GIS protocol that returns data in
      GeoJSON format (a JSON structure with coordinates and
      properties for each geographic feature).

   2. FILTERING — letting the user narrow the view to a specific
      project or trapline. Filtering happens in memory (no new
      API call needed) because all data is downloaded upfront.

   3. MAP — rendering colour-coded pins on a Mapbox map,
      one pin per trap. Pin colours indicate how recently
      the trap was checked.

   4. ANALYTICS — calculating and rendering every card in the
      analytics grid: catch trend charts, performer tables,
      species breakdowns, check activity stats, overdue traps,
      and the last-notes panel.

   5. REPORTS — rendering the trapline summary table and the
      check record log (both paginated).

   6. INTERACTIVITY — search, sort, pagination, CSV export,
      the trap detail modal, and the auto-refresh timer.

   DEPENDENCIES (must be loaded before this file):
     - mapboxgl  (from mapbox-gl.js in index.html)
     - Chart     (from chart.js in index.html)
     - window.DASHBOARD_KEYS  (set by config.js, which is served
       by functions/config.js.js)
   ============================================================ */

/* ============================================================
   CONFIGURATION
   A single object holding all the settings that control how
   the dashboard behaves. Putting them here makes it easy to
   change settings without hunting through the code.
   ============================================================ */

/* -- Subsection: Read API keys injected by config.js --
   window.DASHBOARD_KEYS is set by the config.js script that
   loads before this file. If that script didn't run (e.g.
   in local development), _keys falls back to an empty object
   so we don't crash on undefined. */
const _keys = window.DASHBOARD_KEYS || {};

/* The CONFIG object holds every tunable value in one place.
   If you need to change the auto-refresh interval or the
   map's starting location, this is where you do it. */
const CONFIG = {
  // The TrapNZ API key. Without this, all data requests will fail.
  API_KEY:            _keys.TRAPNZ_API_KEY || '',

  // Base URL for the TrapNZ WFS (Web Feature Service) API.
  // WFS is a standard protocol for downloading geographic features
  // (like trap locations) as GeoJSON data. The API key is embedded
  // in the URL path as required by TrapNZ's API design.
  WFS_BASE:           `https://io.trap.nz/geo/trapnz-projects/wfs/${_keys.TRAPNZ_API_KEY || 'MISSING_KEY'}/default`,

  // Mapbox public access token — needed to load map tiles.
  MAPBOX_TOKEN:       _keys.MAPBOX_TOKEN || '',

  // How often (in milliseconds) to automatically reload data from TrapNZ.
  // 300000ms = 5 minutes. This keeps the dashboard fresh without
  // requiring the user to click Refresh.
  REFRESH_INTERVAL:   300000, // 5 minutes

  // The human-readable project name shown in the UI.
  PROJECT_NAME:       'Sandfly Traps',

  // The fixed height (in pixels) of the chart canvases. Setting a
  // fixed height prevents an infinite resize loop that can happen with
  // responsive charts — Chart.js tries to resize, which triggers a
  // resize event, which triggers another resize, etc.
  CHART_CANVAS_HEIGHT: 260, // px; prevents responsive resize loops
};

/* ============================================================
   APPLICATION STATE
   All the data and UI state for the entire dashboard lives in
   this one object. Having a single "source of truth" makes it
   easier to understand what's happening — you always know where
   to look for the current data or current filter settings.
   ============================================================ */
const STATE = {
  // Prevents the DOMContentLoaded handler from running twice
  initialized: false,

  // True while a data fetch is in progress — prevents overlapping fetches
  isLoading: false,

  // The ID returned by setInterval() so we can cancel the auto-refresh
  // timer if needed (e.g. before starting a new one)
  refreshTimerId: null,

  // All data downloaded from TrapNZ, before any filters are applied.
  // These arrays are never modified by filtering — they always hold
  // the complete dataset.
  allTraps: [],    // GeoJSON Feature objects, each representing one physical trap
  allRecords: [],  // GeoJSON Feature objects, each representing one check visit

  // The currently visible (filtered) subset of allTraps and allRecords.
  // All analytics, charts, and map markers use these arrays.
  traps: [],
  records: [],

  // The current values of the project and trapline filters.
  // 'all' means no filter is active for that dimension.
  filters: {
    project: 'all',
    trapline: 'all'
  },

  // Sets of unique project names and trapline names found in the data.
  // Used to populate the filter dropdown options.
  availableProjects: new Set(),   // Set prevents duplicates automatically
  availableTraplines: new Set(),

  // The Mapbox map instance (created by initializeMap)
  map: null,

  // Array of Mapbox Marker objects currently on the map.
  // We keep references so we can remove them all before re-rendering.
  markers: [],

  // References to the Chart.js chart instances. We need these to
  // call .destroy() before recreating charts (otherwise Chart.js
  // would draw a new chart on top of the old one).
  charts: {
    catchTrends: null,   // The monthly catch trends bar chart
    annualTrends: null,  // The annual catch trends bar chart
  },

  // "Fingerprints" for each rendered section — strings that represent
  // the data that was last used to render that section. If the fingerprint
  // hasn't changed since the last render, we skip the re-render. This
  // prevents unnecessary DOM updates when data hasn't changed.
  fp: {
    analytics: '',  // Fingerprint for the analytics section
    header: '',     // Fingerprint for the header stat cards
    map: '',        // Fingerprint for the map markers
  },

  // State for the UI panels that have pagination, search, or filters.
  // Keeping this in STATE means the user's position in the list is
  // preserved across data refreshes.
  ui: {
    lastNotes: {
      page: 1,           // Current page number in the notes list
      perPage: 10,       // Number of notes shown per page
      onlyWithNotes: true,  // Show only traps that have a note (not empty ones)
      query: '',         // Current search string typed by the user
      sort: 'date_desc', // Current sort order ('date_desc', 'date_asc', 'trap_asc', 'trap_desc')
      items: [],         // The computed list of note items (one per trap)
    },
    traplineSum: {
      page: 1,       // Current page in the trapline summary table
      perPage: 12,   // Rows per page in the trapline summary
      items: [],     // The computed list of trapline summary rows
    },
    checkLog: {
      page: 1,       // Current page in the check record log
      perPage: 25,   // Records per page in the log
      period: '30',  // Time period filter: '7', '30', '90', '365', or 'all'
      trapline: 'all', // Trapline filter for the log ('all' or a specific name)
      filtered: [],  // The currently filtered + sorted check records (for export)
    },
  }
}

/* ============================================================
   LOGGING HELPERS
   Wrappers around console.log/warn/error that prefix messages
   with emoji icons so dashboard messages are easy to spot in
   the browser's developer tools (F12 → Console tab).
   ============================================================ */

/* -- Subsection: Log functions --
   These work exactly like console.log/warn/error but add a
   prefix emoji and are easy to silence by commenting out the
   function body if you don't want log output in production. */
/* Safe log helpers — these wrap the browser's console functions */
function log(...a) { console.log('🧭', ...a); }
function warn(...a) { console.warn('⚠️', ...a); }
function err(...a) { console.error('❌', ...a); }

/* ============================================================
   updateStatus — updates the status bar at the bottom of the page
   ============================================================
   Parameters:
     message — the text to display in the data status span
     type    — one of 'info', 'success', 'error', 'loading';
               controls the colour class applied to the text
   Effect:
     Updates the text content and CSS class of the two status
     spans in the footer (#dataStatus and #connectionStatus).
   ============================================================ */
function updateStatus(message, type = 'info') {
  // Find the two status elements in the footer
  const statusElement = document.getElementById('dataStatus');
  const connectionElement = document.getElementById('connectionStatus');

  // Update the data status text and apply the matching colour class
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.className = `status-${type}`;  // e.g. 'status-success', 'status-error'
  }

  // Update the connection status with a fixed message based on type
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

/* ============================================================
   TEXT HELPER FUNCTIONS
   These functions extract specific properties from TrapNZ's
   GeoJSON feature property objects. The TrapNZ API doesn't
   always use consistent property names — sometimes the project
   name is in "project", sometimes "project_name", sometimes
   "Project" (capital P). These helpers try all known variants
   and fall back to '—' if none are found.
   ============================================================ */

/* -- Subsection: Property name helpers --
   These provide a consistent fallback across all renders and filters.
   The ?? operator means "use the right side if the left side is
   null or undefined". */
/* consistent fallbacks for project & trapline across all renders/filters */
function getProject(props = {}) {
  // Try four possible property names for the project name.
  // ?? is the "nullish coalescing" operator: if the left side is
  // null or undefined, use the right side instead.
  return props.project ?? props.project_name ?? props.Project ?? props.PROJECT ?? '—';
}

function getTrapline(props = {}) {
  // Try six possible property names for the trapline name.
  return props.line ?? props.trapline ?? props.trap_line ?? props.trap_line_name ??
         props.Line ?? props.LINE ?? '—';
}

/* ============================================================
   escapeHtml — sanitises text before inserting into HTML
   ============================================================
   Parameters:
     s — any value (string, number, null, etc.)
   Returns:
     A string safe to use in innerHTML — special HTML characters
     (&, <, >, ", ') are replaced with their HTML entity equivalents.

   WHY IS THIS IMPORTANT?
   If we insert user-supplied or API-supplied text directly into
   innerHTML without escaping, a malicious string like
   <script>stealCookies()</script> could execute as code.
   Escaping converts < to &lt; so it displays as text, not code.
   This is called XSS (Cross-Site Scripting) prevention.
   ============================================================ */
// basic HTML escape to avoid odd chars/injection in innerHTML inserts
function escapeHtml(s) {
  // String(s ?? '') converts null/undefined to empty string, then to a string.
  // .replace() with a regex finds any of the five dangerous characters.
  // The function maps each found character to its safe HTML entity.
  return String(s ?? '').replace(/[&<>"']/g, m => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
  ));
}

/* ============================================================
   BOOTSTRAP — Application Startup
   This code runs once when the browser has fully parsed the HTML.
   DOMContentLoaded fires before images and stylesheets finish
   loading, but after all HTML elements exist in the DOM — which
   is all we need to start working with them.
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  // Guard against running twice (belt-and-suspenders safety check)
  if (STATE.initialized) return;
  STATE.initialized = true;

  // -- Check that Mapbox loaded correctly --
  // If the Mapbox script in index.html failed to load, mapboxgl
  // will be undefined. We can't show a map without it.
  if (typeof mapboxgl === 'undefined') {
    err('Mapbox GL JS not loaded');
    updateStatus('❌ Map library not available', 'error');
    return;
  }

  // Set the Mapbox access token. This must be done before creating
  // any map instances. The token is read from CONFIG which got it
  // from window.DASHBOARD_KEYS (injected by config.js).
  mapboxgl.accessToken = CONFIG.MAPBOX_TOKEN;

  // -- Initialise the app --
  initializeMap();              // Create the Mapbox map
  setupEventListeners();        // Wire up buttons and resize handler
  setupFilterEventListeners();  // Wire up the filter dropdowns

  // Fetch data from TrapNZ and render everything
  loadDashboardData();

  // -- Set up auto-refresh --
  // clearInterval() cancels any existing timer before starting a new one.
  // setInterval() runs the callback every REFRESH_INTERVAL milliseconds.
  // 300000ms = 5 minutes. The user can also manually refresh with the button.
  if (STATE.refreshTimerId) clearInterval(STATE.refreshTimerId);
  STATE.refreshTimerId = setInterval(() => {
    loadDashboardData();
  }, CONFIG.REFRESH_INTERVAL);

  log('✅ Enhanced Dashboard with Filters initialized');
});

/* ============================================================
   EVENT LISTENERS — setupEventListeners
   ============================================================
   Wires up all the buttons and interactive elements on the page.
   Called once at startup. We use getElementById() to find each
   element and addEventListener() to attach a handler function.

   Note: we check if each element exists (e.g. if (refreshBtn))
   before attaching listeners. This prevents errors if the HTML
   ever changes and a button is removed.
   ============================================================ */
function setupEventListeners() {
  // -- Refresh button --
  // Clicking it triggers an immediate data reload from TrapNZ
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', () => loadDashboardData());

  // -- Satellite toggle buttons --
  // There are two buttons that do the same thing (satellite/street toggle)
  // so we loop through both and attach the same handler to each.
  const satToggleA = document.getElementById('styleToggle');
  const satToggleB = document.getElementById('toggleSatellite');
  [satToggleA, satToggleB].forEach(btn => {
    if (btn) btn.addEventListener('click', toggleMapStyle);
  });

  // -- Fit Bounds button --
  // Zooms the map to fit all visible trap pins within the viewport
  const fitBtn = document.getElementById('fitBounds');
  if (fitBtn) fitBtn.addEventListener('click', fitAllBounds);

  // -- Modal close button --
  // The × button hides the trap detail modal
  const closeModal = document.getElementById('closeModal');
  if (closeModal) closeModal.addEventListener('click', () => {
    const m = document.getElementById('trapModal');
    if (m) m.style.display = 'none';
  });

  // -- Check log period filter --
  // When the user changes the "Last 7 days / 30 days / etc." dropdown,
  // we save the new value to STATE and re-render the log table.
  const logPeriod = document.getElementById('logPeriod');
  if (logPeriod) logPeriod.addEventListener('change', e => {
    STATE.ui.checkLog.period = e.target.value;
    STATE.ui.checkLog.page = 1;  // Reset to page 1 after changing the filter
    renderCheckRecordLog();
  });

  // -- Check log trapline filter --
  // When the user selects a trapline, re-render the log for that trapline only
  const logTrapline = document.getElementById('logTrapline');
  if (logTrapline) logTrapline.addEventListener('change', e => {
    STATE.ui.checkLog.trapline = e.target.value;
    STATE.ui.checkLog.page = 1;
    renderCheckRecordLog();
  });

  // -- Check log CSV export button --
  // Triggers a file download of the currently filtered log records
  const logExport = document.getElementById('logExport');
  if (logExport) logExport.addEventListener('click', exportCheckLog);

  // -- Chart canvas sizer --
  // This function reads the actual rendered width of each chart's
  // parent element and sets the canvas width to match.
  // We do this instead of relying on responsive sizing to avoid
  // an infinite resize loop with Chart.js.
  const sizeCanvases = () => {
    const ids = ['catchTrendsChart', 'annualCatchChart'];
    ids.forEach(id => {
      const c = document.getElementById(id);
      if (!c) return;
      // Remove any inline style that might override our sizing
      c.removeAttribute('style');
      // Set canvas width to its container's width, or 600px as fallback
      c.width = c.parentElement ? c.parentElement.clientWidth : 600;
      c.height = CONFIG.CHART_CANVAS_HEIGHT;
    });
  };

  // -- Window resize handler --
  // We re-size canvases when the window is resized.
  // The setTimeout debounce (150ms delay) prevents this from
  // firing dozens of times per second while the user drags the
  // window edge — we wait until resizing has stopped for 150ms.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => sizeCanvases(), 150);
  });

  // Run the sizer once immediately at startup
  sizeCanvases();

  log('✅ Event listeners set up');
}

/* ============================================================
   setupFilterEventListeners — wires up the filter dropdowns
   ============================================================
   Called once at startup. Watches the project and trapline
   filter dropdowns and the Reset button. When the user
   changes a dropdown, we update STATE.filters and call
   applyFilters() + updateUI() to re-render everything.
   ============================================================ */
function setupFilterEventListeners() {
  const projectFilter = document.getElementById('projectFilter');
  const traplineFilter = document.getElementById('traplineFilter');
  const clearFiltersBtn = document.getElementById('clearFilters');

  // When the user selects a different project from the dropdown...
  if (projectFilter) {
    projectFilter.addEventListener('change', (e) => {
      STATE.filters.project = e.target.value;  // Update the filter in STATE
      applyFilters();  // Recalculate STATE.traps and STATE.records
      updateUI();      // Re-render every panel with the filtered data
    });
  }

  // When the user selects a different trapline from the dropdown...
  if (traplineFilter) {
    traplineFilter.addEventListener('change', (e) => {
      STATE.filters.trapline = e.target.value;
      applyFilters();
      updateUI();
    });
  }

  // When the user clicks "Reset", clear all filters back to 'all'
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      clearAllFilters();
    });
  }

  log('✅ Filter event listeners set up');
}

/* ============================================================
   FILTER LOGIC
   These functions manage the project/trapline filter system.
   The key idea: allTraps and allRecords always hold the full
   dataset. Filters produce a smaller subset (STATE.traps and
   STATE.records) which is what all the rendering functions use.
   ============================================================ */

/* ============================================================
   populateFilterOptions — fills the filter dropdowns with options
   ============================================================
   Reads through all traps and collects every unique project name
   and trapline name. Then builds the <option> elements in the
   filter dropdowns. Preserves the user's current selection if it
   still exists in the new data.
   ============================================================ */
function populateFilterOptions() {
  // Clear the existing sets before rebuilding from fresh data
  STATE.availableProjects.clear();
  STATE.availableTraplines.clear();

  // Loop through every trap and collect unique project/trapline names.
  // A Set automatically ignores duplicates.
  STATE.allTraps.forEach(trap => {
    const props = trap.properties || {};
    const project = getProject(props);
    const line = getTrapline(props);
    if (project && project !== '—') STATE.availableProjects.add(project);
    if (line && line !== '—') STATE.availableTraplines.add(line);
  });

  // -- Rebuild the project filter dropdown --
  const projectFilter = document.getElementById('projectFilter');
  if (projectFilter) {
    // Save the currently selected value before we clear the options
    const currentValue = projectFilter.value;
    // Reset to just the "All Projects" default option
    projectFilter.innerHTML = '<option value="all">All Projects</option>';
    // Sort the project names alphabetically and add each as an <option>
    Array.from(STATE.availableProjects).sort().forEach(project => {
      const option = document.createElement('option');
      option.value = project;
      option.textContent = project;
      projectFilter.appendChild(option);
    });
    // Restore the user's previous selection if it still exists
    if (STATE.availableProjects.has(currentValue)) projectFilter.value = currentValue;
  }

  // -- Rebuild the trapline filter dropdown --
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

/* ============================================================
   applyFilters — applies the current filter settings to the data
   ============================================================
   Reads STATE.filters and produces filtered subsets of the data
   (STATE.traps and STATE.records). All rendering functions then
   read from these filtered arrays instead of the full dataset.
   ============================================================ */
function applyFilters() {
  // Filter traps: keep only those that match both the project
  // and trapline filters. If a filter is 'all', it matches everything.
  STATE.traps = STATE.allTraps.filter(trap => {
    const props = trap.properties || {};
    const project = getProject(props);
    const line = getTrapline(props);

    // If project filter is active and this trap's project doesn't match, exclude it
    if (STATE.filters.project !== 'all' && project !== STATE.filters.project) return false;
    // If trapline filter is active and this trap's trapline doesn't match, exclude it
    if (STATE.filters.trapline !== 'all' && line !== STATE.filters.trapline) return false;

    return true;  // This trap passes all filters — include it
  });

  // Build a Set of trap IDs that survived the filter.
  // We'll use this to filter records — only keep records that
  // belong to a trap that is currently visible.
  const filteredTrapIds = new Set(STATE.traps.map(t => t.properties?.trap_id).filter(Boolean));

  // Filter records: keep only records for the currently visible traps
  STATE.records = STATE.allRecords.filter(record => filteredTrapIds.has(record.properties?.trap_id));

  // Update the "Active Filters" notification bar
  updateFilterStatus();
  log(`Filters applied: ${STATE.traps.length}/${STATE.allTraps.length} traps, ${STATE.records.length}/${STATE.allRecords.length} records`);
}

/* ============================================================
   updateFilterStatus — shows or hides the filter status bar
   ============================================================
   If any filter is active, shows a bar below the header
   describing which filters are active and how many traps are
   visible. If no filters are active, hides the bar.
   ============================================================ */
function updateFilterStatus() {
  const filterStatusEl = document.getElementById('filterStatus');
  if (!filterStatusEl) return;

  // Build a list of active filter descriptions
  const activeFilters = [];
  if (STATE.filters.project !== 'all') activeFilters.push(`Project: ${STATE.filters.project}`);
  if (STATE.filters.trapline !== 'all') activeFilters.push(`Trapline: ${STATE.filters.trapline}`);

  if (activeFilters.length > 0) {
    // Show the bar with a description of active filters and the count
    filterStatusEl.style.display = 'block';
    // escapeHtml() is used here because filter values come from the API
    // and we're inserting into innerHTML
    filterStatusEl.innerHTML = `🔍 Active Filters: ${escapeHtml(activeFilters.join(' • '))} | Showing ${STATE.traps.length} of ${STATE.allTraps.length} traps`;
  } else {
    // No active filters — hide the bar
    filterStatusEl.style.display = 'none';
  }
}

/* ============================================================
   clearAllFilters — resets both filters to 'all'
   ============================================================
   Resets STATE.filters, sets the dropdown values back to 'all',
   then re-applies filters and re-renders the whole UI.
   ============================================================ */
function clearAllFilters() {
  // Reset filter state
  STATE.filters.project = 'all';
  STATE.filters.trapline = 'all';

  // Reset the dropdown UI to match
  const projectFilter = document.getElementById('projectFilter');
  const traplineFilter = document.getElementById('traplineFilter');
  if (projectFilter) projectFilter.value = 'all';
  if (traplineFilter) traplineFilter.value = 'all';

  // Re-apply (now empty) filters and re-render
  applyFilters();
  updateUI();
  log('All filters cleared');
}

/* ============================================================
   DATA LOADING
   These functions fetch data from the TrapNZ WFS API.
   WFS (Web Feature Service) is a standard GIS API format.
   The API returns data as GeoJSON — a JSON format where each
   feature has a "geometry" (coordinates) and "properties"
   (attributes like trap type, species caught, etc.).
   ============================================================ */

/* ============================================================
   fetchJsonUtf8 — fetches a URL and decodes the response as UTF-8
   ============================================================
   Parameters:
     url — the URL to fetch
   Returns:
     A Promise that resolves to the parsed JSON object.
   Throws:
     An error if the HTTP response has a non-OK status code.

   WHY CUSTOM UTF-8 DECODING?
   The TrapNZ API sometimes returns data with characters (like
   New Zealand place names with macrons) that get mangled if we
   let the browser auto-detect the encoding. By explicitly
   decoding as UTF-8 using TextDecoder, we ensure characters
   like ā, ē, ī, ō, ū appear correctly.
   ============================================================ */
// Force UTF-8 decode to avoid mojibake (â€" / ðŸ…)
async function fetchJsonUtf8(url) {
  // fetch() makes an HTTP GET request to the URL.
  // 'await' pauses execution until the response arrives.
  const res = await fetch(url);

  // If the HTTP status is not in the 200-299 range, throw an error.
  // res.ok is true for 2xx status codes.
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  // res.arrayBuffer() reads the raw response bytes.
  // This is what allows us to control the text encoding ourselves.
  const buf = await res.arrayBuffer();

  // TextDecoder explicitly decodes the bytes as UTF-8.
  const txt = new TextDecoder('utf-8').decode(buf);

  // JSON.parse() converts the JSON string into a JavaScript object.
  return JSON.parse(txt);
}

/* ============================================================
   loadDashboardData — main data loading orchestrator
   ============================================================
   Called at startup and every 5 minutes (auto-refresh) and when
   the user clicks the Refresh button.

   It fetches traps and check records in parallel (both start at
   the same time), then once both are done it populates filters,
   applies them, and re-renders the UI.

   Uses STATE.isLoading to prevent multiple overlapping fetches.
   ============================================================ */
async function loadDashboardData() {
  // If we're already loading, don't start another fetch
  if (STATE.isLoading) {
    log('⏳ Skip: load in progress');
    return;
  }
  STATE.isLoading = true;
  updateStatus('🔄 Loading data…', 'loading');

  try {
    // Fetch traps and records simultaneously.
    // Promise.all starts both fetches at the same time and waits
    // for BOTH to complete before continuing. This is faster than
    // doing them one after the other.
    const [trapsOk, recordsOk] = await Promise.all([
      loadTrapsData(),
      loadRecordsData()
    ]);

    // If either fetch failed (returned false), show a warning
    if (!trapsOk || !recordsOk) {
      updateStatus('⚠️ Partial data loaded', 'warning');
      return;
    }

    // Both fetches succeeded — now populate filters and render the UI
    populateFilterOptions();
    applyFilters();
    updateUI();
    updateStatus('✅ Data loaded successfully', 'success');
  } catch (e) {
    err('Error loading dashboard data:', e);
    updateStatus(`❌ Error: ${e.message}`, 'error');
  } finally {
    // Always release the loading lock, even if an error occurred.
    // The 'finally' block runs whether try succeeded or threw an error.
    STATE.isLoading = false;
  }
}

/* ============================================================
   updateUI — triggers a full re-render of all dashboard panels
   ============================================================
   Called after data loads or filters change. Calls each
   rendering function in sequence. Each renderer reads from
   STATE.traps and STATE.records (the filtered data).
   ============================================================ */
function updateUI() {
  updateHeaderStats();     // Update the four stat numbers in the header
  updateMapData();         // Redraw the trap pins on the map
  updateAnalytics();       // Redraw all analytics cards and charts
  drawTraplineSummary();   // Redraw the trapline summary table
  drawCheckRecordLog();    // Redraw the check record log table
}

/* ============================================================
   loadTrapsData — fetches all trap locations from TrapNZ
   ============================================================
   Calls the WFS API's "my-projects-traps" layer, which returns
   GeoJSON features where each feature represents one physical
   trap. Stores results in STATE.allTraps.

   Returns true on success, false on error.
   ============================================================ */
async function loadTrapsData() {
  // Build the WFS URL. The parameters mean:
  //   service=WFS        — tell the server this is a WFS request
  //   request=GetFeature — ask for the actual feature data
  //   typeName=...       — which layer/dataset to download
  //   outputFormat=...   — we want GeoJSON (not XML, which is the WFS default)
  //   maxFeatures=1000   — cap at 1000 traps (adjust if your project has more)
  const url = `${CONFIG.WFS_BASE}?service=WFS&request=GetFeature&typeName=trapnz-projects:my-projects-traps&outputFormat=application/json&maxFeatures=1000`;
  try {
    const data = await fetchJsonUtf8(url);
    // The GeoJSON response has a "features" array. We check it's actually
    // an array before using it (defensive programming).
    STATE.allTraps = Array.isArray(data.features) ? data.features : [];
    log(`✅ Loaded ${STATE.allTraps.length} traps`);
    return true;
  } catch (e) {
    err('loadTrapsData', e);
    STATE.allTraps = [];  // Reset to empty so the rest of the app doesn't break
    return false;
  }
}

/* ============================================================
   loadRecordsData — fetches all check records from TrapNZ
   ============================================================
   Calls the WFS API's "my-projects-trap-records" layer. Each
   feature in the response represents one check visit to a trap
   (who checked it, when, whether anything was caught, notes, etc.).
   Stores results in STATE.allRecords.

   maxFeatures=50000 allows for a large history of records.
   Returns true on success, false on error.
   ============================================================ */
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

/* ============================================================
   MAP
   The map is powered by Mapbox GL JS, a library that renders
   interactive vector maps in the browser using WebGL (the same
   technology used for browser-based 3D games).

   Each trap appears as a coloured pin (marker). The colour
   indicates how recently the trap was last checked:
     Green  = checked within 7 days
     Orange = 8–14 days ago
     Red    = more than 14 days ago
   ============================================================ */

// Stores the current map style URL so toggleMapStyle can switch between them
let currentMapStyle = 'mapbox://styles/mapbox/satellite-streets-v12';

/* ============================================================
   initializeMap — creates the Mapbox map instance
   ============================================================
   Creates a new mapboxgl.Map and attaches it to the <div id="map">
   element in the HTML. The map starts centred on the Dunedin
   area at zoom level 11.
   ============================================================ */
function initializeMap() {
  STATE.map = new mapboxgl.Map({
    container: 'map',              // The ID of the HTML element to render the map into
    style: currentMapStyle,        // The visual style (satellite imagery with street labels)
    center: [170.540, -45.909],    // Starting coordinates: [longitude, latitude] (Dunedin-ish)
    zoom: 11                       // Starting zoom level (0 = whole world, 20 = very close up)
  });
}

/* ============================================================
   toggleMapStyle — switches between satellite and street map view
   ============================================================
   Checks whether the current style is satellite. If so, switches
   to the street map; if not, switches to satellite. Then applies
   the new style to the existing map instance.
   ============================================================ */
function toggleMapStyle() {
  if (!STATE.map) return;
  // If the current style URL contains 'satellite', switch to streets, and vice versa.
  currentMapStyle = currentMapStyle.includes('satellite')
    ? 'mapbox://styles/mapbox/streets-v12'
    : 'mapbox://styles/mapbox/satellite-streets-v12';
  STATE.map.setStyle(currentMapStyle);  // Apply the new style to the live map
}

/* ============================================================
   fitAllBounds — zooms the map to show all visible trap pins
   ============================================================
   Calculates a bounding box (rectangle) that contains all trap
   coordinates, then zooms and pans the map to fit that box.
   padding: 50 adds 50px of margin around the pins.
   ============================================================ */
function fitAllBounds() {
  if (!STATE.map || STATE.traps.length === 0) return;

  // LngLatBounds is a Mapbox helper that tracks the minimum/maximum
  // longitude and latitude seen so far.
  const bounds = new mapboxgl.LngLatBounds();

  // Expand the bounding box to include each trap's coordinates.
  // GeoJSON Point coordinates are [longitude, latitude] (opposite
  // to what you might expect — longitude first).
  STATE.traps.forEach(t => {
    const coords = t.geometry?.coordinates;  // ? means "if geometry exists"
    if (Array.isArray(coords) && coords.length >= 2) bounds.extend(coords);
  });

  // Zoom the map to fit the calculated bounds with 50px padding on each side
  STATE.map.fitBounds(bounds, { padding: 50 });
}

/* ============================================================
   updateMapData — draws or redraws all trap markers on the map
   ============================================================
   For each trap in STATE.traps:
     1. Finds the date of the most recent check record for that trap.
     2. Calculates how many days ago that was.
     3. Picks a colour (green/orange/red) based on days since check.
     4. Creates a Mapbox Marker at the trap's coordinates.
     5. Attaches a Popup (info bubble) to the marker.

   Uses a fingerprint (STATE.fp.map) to skip the re-render if
   neither the list of traps nor any check dates have changed.
   ============================================================ */
function updateMapData() {
  if (!STATE.map) return;

  // -- Build a lookup: trap_id → most recent check date string --
  // We need to know the newest check for each trap so we can
  // colour the pin correctly.
  const newestByTrap = new Map();  // Map is like an object but with any key type
  for (const r of STATE.records) {
    const id = r?.properties?.trap_id;     // ? prevents errors if properties is null
    const d  = r?.properties?.record_date;
    if (!id || !d) continue;  // Skip records with no ID or date

    const prev = newestByTrap.get(id);
    // Keep only the most recent date for each trap
    if (!prev || new Date(d) > new Date(prev)) newestByTrap.set(id, d);
  }

  // -- Fingerprint check: has anything changed since the last render? --
  // We create a string that represents the current state of all visible
  // traps and their newest check dates. If it matches the previous
  // fingerprint (STATE.fp.map), the map already shows the correct data
  // and we can skip the expensive re-render.
  const mapKey = JSON.stringify({
    traps: STATE.traps.map(t => t?.properties?.trap_id).sort(),
    newest: Array.from(newestByTrap.entries()).sort()
  });
  if (mapKey === STATE.fp.map) return;  // Nothing changed — skip re-render
  STATE.fp.map = mapKey;  // Save the new fingerprint

  // -- Remove all existing markers before adding new ones --
  // .remove() detaches the marker from the map.
  for (const m of STATE.markers) m.remove();
  STATE.markers = [];  // Clear the array of references

  const bounds = new mapboxgl.LngLatBounds();

  // -- Create a marker for each trap --
  for (const trap of STATE.traps) {
    const props = trap.properties || {};
    const coords = trap.geometry?.coordinates;

    // Skip traps without valid coordinates
    if (!Array.isArray(coords) || coords.length < 2) continue;

    // How many days since this trap was last checked?
    const lastDate = newestByTrap.get(props.trap_id);
    const daysSinceCheck = lastDate
      ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000)
      // 86400000 = milliseconds in one day (24 * 60 * 60 * 1000)
      : 999;  // 999 means "never checked" — will show as red

    // Pick a pin colour based on days since last check
    let markerColor = '#e74c3c';  // Red = overdue (default)
    if (daysSinceCheck <= 7) markerColor = '#27ae60';      // Green = recently checked
    else if (daysSinceCheck <= 14) markerColor = '#f39c12'; // Orange = needs attention

    const project  = getProject(props);
    const trapline = getTrapline(props);

    // Create a Mapbox Marker (the coloured pin on the map).
    // setPopup() attaches an info bubble that appears when the pin is clicked.
    // The popup content is an HTML string built from the trap's properties.
    const marker = new mapboxgl.Marker({ color: markerColor })
      .setLngLat(coords)  // Position the marker at the trap's coordinates
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
      .addTo(STATE.map);  // Add the marker to the map

    STATE.markers.push(marker);  // Keep a reference for later removal
    bounds.extend(coords);       // Expand the bounding box to include this trap
  }

  // If we added any markers, zoom the map to fit all of them
  if (STATE.markers.length) STATE.map.fitBounds(bounds, { padding: 50 });
}

/* ============================================================
   HEADER STATISTICS
   The four stat cards at the top of the dashboard show:
     - Total Traps (count of filtered traps)
     - Checked This Week (records in last 7 days)
     - Total Catches (records where a pest was caught)
     - Last Update (current time, updated on every render)
   ============================================================ */

/* ============================================================
   updateHeaderStats — calculates and displays the header stats
   ============================================================
   Reads STATE.traps and STATE.records (filtered data), calculates
   the four stat values, and updates the DOM elements.
   Uses a fingerprint to avoid unnecessary DOM updates.
   ============================================================ */
function updateHeaderStats() {
  // Find the DOM elements for each stat number
  const totalTrapsElement   = document.getElementById('totalTraps');
  const recentChecksElement = document.getElementById('recentChecks');
  const totalCatchesElement = document.getElementById('totalCatches');
  const lastUpdateElement   = document.getElementById('lastUpdate');

  // Calculate the date 7 days ago (for the "Checked This Week" stat)
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);

  // Count records from the last 7 days.
  // .filter() returns a new array containing only the elements that
  // pass the test function (those with a date >= 7 days ago).
  const recentChecks = STATE.records.filter(r => {
    const d = r?.properties?.record_date;
    return d && new Date(d) >= weekAgo;
  }).length;

  // Count records where a pest was actually caught.
  // A "catch" means species_caught is not empty and not "None".
  const totalCatches = STATE.records.filter(r => {
    const s = r?.properties?.species_caught;
    return s && s !== 'None' && s.trim() !== '';
  }).length;

  // -- Fingerprint check for the header stats --
  // Only update the DOM if any of the numbers have changed.
  const key = `${STATE.traps.length}|${STATE.records.length}|${recentChecks}|${totalCatches}`;
  if (key !== STATE.fp.header) {
    STATE.fp.header = key;  // Save the new fingerprint
    if (totalTrapsElement)   totalTrapsElement.textContent   = STATE.traps.length;
    if (recentChecksElement) recentChecksElement.textContent = recentChecks;
    if (totalCatchesElement) totalCatchesElement.textContent = totalCatches;
  }

  // Always update the "Last Update" time, even if data hasn't changed.
  // toLocaleTimeString formats it as "HH:MM" in New Zealand format.
  if (lastUpdateElement) {
    lastUpdateElement.textContent = new Date().toLocaleTimeString('en-NZ', { hour: '2-digit', minute: '2-digit' });
  }
}

/* ============================================================
   ANALYTICS SECTION
   All the analytics cards below the map. Each card is rendered
   by a dedicated function called from updateAnalytics().
   ============================================================ */

/* ============================================================
   updateAnalytics — orchestrates all analytics card renders
   ============================================================
   Uses a fingerprint to skip the entire analytics section if the
   underlying data hasn't changed since the last render.
   ============================================================ */
function updateAnalytics() {
  // Build a fingerprint from the latest record date and the counts.
  // If neither the number of traps/records nor the newest record
  // has changed, we skip re-rendering.
  const newest = STATE.records.length
    ? STATE.records.map(r => r.properties.record_date).sort().slice(-1)[0]
    : 'NONE';

  const fp = `${STATE.traps.length}|${STATE.records.length}|${newest}`;
  if (fp === STATE.fp.analytics) return;  // Nothing changed — skip
  STATE.fp.analytics = fp;

  // Call each individual renderer
  drawMonthlyCatchTrendsChart();
  drawAnnualCatchChart();
  drawTopPerformers12mo();
  drawWorstPerformers12mo();
  drawSpeciesBreakdown('species12mo', last12MonthCutoff());  // Last 12 months only
  drawCheckActivity12mo();
  drawTopPerformersAllTime();
  drawWorstPerformersAllTime();
  drawSpeciesBreakdown('speciesAllTime', null);  // null = no cutoff = all time
  drawTrapTypePerformance();
  drawOverdueTraps();
  updateLastNotesPanel();
}

/* ============================================================
   ANALYTICS HELPER FUNCTIONS
   Small utility functions used by multiple analytics renderers.
   ============================================================ */

/* ============================================================
   isCatch — tests whether a record represents a successful catch
   ============================================================
   Parameters:
     record — a GeoJSON feature object from STATE.records
   Returns:
     true if the record has a non-empty species_caught value
     that is not "None"; false otherwise.
   ============================================================ */
/* Helpers used by analytics */
function isCatch(record) {
  const s = record?.properties?.species_caught;
  // !! converts any value to a boolean. An empty string is falsy,
  // so !!('' ) is false. A non-empty string like 'Rat' is truthy.
  return !!(s && s !== 'None' && s.trim() !== '');
}

/* ============================================================
   getTrapName — looks up the human-readable code for a trap ID
   ============================================================
   Parameters:
     trapId — the internal TrapNZ trap ID number
   Returns:
     The trap's "code" (e.g. "A-01") if found, or the raw ID
     as a fallback.
   ============================================================ */
function getTrapName(trapId) {
  // Find the trap in STATE.traps that has the matching trap_id
  const t = STATE.traps.find(tt => tt?.properties?.trap_id === trapId);
  // Return the code (human-readable label) or fall back to the numeric ID
  return (t?.properties?.code) || trapId;
}

/* ============================================================
   last12MonthBuckets — generates 12 monthly time buckets
   ============================================================
   Returns:
     An array of 12 objects, one for each of the last 12 calendar
     months (current month included). Each object has:
       key   — "YYYY-MM" string (for grouping records)
       label — "Mon YYYY" string (for chart axis labels)
       start — Date object for the first day of the month
       end   — Date object for the first day of the next month

   These buckets are used to group catch records into monthly
   counts for the catch trends chart.
   ============================================================ */
function last12MonthBuckets() {
  const out = [];
  const now = new Date();
  // Start from the first day of the current month
  const d = new Date(now.getFullYear(), now.getMonth(), 1);

  // Go back 11 months (i = 11 down to 0), then add the current month (i = 0)
  for (let i = 11; i >= 0; i--) {
    // new Date(year, month - i, 1) creates the first day of each month.
    // JavaScript handles month underflow automatically (e.g. month -1 = December last year).
    const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);

    // "YYYY-MM" key used for grouping records by month
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
    // padStart(2, '0') ensures single-digit months get a leading zero: "01", "02", etc.

    // "Mon YYYY" label used on the chart x-axis
    const label = dt.toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' });

    // The next month's first day is used as the exclusive upper bound
    const end = new Date(dt.getFullYear(), dt.getMonth() + 1, 1);

    out.push({ key, label, start: dt, end });
  }
  return out;
}

/* ============================================================
   linearRegressionLine — calculates a trend line for a dataset
   ============================================================
   Parameters:
     values — an array of numbers (e.g. monthly catch counts)
   Returns:
     An array of the same length with the "fitted" y values from
     a least-squares linear regression line.

   WHAT IS LINEAR REGRESSION?
   It finds the straight line that best fits a set of data points.
   For example, if catches are going up over time, the regression
   line will have a positive slope. This line is drawn on the
   chart in red to show the overall trend.

   The mathematics: for a set of points (x=0, y=values[0]),
   (x=1, y=values[1]), etc., we find the slope and intercept
   of the line y = slope*x + intercept that minimises the sum
   of squared distances from each point to the line.
   ============================================================ */
/* Linear regression: returns fitted y values for each x index */
function linearRegressionLine(values) {
  const n = values.length;
  if (n < 2) return values.slice();  // Can't fit a line to fewer than 2 points

  // Calculate the sums needed for the formula
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX  += i;           // Sum of x values (0, 1, 2, ...)
    sumY  += values[i];   // Sum of y values (the actual data)
    sumXY += i * values[i]; // Sum of x*y products
    sumX2 += i * i;       // Sum of x² values
  }

  // Denominator of the slope formula
  const denom = n * sumX2 - sumX * sumX;

  // If denom is 0, all x values are the same — return a flat line at the mean
  if (denom === 0) return values.map(() => sumY / n);

  // Calculate slope and y-intercept using the least-squares formula
  const slope     = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // Calculate the fitted y value for each x position and round to 1 decimal
  return values.map((_, i) => Math.round((slope * i + intercept) * 10) / 10);
}

/* ============================================================
   drawMonthlyCatchTrendsChart — renders the 12-month catch chart
   ============================================================
   Creates a bar chart showing catches per month for the last 12
   months, with a red linear regression trend line overlaid.
   Uses Chart.js to do the actual drawing on a <canvas> element.
   ============================================================ */
function drawMonthlyCatchTrendsChart() {
  const canvas = document.getElementById('catchTrendsChart');
  if (!canvas) return;  // Canvas element doesn't exist — skip

  // Destroy the existing chart before creating a new one.
  // Without this, Chart.js would draw on top of the old chart,
  // causing visual glitches and memory leaks.
  if (STATE.charts.catchTrends) {
    STATE.charts.catchTrends.destroy();
    STATE.charts.catchTrends = null;
  }

  // Generate the 12 month buckets (Jan through to current month)
  const buckets = last12MonthBuckets();

  // Create an array of zero counts, one slot per month bucket
  const counts = new Array(buckets.length).fill(0);

  // Loop through every check record we fetched from TrapNZ.
  // We need to look at each one individually to count catches per month.
  for (const r of STATE.records) {
    if (!isCatch(r)) continue;  // Only count records where something was caught
    const dt = new Date(r.properties.record_date);
    // Find which month bucket this record falls into and increment its count
    for (let i = 0; i < buckets.length; i++) {
      if (dt >= buckets[i].start && dt < buckets[i].end) { counts[i]++; break; }
    }
  }

  // Create the Chart.js bar chart with an overlaid trend line
  STATE.charts.catchTrends = new Chart(canvas.getContext('2d'), {
    type: 'bar',   // The base chart type (bars will be in the background)
    data: {
      labels: buckets.map(b => b.label),  // X-axis labels: "Jan 2024", "Feb 2024", etc.
      datasets: [
        {
          label: 'Catches',
          data: counts,
          backgroundColor: 'rgba(52, 152, 219, 0.75)',  // Semi-transparent blue bars
          borderColor: '#2980b9',
          borderWidth: 1,
          order: 2,  // Draw the bars behind the trend line (higher order = further back)
        },
        {
          label: 'Trend',
          data: linearRegressionLine(counts),  // The calculated trend line values
          type: 'line',            // Override: this dataset draws as a line, not bars
          borderColor: '#e74c3c',  // Red trend line
          borderWidth: 2,
          pointRadius: 0,          // No dots at each data point — just the line
          tension: 0,              // Straight line segments (no curve smoothing)
          fill: false,             // Don't fill the area under the line
          order: 1,                // Draw the line in front of the bars
        }
      ]
    },
    options: {
      responsive: false,         // We control sizing manually (avoids resize loops)
      maintainAspectRatio: false,
      animation: { duration: 300 },  // Quick 300ms animation when chart renders
      plugins: { legend: { display: true, position: 'top' } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      // beginAtZero: y axis starts at 0 (not at the minimum data value)
      // precision: 0 means no decimal places on the y axis ticks
    }
  });
}

/* ============================================================
   drawAnnualCatchChart — renders the all-years catch chart
   ============================================================
   Creates a bar chart showing total catches for each calendar year
   across all historical records, plus a linear trend line.
   ============================================================ */
function drawAnnualCatchChart() {
  const canvas = document.getElementById('annualCatchChart');
  if (!canvas) return;

  // Destroy the old chart to avoid layering issues
  if (STATE.charts.annualTrends) {
    STATE.charts.annualTrends.destroy();
    STATE.charts.annualTrends = null;
  }

  // Tally catches by calendar year.
  // countsByYear is a Map where keys are year numbers and values are counts.
  // Tally catches by calendar year
  const countsByYear = new Map();
  for (const r of STATE.records) {
    if (!isCatch(r)) continue;  // Only count records with a catch
    const yr = new Date(r.properties.record_date).getFullYear();
    if (!isFinite(yr)) continue;  // Skip records with invalid dates
    // Get the existing count for this year (or 0 if first time), then add 1
    countsByYear.set(yr, (countsByYear.get(yr) || 0) + 1);
  }

  // If no catches were found, clear the canvas and return
  if (countsByYear.size === 0) {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Sort the years in chronological order
  const years  = Array.from(countsByYear.keys()).sort((a, b) => a - b);
  // Get the catch count for each year (in the same order)
  const counts = years.map(y => countsByYear.get(y));

  // Create the annual chart (green bars with red trend line)
  STATE.charts.annualTrends = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: years.map(String),  // Convert year numbers to strings for labels
      datasets: [
        {
          label: 'Catches',
          data: counts,
          backgroundColor: 'rgba(39, 174, 96, 0.75)',  // Semi-transparent green
          borderColor: '#1e8449',
          borderWidth: 1,
          order: 2,
        },
        {
          label: 'Trend',
          data: linearRegressionLine(counts),
          type: 'line',
          borderColor: '#e74c3c',  // Red trend line
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

/* ============================================================
   PERFORMER HELPER FUNCTIONS
   Used by the Top Performers and Worst Performers cards.
   "Performers" = individual traps ranked by their catch rate
   (catches ÷ total checks × 100%).
   ============================================================ */
/* ---- Performer helpers ---- */

/* ============================================================
   calcPerformerStats — tallies catches and checks per trap
   ============================================================
   Parameters:
     records — an array of check records (can be filtered by time period)
   Returns:
     An object with two Maps:
       catches — trap_id → number of catches
       checks  — trap_id → number of total checks
   ============================================================ */
/* Tally catches and total checks from a set of records */
function calcPerformerStats(records) {
  const catches = new Map();
  const checks  = new Map();

  for (const r of records) {
    const id = r.properties?.trap_id;
    if (!id) continue;  // Skip records without a trap ID

    // Increment the check count for this trap
    checks.set(id, (checks.get(id) || 0) + 1);

    // If it was a catch, also increment the catch count
    if (isCatch(r)) catches.set(id, (catches.get(id) || 0) + 1);
  }
  return { catches, checks };
}

/* ============================================================
   rateColor — returns a colour for a given catch rate percentage
   ============================================================
   Parameters:
     pct — catch rate as a percentage (0 to 100)
   Returns:
     '#27ae60' (green)  for rate ≥ 30%
     '#f39c12' (orange) for rate ≥ 10%
     '#e74c3c' (red)    for rate < 10%
   ============================================================ */
function rateColor(pct) {
  if (pct >= 30) return '#27ae60';  // Green = high performer
  if (pct >= 10) return '#f39c12';  // Orange = moderate performer
  return '#e74c3c';                 // Red = low performer
}

/* ============================================================
   renderPerformersList — renders a ranked list of traps into a container
   ============================================================
   Parameters:
     containerId — the ID of the DOM element to render into
     items       — array of performer objects (from buildRankedList)
     emptyMsg    — message to show if there are no items to display
   Effect:
     Sets the innerHTML of the container with the rendered list,
     or shows emptyMsg if items is empty.
   ============================================================ */
function renderPerformersList(containerId, items, emptyMsg) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // If there are items, build an HTML string for each one.
  // .map() transforms each item into an HTML string, then .join('')
  // concatenates all the strings into one big HTML block.
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

/* ============================================================
   buildRankedList — builds a sorted list of trap performance data
   ============================================================
   Parameters:
     records   — check records to analyse (can be a time-filtered subset)
     minChecks — minimum number of checks a trap must have to be included
                 (traps with very few checks can have misleading 100% rates)
     order     — a comparator function for .sort() — determines rank order
     limit     — maximum number of results to return (default 5)
   Returns:
     An array of up to `limit` objects, each with:
       { name, catches, checks, rate }
   ============================================================ */
function buildRankedList(records, minChecks, order, limit = 5) {
  const { catches, checks } = calcPerformerStats(records);

  // Array.from(checks.entries()) gives us [[trapId, checkCount], ...] pairs.
  // We filter out traps with too few checks, then map to a richer object,
  // sort by the provided order function, and take the first `limit` results.
  return Array.from(checks.entries())
    .filter(([, c]) => c >= minChecks)  // Only traps with enough checks to be meaningful
    .map(([id, c]) => {
      const caught = catches.get(id) || 0;
      return {
        name:    getTrapName(id),                          // Human-readable trap code
        catches: caught,
        checks:  c,
        rate:    Math.round(caught / c * 100)              // Catch rate as a percentage
      };
    })
    .sort(order)     // Sort by the provided comparator (highest or lowest rate first)
    .slice(0, limit); // Take only the top/bottom N results
}

/* ============================================================
   last12MonthCutoff — returns the start date of the 12-month window
   ============================================================
   Returns:
     A Date object representing the first day of the month that
     was 11 months ago (i.e. the beginning of the 12-month period).
   ============================================================ */
/* Shared cutoff helper */
function last12MonthCutoff() {
  return last12MonthBuckets()[0].start;  // First bucket's start = 12 months ago
}

/* ============================================================
   drawSpeciesBreakdown — renders the species caught breakdown card
   ============================================================
   Parameters:
     containerId — ID of the container element to render into
     cutoff      — a Date before which records are excluded (null = all time)
   Effect:
     Tallies all catches by species and renders a sorted list with
     proportional horizontal bars.
   ============================================================ */
/* ---- Species breakdown ---- */
function drawSpeciesBreakdown(containerId, cutoff) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // Tally catch counts by species name
  const tally = new Map();
  for (const r of STATE.records) {
    if (!isCatch(r)) continue;  // Only catch records

    // If a cutoff date is provided, skip records before that date
    if (cutoff && new Date(r.properties.record_date) < cutoff) continue;

    const sp = (r.properties.species_caught || '').trim();
    tally.set(sp, (tally.get(sp) || 0) + 1);
  }

  if (!tally.size) {
    container.innerHTML = '<div class="loading">No catches recorded</div>';
    return;
  }

  // Sort species by count (highest first)
  const sorted = Array.from(tally.entries()).sort(([, a], [, b]) => b - a);

  // The highest count becomes 100% width; all others are proportional
  const max = sorted[0][1];

  // Build one row per species. The bar width is calculated as a percentage
  // of the maximum count: (this_count / max_count) * 100%.
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

/* ============================================================
   drawCheckActivity12mo — renders the "Check Activity" summary card
   ============================================================
   Calculates four summary statistics for the last 12 months:
     1. Total check visits
     2. Percentage of traps that were visited at least once
     3. Average number of checks per trap
     4. The busiest month (most checks in a single month)
   ============================================================ */
/* ---- Check activity (12 months) ---- */
function drawCheckActivity12mo() {
  const container = document.getElementById('checkActivity12mo');
  if (!container) return;

  // Get the start date of the 12-month window
  const cutoff = last12MonthCutoff();

  // Filter records to only those within the last 12 months
  const period = STATE.records.filter(r => new Date(r.properties.record_date) >= cutoff);

  const totalChecks = period.length;
  const totalTraps  = STATE.traps.length;

  // Count how many unique traps were checked at least once in the period.
  // A Set naturally de-duplicates, so if trap A was checked 5 times,
  // it only appears once in the Set.
  const checkedIds  = new Set(period.map(r => r.properties?.trap_id).filter(Boolean));

  // Percentage of traps that were visited (at least once)
  const pctVisited  = totalTraps ? Math.round(checkedIds.size / totalTraps * 100) : 0;

  // Average checks per trap (to 1 decimal place)
  const avgChecks   = totalTraps ? (totalChecks / totalTraps).toFixed(1) : '0';

  // -- Find the busiest month --
  // Group check counts by "YYYY-MM" key (e.g. "2024-03")
  const byMonth = new Map();
  for (const r of period) {
    // .slice(0, 7) extracts "YYYY-MM" from a "YYYY-MM-DD" date string
    const key = r.properties.record_date?.slice(0, 7);
    if (key) byMonth.set(key, (byMonth.get(key) || 0) + 1);
  }

  let busiestLabel = '—', busiestCount = 0;
  for (const [key, count] of byMonth) {
    if (count > busiestCount) {
      busiestCount = count;
      // Convert "YYYY-MM" to a readable month name like "Mar 2024"
      const [yr, mo] = key.split('-');
      busiestLabel = new Date(+yr, +mo - 1, 1).toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' });
    }
  }

  // Render the four stats in a 2×2 grid
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

/* ============================================================
   drawTrapTypePerformance — compares catch rates by trap type
   ============================================================
   Groups all records by trap type (e.g. "DOC 200", "Timms"),
   calculates each type's catch rate, and renders a ranked list.
   Only includes trap types with at least 5 check records
   (to avoid misleading results from rarely-used trap types).
   ============================================================ */
/* ---- Trap type performance ---- */
function drawTrapTypePerformance() {
  const container = document.getElementById('trapTypePerf');
  if (!container) return;

  // Build a lookup: trap_id → trap_type string.
  // We need this because records don't contain the trap type —
  // it's stored in the trap data. We join them via trap_id.
  // Map trap_id → trap_type
  const typeByTrap = new Map();
  for (const t of STATE.traps) {
    const id   = t.properties?.trap_id;
    const type = (t.properties?.trap_type || 'Unknown').trim();
    if (id) typeByTrap.set(id, type);
  }

  // Tally checks and catches for each trap type
  const catchesByType = new Map();
  const checksByType  = new Map();
  for (const r of STATE.records) {
    const id   = r.properties?.trap_id;
    const type = typeByTrap.get(id) || 'Unknown';  // Look up the type for this record
    checksByType.set(type, (checksByType.get(type) || 0) + 1);
    if (isCatch(r)) catchesByType.set(type, (catchesByType.get(type) || 0) + 1);
  }

  // Build a ranked list of trap types sorted by catch rate (highest first).
  // We require at least 5 checks to get a meaningful rate.
  const rows = Array.from(checksByType.entries())
    .filter(([, c]) => c >= 5)   // At least 5 checks
    .map(([type, checks]) => {
      const caught = catchesByType.get(type) || 0;
      const rate   = Math.round(caught / checks * 100);
      return { type, caught, checks, rate };
    })
    .sort((a, b) => b.rate - a.rate);  // Highest rate first

  if (!rows.length) {
    container.innerHTML = '<div class="loading">Not enough data yet</div>';
    return;
  }

  // Render each trap type as a performer-item row with a rate badge
  container.innerHTML = rows.map(row => `
    <div class="performer-item">
      <div class="performer-info">
        <div class="performer-name">${escapeHtml(row.type)}</div>
        <div class="performer-location">${row.caught} catches · ${row.checks} checks</div>
      </div>
      <div class="performer-rate-badge" style="background:${rateColor(row.rate)};">${row.rate}%</div>
    </div>`).join('');
}

/* ============================================================
   drawOverdueTraps — renders the list of overdue traps
   ============================================================
   Finds all active (non-retired) traps that haven't been checked
   in more than 14 days. Sorts them by most overdue first and
   shows the top 12. Retired traps are excluded because they're
   no longer in service.
   ============================================================ */
/* ---- Overdue traps ---- */
function drawOverdueTraps() {
  const container = document.getElementById('overdueTraps');
  if (!container) return;

  // Build a lookup: trap_id → most recent check date string
  const newestByTrap = new Map();
  for (const r of STATE.records) {
    const id = r.properties?.trap_id;
    const d  = r.properties?.record_date;
    if (!id || !d) continue;
    const prev = newestByTrap.get(id);
    if (!prev || d > prev) newestByTrap.set(id, d);  // String comparison works for ISO dates
  }

  // isRetired checks whether a trap's status or code indicates it's been
  // retired (decommissioned). We don't want retired traps to show up
  // as "overdue" because they're intentionally inactive.
  function isRetired(props) {
    const status = (props?.status || props?.trap_status || '').toLowerCase();
    if (status.includes('retired') || status.includes('removed')) return true;
    const code = (props?.code || '').toLowerCase();
    if (code.includes('(retired)') || code.includes('(removed)')) return true;
    return false;
  }

  // Build the list of overdue traps.
  // We filter out retired traps, calculate days since last check,
  // keep only those over 14 days, sort by most overdue, and take the top 12.
  const overdue = STATE.traps
    .filter(t => !isRetired(t.properties))  // Exclude retired traps
    .map(t => {
      const id   = t.properties?.trap_id;
      const last = newestByTrap.get(id);
      // Calculate days since the last check.
      // Date.now() returns the current time in milliseconds.
      // new Date(last).getTime() converts the date string to milliseconds.
      // Dividing by 86400000 converts milliseconds to days.
      const days = last
        ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000)
        : Infinity;  // Never checked — infinitely overdue
      return { name: t.properties?.code || id, days, last };
    })
    .filter(t => isFinite(t.days) && t.days > 14)   // Only include traps overdue > 14 days; exclude never-checked
    .sort((a, b) => b.days - a.days)   // Most overdue (highest days) first
    .slice(0, 12);                     // Show at most 12 traps

  if (!overdue.length) {
    // Great news — all traps are up to date!
    container.innerHTML = '<div class="loading" style="color:#27ae60;">✅ All traps checked within 14 days</div>';
    return;
  }

  // Render each overdue trap. Traps over 30 days get red badges;
  // traps 15–30 days get orange badges.
  container.innerHTML = overdue.map(t => {
    const daysLabel = `${t.days}d ago`;
    const color     = t.days > 30 ? '#e74c3c' : '#f39c12';  // Red for >30d, orange for >14d
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

/* ============================================================
   drawTopPerformers12mo / drawWorstPerformers12mo /
   drawTopPerformersAllTime / drawWorstPerformersAllTime
   ============================================================
   These four functions call buildRankedList() with different
   parameters to produce top/bottom performers over different
   time windows. The comparator functions passed to .sort()
   determine whether we want highest or lowest rate first.
   ============================================================ */

// Top 9 traps by catch rate over the last 12 months (min. 2 checks to qualify)
function drawTopPerformers12mo() {
  const cutoff = last12MonthBuckets()[0].start;
  // Filter records to last 12 months only
  const period = STATE.records.filter(r => new Date(r.properties.record_date) >= cutoff);
  // Sort by rate descending (best first), break ties by catch count
  const items = buildRankedList(period, 2, (a, b) => b.rate - a.rate || b.catches - a.catches, 9);
  renderPerformersList('topPerformers12mo', items, 'Need ≥2 checks per trap to rank');
}

// Bottom 9 traps by catch rate over the last 12 months (min. 3 checks to qualify)
function drawWorstPerformers12mo() {
  const cutoff = last12MonthBuckets()[0].start;
  const period = STATE.records.filter(r => new Date(r.properties.record_date) >= cutoff);
  // Sort by rate ascending (worst first), break ties by catch count ascending
  const items = buildRankedList(period, 3, (a, b) => a.rate - b.rate || a.catches - b.catches, 9);
  renderPerformersList('worstPerformers12mo', items, 'Need ≥3 checks per trap to rank');
}

// Top 13 traps by catch rate across all time (min. 3 checks to qualify)
function drawTopPerformersAllTime() {
  const items = buildRankedList(STATE.records, 3, (a, b) => b.rate - a.rate || b.catches - a.catches, 13);
  renderPerformersList('topPerformersAllTime', items, 'Need ≥3 checks per trap to rank');
}

// Bottom 13 traps by catch rate across all time (min. 5 checks to qualify —
// higher threshold because with more data, low rates are more meaningful)
function drawWorstPerformersAllTime() {
  const items = buildRankedList(STATE.records, 5, (a, b) => a.rate - b.rate || a.catches - b.catches, 13);
  renderPerformersList('worstPerformersAllTime', items, 'Need ≥5 checks per trap to rank');
}

/* ============================================================
   LAST NOTES PANEL
   Shows the most recent field note for each trap. Supports
   search, sort, pagination, and CSV export. The panel is
   rendered dynamically as HTML inside the #lastNotes div.
   ============================================================ */

/* ============================================================
   setLastNotesState — updates the notes UI state and re-renders
   ============================================================
   Parameters:
     patch — an object with one or more properties of STATE.ui.lastNotes
             to update (e.g. { query: 'rat', page: 1 })
   Effect:
     Merges the patch into STATE.ui.lastNotes and triggers a re-render.

   Using Object.assign() to merge changes means callers only need
   to specify what changed — everything else stays the same.
   ============================================================ */
function setLastNotesState(patch = {}) {
  Object.assign(STATE.ui.lastNotes, patch);  // Merge the patch into the state
  renderLastNotesPanel();  // Re-render the panel with the updated state
}

/* ============================================================
   computeLastNotesFromRecords — builds the notes data structure
   ============================================================
   Returns:
     An array of objects, one per trap, each with:
       { trap_id, code, date, note }
     where date and note are from the most recent record that
     has a non-empty note for that trap.
     Sorted by date descending (traps with notes first, then by
     alphabetical code).
   ============================================================ */
function computeLastNotesFromRecords() {
  if (!STATE.records?.length) return [];

  const NOTE_FIELD = 'record_notes';  // The property name in TrapNZ records

  // byTrap maps trap_id → { date, note } for the most recent note.
  // If a trap has been checked multiple times, we only keep the
  // most recent note.
  const byTrap = new Map();

  for (const r of STATE.records) {
    const p    = r.properties || {};
    const id   = p.trap_id;
    const dt   = p.record_date ? new Date(p.record_date) : null;
    const note = (p[NOTE_FIELD] || '').trim();

    if (!id || !dt) continue;  // Skip records with no ID or date
    if (!note) continue;       // Skip records with no note

    const prev = byTrap.get(id);
    // Keep only the most recent note for each trap
    if (!prev || dt > prev.date) byTrap.set(id, { date: dt, note });
  }

  // Build one item per trap (including traps with no notes)
  const items = STATE.traps.map(t => {
    const pid  = t.properties.trap_id;
    const code = t.properties.code || pid;
    const entry = byTrap.get(pid);  // The most recent note entry (or undefined)
    return {
      trap_id: pid,
      code,
      date: entry?.date || null,  // null if no note exists
      note: entry?.note || ''
    };
  });

  // Sort: traps with notes first (by most recent date descending),
  // then traps without notes (sorted alphabetically by code)
  items.sort((a, b) => {
    if (a.date && b.date) return b.date - a.date;  // Both have notes: newest first
    if (a.date) return -1;    // a has a note, b doesn't: a goes first
    if (b.date) return 1;     // b has a note, a doesn't: b goes first
    return String(a.code).localeCompare(String(b.code));  // Neither has notes: alphabetical
  });

  return items;
}

/* ============================================================
   updateLastNotesPanel — rebuilds the notes items list then renders
   ============================================================
   Called when fresh data arrives. Recomputes the items list from
   scratch and resets the page to 1.
   ============================================================ */
async function updateLastNotesPanel() {
  // Show a loading placeholder while we compute
  const container = document.getElementById('lastNotes');
  if (container) container.innerHTML = `<div class="loading">Preparing notes…</div>`;

  // Compute the full notes list from the current records
  const items = computeLastNotesFromRecords();
  STATE.ui.lastNotes.items = items;
  STATE.ui.lastNotes.page  = 1;  // Reset to page 1 whenever data is refreshed
  renderLastNotesPanel();
}

/* ============================================================
   renderLastNotesPanel — renders the notes panel HTML
   ============================================================
   Reads STATE.ui.lastNotes (which includes the search query,
   sort order, page, and items list) and generates the complete
   HTML for the panel: controls, list of notes, and pagination.

   Also re-attaches all the event listeners for the controls
   (search input, checkboxes, selects, buttons) because we are
   replacing the entire innerHTML — previous event listeners
   are lost when elements are replaced.
   ============================================================ */
function renderLastNotesPanel() {
  const container = document.getElementById('lastNotes');
  if (!container) return;

  // -- Preserve the cursor position in the search box --
  // When we replace innerHTML, the search box is destroyed and
  // recreated. If the user is typing in it, we save the cursor
  // position and restore it after the re-render.
  const wasActive = document.activeElement && document.activeElement.id === 'ln-search';
  const caret = wasActive ? {
    start: document.activeElement.selectionStart,
    end:   document.activeElement.selectionEnd
  } : null;

  const state    = STATE.ui.lastNotes;
  const allItems = state.items || [];

  // -- Apply search query filter --
  const q = state.query.trim().toLowerCase();
  let filtered = allItems.filter(it => {
    const hasNote = !!it.note;
    // If "Only with notes" checkbox is checked, skip traps without a note
    if (state.onlyWithNotes && !hasNote) return false;

    // If there's no search query, include everything that passed the above check
    if (!q) return true;

    // Build a haystack string from the trap code and note text.
    // We search case-insensitively (both haystack and query are lowercased).
    const hay = `trap ${it.code} ${it.note}`.toLowerCase();
    return hay.includes(q);
  });

  // -- Apply sort order --
  filtered.sort((a, b) => {
    if (state.sort === 'date_desc') {
      // Newest note first; traps with no note go to the end
      if (a.date && b.date) return b.date - a.date;
      if (a.date) return -1; if (b.date) return 1;
      return String(a.code).localeCompare(String(b.code));
    }
    if (state.sort === 'date_asc') {
      // Oldest note first; traps with no note go to the beginning
      if (a.date && b.date) return a.date - b.date;
      if (a.date) return 1; if (b.date) return -1;
      return String(a.code).localeCompare(String(b.code));
    }
    if (state.sort === 'trap_asc')  return String(a.code).localeCompare(String(b.code));
    if (state.sort === 'trap_desc') return String(b.code).localeCompare(String(a.code));
    return 0;
  });

  // -- Pagination calculations --
  const total     = filtered.length;
  const pages     = Math.max(1, Math.ceil(total / state.perPage));
  const page      = Math.min(state.page, pages);  // Clamp page to valid range
  const start     = (page - 1) * state.perPage;
  const pageItems = filtered.slice(start, start + state.perPage);  // The items for this page

  // -- Build the HTML for the visible page items --
  // Each item shows the trap code, date, and note text.
  const listHTML = pageItems.map(it => `
    <div class="ln-item">
      <div class="ln-row">
        <div class="ln-trap">Trap ${escapeHtml(it.code)}</div>
        <div class="ln-date">${it.date ? new Date(it.date).toLocaleDateString('en-NZ') : '—'}</div>
      </div>
      <div class="ln-note">${it.note ? escapeHtml(it.note) : '<span class="muted">No note</span>'}</div>
    </div>
  `).join('');

  // -- Render the complete panel HTML --
  // This includes: controls (search, checkbox, sort, page size, export),
  // the note list, and the pagination row.
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

  // -- Re-attach event listeners to all the freshly rendered controls --
  // We use a shorthand $ helper to avoid typing document.getElementById repeatedly.
  const $ = id => document.getElementById(id);

  // When the user types in the search box, update the query and reset to page 1
  $('ln-search').oninput   = e => setLastNotesState({ query: e.target.value, page: 1 });

  // When the "Only with notes" checkbox changes, update the filter and reset to page 1
  $('ln-only').onchange    = e => setLastNotesState({ onlyWithNotes: !!e.target.checked, page: 1 });

  // When the sort dropdown changes, update the sort order and reset to page 1
  $('ln-sort').onchange    = e => setLastNotesState({ sort: e.target.value, page: 1 });

  // When the page size dropdown changes, update perPage and reset to page 1.
  // Number() converts the string value (e.g. "20") to a number.
  $('ln-size').onchange    = e => setLastNotesState({ perPage: Number(e.target.value), page: 1 });

  // Pagination buttons navigate one page at a time, clamped to valid range
  $('ln-prev').onclick     = () => setLastNotesState({ page: Math.max(1, page - 1) });
  $('ln-next').onclick     = () => setLastNotesState({ page: Math.min(pages, page + 1) });

  // -- CSV export logic --
  // toCSV converts a 2D array of values into a CSV string.
  // Each value is wrapped in double quotes, and any double quotes
  // inside values are escaped by doubling them ("" in CSV).
  const toCSV = rows => {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return rows.map(r => r.map(esc).join(',')).join('\n');
  };

  // When the Export CSV button is clicked...
  $('ln-export').onclick = () => {
    // Determine whether to export just the current page or all filtered results
    const which = $('ln-export-which').value;
    const rows = [
      ['Trap','Last note date','Note'],  // CSV header row
      // Map each note item to a row of values for the CSV
      ...((which === 'visible') ? pageItems : filtered).map(it => [
        `Trap ${it.code}`,
        it.date ? new Date(it.date).toLocaleDateString('en-NZ') : '',
        it.note || ''
      ])
    ];

    // Create a Blob (Binary Large Object) — a file-like object in memory.
    // The type tells the browser this is a CSV file.
    const blob = new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8;' });

    // URL.createObjectURL() creates a temporary URL pointing to the Blob.
    // This is how we trigger a file download without a server.
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = which === 'visible' ? 'trap-last-notes_visible.csv' : 'trap-last-notes_all.csv';
    a.click();  // Programmatically click the invisible link to trigger the download

    // Release the temporary URL to free memory
    URL.revokeObjectURL(url);
  };
}

/* ============================================================
   DETAILED REPORTS SECTION
   Two panels below the analytics grid:
     1. Trapline Summary table — one row per trapline
     2. Check Record Log — individual check records, paginated
   ============================================================ */
/* ----------------------------- REPORTS TABLE ----------------------------- */
/* ========================= DETAILED REPORTS ========================= */

/* ============================================================
   buildTrapMeta — builds a lookup of trap metadata by trap_id
   ============================================================
   Returns:
     A Map from trap_id to { name, trapline, project }.
   This avoids repeatedly searching STATE.traps when we need
   to look up a trap's name or trapline for a given record.
   ============================================================ */
/* Shared trap-meta lookup: trap_id → { name, trapline, project } */
function buildTrapMeta() {
  const map = new Map();
  for (const t of STATE.traps) {
    const id = t.properties?.trap_id;
    if (!id) continue;
    map.set(id, {
      name:     t.properties?.code || id,          // Human-readable code (e.g. "A-01")
      trapline: getTrapline(t.properties),          // Trapline name
      project:  getProject(t.properties),           // Project name
    });
  }
  return map;
}

/* ============================================================
   drawTraplineSummary — builds and stores trapline summary data
   ============================================================
   Aggregates all traps and records into per-trapline statistics:
   trap count, total checks, total catches, catch rate, overdue count,
   and most recent check date. Then calls renderTraplineSummary()
   to display the data as a table.
   ============================================================ */
/* ---- Trapline Summary ---- */
function drawTraplineSummary() {
  const trapMeta = buildTrapMeta();

  // -- Aggregate per trapline --
  // byLine maps trapline_name → { project, trapIds: Set, checks, catches, lastCheck }
  const byLine = new Map();
  for (const t of STATE.traps) {
    const id   = t.properties?.trap_id;
    const meta = trapMeta.get(id);
    if (!meta) continue;

    // Create an entry for this trapline if we haven't seen it yet
    if (!byLine.has(meta.trapline)) {
      byLine.set(meta.trapline, { project: meta.project, trapIds: new Set(), checks: 0, catches: 0, lastCheck: null });
    }
    // Add this trap's ID to the trapline's set (a Set auto-deduplicates)
    byLine.get(meta.trapline).trapIds.add(id);
  }

  // -- Count checks / catches and track the newest check per trap --
  // Count checks / catches; track newest check per trap for overdue
  const newestByTrap = new Map();
  for (const r of STATE.records) {
    const id   = r.properties?.trap_id;
    const d    = r.properties?.record_date;
    const meta = trapMeta.get(id);
    if (!id || !d || !meta) continue;

    const entry = byLine.get(meta.trapline);
    if (!entry) continue;

    entry.checks++;  // Count every check for this trapline
    if (isCatch(r)) entry.catches++;  // Count catches

    // Track the latest check date for the trapline
    if (!entry.lastCheck || d > entry.lastCheck) entry.lastCheck = d;

    // Also track the latest check date per individual trap (for overdue calculations)
    const prev = newestByTrap.get(id);
    if (!prev || d > prev) newestByTrap.set(id, d);
  }

  // -- Count overdue traps per trapline --
  // A trap is overdue if its last check was more than 14 days ago.
  // Overdue count per trapline
  const overdueCounts = new Map();
  for (const t of STATE.traps) {
    const id   = t.properties?.trap_id;
    const meta = trapMeta.get(id);
    if (!meta) continue;

    const last = newestByTrap.get(id);
    const days = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : Infinity;
    if (days > 14) overdueCounts.set(meta.trapline, (overdueCounts.get(meta.trapline) || 0) + 1);
  }

  // -- Build the final sorted items array --
  // Convert the Map to an array of plain objects, then sort alphabetically
  // by project first, then by trapline name within each project.
  const items = Array.from(byLine.entries()).map(([line, d]) => ({
    line,
    project:   d.project,
    traps:     d.trapIds.size,     // Number of unique traps in this trapline
    checks:    d.checks,
    catches:   d.catches,
    rate:      d.checks > 0 ? Math.round(d.catches / d.checks * 100) : 0,
    overdue:   overdueCounts.get(line) || 0,
    lastCheck: d.lastCheck,
  })).sort((a, b) => a.project.localeCompare(b.project) || a.line.localeCompare(b.line));

  STATE.ui.traplineSum.items = items;
  STATE.ui.traplineSum.page  = 1;  // Reset to first page whenever data updates
  renderTraplineSummary();
}

/* ============================================================
   renderTraplineSummary — renders the trapline summary table
   ============================================================
   Reads STATE.ui.traplineSum and renders the paginated table.
   Clicking a row in the table filters the Check Record Log
   to that trapline.
   ============================================================ */
function renderTraplineSummary() {
  const container = document.getElementById('traplineSummary');
  if (!container) return;

  const st    = STATE.ui.traplineSum;
  const total = st.items.length;
  const pages = Math.max(1, Math.ceil(total / st.perPage));
  const page  = Math.min(st.page, pages);  // Clamp to valid page range

  // Get the slice of items for the current page
  const slice = st.items.slice((page - 1) * st.perPage, page * st.perPage);

  // Build one <tr> per trapline.
  // The data-trapline attribute stores the trapline name so the click handler can read it.
  const rows = slice.map(t => `
    <tr class="summary-row" data-trapline="${escapeHtml(t.line)}" title="Click to filter log">
      <td>${escapeHtml(t.line)}</td>
      <td>${escapeHtml(t.project)}</td>
      <td>${t.traps}</td>
      <td>${t.checks}</td>
      <td>${t.catches}</td>
      <td><span class="rate-pill" style="background:${rateColor(t.rate)}">${t.rate}%</span></td>
      <td class="${t.overdue > 0 ? 'overdue-cell' : 'ok-cell'}">${t.overdue > 0 ? `⚠️ ${t.overdue}` : '✅ 0'}</td>
      <td>${t.lastCheck ? new Date(t.lastCheck).toLocaleDateString('en-NZ') : '—'}</td>
    </tr>`).join('');

  container.innerHTML = `
    <table class="report-table">
      <thead><tr>
        <th>Trapline</th><th>Project</th><th>Traps</th>
        <th>Checks</th><th>Catches</th><th>Rate</th>
        <th>Overdue</th><th>Last Check</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="report-pager">
      <button id="ts-prev" class="page-btn" ${page <= 1 ? 'disabled' : ''}>Prev</button>
      <span class="pager-text">Page ${page} of ${pages} · ${total} traplines</span>
      <button id="ts-next" class="page-btn" ${page >= pages ? 'disabled' : ''}>Next</button>
    </div>`;

  // -- Click row → filter the log to that trapline --
  // When the user clicks a row in the summary table, we filter the
  // check record log to show only records for that trapline.
  // Click row → filter the log to that trapline
  container.querySelectorAll('.summary-row').forEach(row => {
    row.addEventListener('click', () => {
      const line = row.dataset.trapline;  // Read the trapline name from the data attribute
      STATE.ui.checkLog.trapline = line;
      STATE.ui.checkLog.page    = 1;     // Reset to page 1

      // Also update the trapline dropdown in the log header to reflect the change
      const sel = document.getElementById('logTrapline');
      if (sel) sel.value = line;

      renderCheckRecordLog();
    });
  });

  // Pagination button handlers
  document.getElementById('ts-prev').onclick = () => {
    STATE.ui.traplineSum.page = Math.max(1, page - 1);
    renderTraplineSummary();
  };
  document.getElementById('ts-next').onclick = () => {
    STATE.ui.traplineSum.page = Math.min(pages, page + 1);
    renderTraplineSummary();
  };
}

/* ============================================================
   drawCheckRecordLog — initialises the check record log
   ============================================================
   Called when fresh data arrives. Builds the trap metadata lookup,
   populates the trapline filter dropdown, resets to page 1,
   and calls renderCheckRecordLog().
   ============================================================ */
/* ---- Check Record Log ---- */
function drawCheckRecordLog() {
  // Build and cache the trap metadata lookup for use in renderCheckRecordLog()
  STATE._trapMeta = buildTrapMeta();

  // -- Populate the trapline filter dropdown for the log --
  const sel = document.getElementById('logTrapline');
  if (sel) {
    const cur = sel.value;  // Remember current selection
    sel.innerHTML = '<option value="all">All Traplines</option>';
    Array.from(STATE.availableTraplines).sort().forEach(line => {
      const o = document.createElement('option');
      o.value = line; o.textContent = line;
      sel.appendChild(o);
    });
    // Restore the user's previous selection if it still exists
    if (STATE.availableTraplines.has(cur)) sel.value = cur;
  }

  STATE.ui.checkLog.page = 1;
  renderCheckRecordLog();
}

/* ============================================================
   renderCheckRecordLog — renders the check record log table
   ============================================================
   Filters STATE.records based on the selected period and trapline,
   sorts them newest first, and renders a paginated table.
   Also stores the filtered+sorted records in STATE.ui.checkLog.filtered
   so the CSV export function can access them.
   ============================================================ */
function renderCheckRecordLog() {
  const container = document.getElementById('checkRecordLog');
  if (!container) return;

  const st   = STATE.ui.checkLog;
  const meta = STATE._trapMeta || new Map();  // Trap metadata lookup

  // -- Calculate the cutoff date based on the period filter --
  // e.g. if period is '30', cutoff is 30 days ago.
  // If period is 'all', cutoff is null (no cutoff).
  const cutoff = st.period !== 'all'
    ? new Date(Date.now() - Number(st.period) * 86400000)  // Current time minus N days
    : null;

  // -- Filter and sort the records --
  const filtered = STATE.records
    .filter(r => {
      const d = r.properties?.record_date;
      if (!d) return false;  // Skip records without a date

      // Exclude records before the cutoff date
      if (cutoff && new Date(d) < cutoff) return false;

      // If a specific trapline is selected, exclude records from other traplines
      if (st.trapline !== 'all') {
        const m = meta.get(r.properties?.trap_id);
        if (!m || m.trapline !== st.trapline) return false;
      }
      return true;  // This record passes all filters
    })
    // Sort by date, newest first. String comparison works for ISO 8601 dates.
    .sort((a, b) => (b.properties.record_date || '').localeCompare(a.properties.record_date || ''));

  // Store the filtered+sorted records for export
  STATE.ui.checkLog.filtered = filtered;

  // -- Pagination --
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / st.perPage));
  const page  = Math.min(st.page, pages);
  const slice = filtered.slice((page - 1) * st.perPage, page * st.perPage);

  // -- Build one table row per record on the current page --
  const rows = slice.map(r => {
    const p      = r.properties || {};
    const m      = meta.get(p.trap_id) || { name: p.trap_id, trapline: '—' };
    const catch_ = isCatch(r);  // Was something caught?
    return `
      <tr>
        <td>${p.record_date ? new Date(p.record_date).toLocaleDateString('en-NZ') : '—'}</td>
        <td>${escapeHtml(m.name)}</td>
        <td>${escapeHtml(m.trapline)}</td>
        <td class="${catch_ ? 'result-catch' : 'result-clear'}">${catch_ ? '🎯 Catch' : '✅ Clear'}</td>
        <td>${catch_ ? escapeHtml(p.species_caught) : '—'}</td>
        <td class="notes-cell">${p.record_notes ? escapeHtml(p.record_notes) : ''}</td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="report-table">
      <thead><tr>
        <th>Date</th><th>Trap</th><th>Trapline</th>
        <th>Result</th><th>Species</th><th>Notes</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:#7f8c8d;padding:20px;">No records match current filters</td></tr>'}</tbody>
    </table>
    <div class="report-pager">
      <button id="cl-prev" class="page-btn" ${page <= 1 ? 'disabled' : ''}>Prev</button>
      <span class="pager-text">Page ${page} of ${pages} · ${total} records</span>
      <button id="cl-next" class="page-btn" ${page >= pages ? 'disabled' : ''}>Next</button>
    </div>`;

  // Attach pagination button handlers
  document.getElementById('cl-prev').onclick = () => {
    STATE.ui.checkLog.page = Math.max(1, page - 1);
    renderCheckRecordLog();
  };
  document.getElementById('cl-next').onclick = () => {
    STATE.ui.checkLog.page = Math.min(pages, page + 1);
    renderCheckRecordLog();
  };
}

/* ============================================================
   exportCheckLog — exports the filtered check records as a CSV file
   ============================================================
   Reads STATE.ui.checkLog.filtered (the currently filtered and
   sorted records) and triggers a browser file download.
   The CSV file can be opened in Excel, Google Sheets, etc.
   ============================================================ */
/* ---- Export check log CSV ---- */
function exportCheckLog() {
  const filtered = STATE.ui.checkLog.filtered;

  // If there's nothing to export, tell the user
  if (!filtered?.length) {
    alert('No records to export — adjust filters and try again.');
    return;
  }

  const meta = STATE._trapMeta || new Map();

  // esc wraps a value in double quotes and escapes any existing double quotes.
  // This is the standard way to handle special characters (commas, newlines)
  // in CSV format.
  const esc     = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const headers = ['Date', 'Trap', 'Trapline', 'Project', 'Result', 'Species', 'Notes'];

  // Build one CSV row per check record
  const rows = filtered.map(r => {
    const p = r.properties || {};
    const m = meta.get(p.trap_id) || { name: p.trap_id, trapline: '—', project: '—' };
    return [
      p.record_date ? new Date(p.record_date).toLocaleDateString('en-NZ') : '',
      m.name,
      m.trapline,
      m.project,
      isCatch(r) ? 'Catch' : 'Clear',
      (p.species_caught && p.species_caught !== 'None') ? p.species_caught : '',
      p.record_notes || '',
    ].map(esc).join(',');  // Escape each value and join with commas
  });

  // Combine header row and data rows into a single CSV string
  const csv  = [headers.map(esc).join(','), ...rows].join('\n');

  // Create a Blob in memory and generate a download link
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;

  // Include today's date in the filename so downloaded files are easy to identify
  a.download = `check-log_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();  // Trigger the download

  URL.revokeObjectURL(url);  // Free the temporary URL
}

/* ============================================================
   TRAP DETAIL MODAL
   Clicking "View Details" on a map pin popup calls showTrapDetails().
   It finds the trap by ID, gathers its most recent records,
   and populates the modal panel that appears in the middle
   of the screen.
   ============================================================ */

/* ============================================================
   showTrapDetails — opens the trap detail modal for a given trap ID
   ============================================================
   Parameters:
     trapId — the TrapNZ trap ID (as passed from the map popup button)
   Effect:
     Finds the trap and its records in STATE.allTraps / STATE.allRecords,
     builds the modal content, and makes the modal visible.

   Note: we use STATE.allTraps and STATE.allRecords here (not the
   filtered versions) so the modal always works even when the trap's
   data would be hidden by a current filter.
   ============================================================ */
function showTrapDetails(trapId) {
  // Convert to string to handle both numeric and string IDs consistently
  const idStr = String(trapId);

  // Find the trap in the full (unfiltered) dataset
  const trap = STATE.allTraps.find(t => String(t.properties.trap_id) === idStr);
  if (!trap) {
    console.warn('Trap not found for id:', trapId);
    return;
  }

  const props = trap.properties || {};

  // Find all check records for this specific trap, sorted newest first.
  // We use STATE.allRecords (not STATE.records) so the modal works
  // even when the trap is filtered out of the main view.
  const trapRecords = STATE.allRecords
    .filter(r => String(r.properties.trap_id) === idStr)
    .sort((a, b) => new Date(b.properties.record_date) - new Date(a.properties.record_date));

  // The most recent record (or undefined if no records yet)
  const last = trapRecords[0];

  // How many days since the last check?
  const daysSinceCheck = last
    ? Math.floor((Date.now() - new Date(last.properties.record_date).getTime()) / 86400000)
    : 'N/A';

  // Find the modal elements
  const modal = document.getElementById('trapModal');
  const body  = document.getElementById('modalTrapContent');
  const title = document.getElementById('modalTrapTitle');
  if (!modal || !body || !title) return;

  const project  = getProject(props);
  const trapline = getTrapline(props);

  // Set the modal title to the trap's code
  title.textContent = `Trap ${props.code || props.trap_id}`;

  // Build and set the modal body HTML.
  // .slice(0, 10) shows at most the 10 most recent check records.
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

  // Make the modal visible. The CSS for .modal has display: none by default.
  modal.style.display = 'block';
}


/* ============================================================
   GLOBAL EXPORTS
   Functions that need to be called from inline HTML (e.g.
   from onclick attributes in map popup buttons) must be
   attached to the window object. Otherwise, they would be
   scoped to this module and not accessible from HTML.
   ============================================================ */
/* ---------------------------- GLOBAL EXPORTS ----------------------------- */
window.showTrapDetails = showTrapDetails;

/* ============================================================
   LOGOUT HANDLER
   The Sign Out button calls POST /api/logout, which clears the
   session cookie on the server side. We then redirect to /login
   regardless of whether the API call succeeded (using 'finally').
   Even if the API call fails (e.g. network error), we still want
   to navigate to the login page so the user sees the session is gone.
   ============================================================ */
/* -------------------------------- LOGOUT --------------------------------- */
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  try {
    // Tell the server to clear the session cookie.
    // The ?. (optional chaining) before addEventListener() means this
    // line is skipped silently if #logoutBtn doesn't exist in the DOM.
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    // Whether the API call succeeded or failed, redirect to the login page.
    // 'finally' always runs — it's the cleanup block in try/finally.
    window.location.href = '/login';
  }
});

// Log a startup message to the browser console for debugging
log('🎯 Trapping Dashboard loaded');
