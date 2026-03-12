/* ============================================================
   Cloudflare Pages Function — POST /api/logout
   ============================================================
   This file handles the "Sign Out" action. When the user clicks
   the Sign Out button in the dashboard, the browser sends a POST
   request to /api/logout. This function runs on Cloudflare's
   servers and does two things:
     1. Erases the session cookie from the browser (so the browser
        no longer has a "logged in" token).
     2. Redirects the user to the /login page.

   A COOKIE is a small piece of data the browser stores and sends
   automatically with every request to the same website. The session
   cookie is what proves the user is logged in. Erasing it is the
   equivalent of tearing up your entry pass — the next request will
   have no proof of login and the middleware will send you back to
   the login page.

   This function only accepts POST requests (not GET). That prevents
   someone from accidentally logging you out by tricking your browser
   into loading a URL in an image tag or link.
   ============================================================ */

// -- Subsection: Cookie name constant --
// This must exactly match the name used in login.js and _middleware.js.
// Using a shared constant name means we always erase the right cookie.
const COOKIE_NAME = 'sd_session';

/* ============================================================
   onRequestPost — handles POST /api/logout
   ============================================================
   This function is called automatically by Cloudflare when a POST
   request arrives at /api/logout. It takes no meaningful input
   (we don't need to know anything about the user to log them out).

   What it does:
     - Builds a "Set-Cookie" header that tells the browser to
       immediately expire (delete) the session cookie.
     - Returns a 302 redirect response pointing to /login.
   ============================================================ */
export async function onRequestPost() {
  // -- Subsection: Build the cookie-clearing header --
  // To delete a cookie from the browser, we set it again with
  // Max-Age=0. This tells the browser "this cookie expired 0 seconds
  // from now", which means "delete it immediately".
  // The other flags (HttpOnly, Secure, SameSite, Path) must match
  // exactly what was used when the cookie was originally set, so
  // the browser knows which cookie we mean.
  const clearCookie = [
    `${COOKIE_NAME}=`,   // Set the cookie value to empty (about to be deleted)
    'HttpOnly',          // Browser JS cannot read or tamper with this cookie
    'Secure',            // Only send over HTTPS — never plain HTTP
    'SameSite=Strict',   // Don't send with cross-site requests (prevents CSRF attacks)
    'Max-Age=0',         // Expire immediately — this is what actually deletes the cookie
    'Path=/',            // Apply to the whole website (all paths under /)
  ].join('; ');          // Cookies use semicolons to separate their attributes

  // -- Subsection: Return the redirect response --
  // HTTP 302 means "temporarily moved to another URL". The browser
  // will follow the Location header and navigate to /login.
  // The Set-Cookie header in this response is what erases the cookie
  // before the browser even reaches the login page.
  return new Response(null, {
    status: 302,
    headers: {
      'Set-Cookie': clearCookie,
      'Location':   '/login',  // Send the user to the login page
    },
  });
}

/* ============================================================
   onRequestGet — rejects GET requests to /api/logout
   ============================================================
   Logout must only be triggered by a deliberate POST (e.g. a
   button click), not by simply visiting a URL. If someone tries
   a GET request (e.g. by typing /api/logout in the address bar),
   we return a 405 "Method Not Allowed" error.
   ============================================================ */
export async function onRequestGet() {
  // Return a JSON error message. 405 means "this HTTP method is not
  // allowed on this URL".
  return new Response(JSON.stringify({ error: 'Method not allowed.' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json' },
  });
}
