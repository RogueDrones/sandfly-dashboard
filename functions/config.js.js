/* ============================================================
   Cloudflare Pages Function — Dynamic Config Injector
   ============================================================
   This file is a Cloudflare Pages Function. That means Cloudflare
   runs it on its servers (not in the browser) every time someone
   visits "/config.js". Instead of serving a static file, Cloudflare
   calls the function below and uses whatever it returns as the
   response.

   WHY IS THIS NEEDED?
   API keys (like the TrapNZ key and Mapbox token) must not be
   hard-coded into files that get committed to GitHub or stored
   in public places, because anyone could read them. Instead, we
   store the keys as SECRET ENVIRONMENT VARIABLES inside the
   Cloudflare dashboard (Pages → Settings → Environment Variables).
   This function reads those secrets on the server side and writes
   them into a tiny JavaScript snippet that gets sent to the browser.
   The browser then runs that snippet, which puts the keys into a
   global variable (window.DASHBOARD_KEYS) that app.js can read.

   To set these up, go to:
     Cloudflare Pages → Your project → Settings → Environment Variables
   and add:
     TRAPNZ_API_KEY   — your TrapNZ WFS API key
     MAPBOX_TOKEN     — your Mapbox public access token
   ============================================================ */

/* ============================================================
   onRequest — the main handler Cloudflare calls for every request
   to /config.js
   ============================================================
   Parameters:
     context — an object Cloudflare provides automatically. It contains:
       context.env — the environment variables you set in the Cloudflare
                     dashboard. Think of env as a locked safe: only
                     server-side code can open it.
   Returns:
     A Response object containing a tiny JavaScript file. The browser
     loads this like any other .js file and immediately executes it,
     setting window.DASHBOARD_KEYS so the rest of the app can use
     the API keys.
   ============================================================ */
export async function onRequest(context) {
  // -- Subsection: Read secrets from the server environment --
  // context.env is Cloudflare's way of giving server code access to
  // environment variables. If a variable hasn't been set, we fall
  // back to an empty string so the app doesn't crash — it just won't
  // have a working API key.
  const keys = {
    TRAPNZ_API_KEY: context.env.TRAPNZ_API_KEY || '',
    MAPBOX_TOKEN:   context.env.MAPBOX_TOKEN   || '',
  };

  // -- Subsection: Build the JavaScript snippet --
  // JSON.stringify(keys) converts the keys object into a JSON string,
  // e.g. {"TRAPNZ_API_KEY":"abc123","MAPBOX_TOKEN":"pk.xyz"}.
  // We wrap it in "window.DASHBOARD_KEYS = ...;" so the browser
  // treats it as a variable assignment when it loads the script.
  const body = `window.DASHBOARD_KEYS = ${JSON.stringify(keys)};`;

  // -- Subsection: Return the response --
  // We tell the browser this is a JavaScript file (application/javascript)
  // so it knows to execute it rather than display it as text.
  return new Response(body, {
    headers: { 'Content-Type': 'application/javascript' },
  });
}
