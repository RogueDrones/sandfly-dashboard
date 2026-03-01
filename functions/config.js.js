/**
 * Cloudflare Pages Function — serves /config.js dynamically.
 *
 * Reads API keys from Cloudflare Pages environment variables and injects
 * them into a JavaScript response that the browser treats as config.js.
 *
 * Set these in Cloudflare Pages → Settings → Environment Variables:
 *   TRAPNZ_API_KEY
 *   MAPBOX_TOKEN
 */
export async function onRequest(context) {
  const keys = {
    TRAPNZ_API_KEY: context.env.TRAPNZ_API_KEY || '',
    MAPBOX_TOKEN:   context.env.MAPBOX_TOKEN   || '',
  };

  const body = `window.DASHBOARD_KEYS = ${JSON.stringify(keys)};`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/javascript' },
  });
}
