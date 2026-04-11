/* ============================================================
   Cloudflare Pages Middleware — Session Authentication Guard
   ============================================================
   This file is special: in Cloudflare Pages, any file named
   "_middleware.js" automatically runs BEFORE every page or
   function on the same level or deeper. Think of it as the
   security guard at the entrance — every single request to
   the website passes through this code first.

   WHAT DOES IT DO?
   It checks whether the visitor is logged in. If they are,
   it lets them through (calls next()). If they aren't, it
   redirects them to the /login page.

   HOW DOES IT CHECK IF SOMEONE IS LOGGED IN?
   When a user logs in via /api/login, the server sets a cookie
   (a tiny piece of data stored in the browser) called "sd_session".
   That cookie contains a signed token — a string with the user's
   info plus a cryptographic "seal" (HMAC signature) that proves
   it was created by our server and hasn't been tampered with.
   The middleware reads that cookie on every request and verifies
   the seal. If the seal is valid and the session hasn't expired,
   the user is let through.

   PUBLIC ROUTES (no login required):
     GET  /login       — the login page itself
     POST /api/login   — the login form submission endpoint
   Everything else requires a valid session.

   Environment variables required (set in Cloudflare Pages dashboard):
     AUTH_SECRET — the secret key used to sign and verify tokens.
                   This MUST be the same secret used in login.js.
   ============================================================ */

// -- Subsection: Cookie name constant --
// The name of the session cookie we look for on every request.
// Must match the name used in login.js and logout.js.
const COOKIE_NAME = 'sd_session';

// -- Subsection: Public paths list --
// These paths are allowed through WITHOUT a valid session.
// We need /login and /api/login to be public, otherwise
// users can never get to the login page in the first place!
const PUBLIC_PATHS = ['/login', '/login.html', '/login.js', '/api/login'];

/* ============================================================
   CRYPTO HELPERS
   These two functions handle the cryptography involved in
   checking whether a session token is authentic. They use the
   Web Crypto API, which is a standard set of cryptographic
   tools available in all modern browsers and Cloudflare Workers.
   ============================================================ */

/* ============================================================
   importKey — converts a plain text secret into a usable crypto key
   ============================================================
   Parameters:
     secret — the AUTH_SECRET string from environment variables
   Returns:
     A CryptoKey object the Web Crypto API can use for HMAC operations.

   This is a required "preparation" step. The Web Crypto API won't
   accept a plain string directly — it needs the key in a special
   internal format first. This function does that conversion.
   ============================================================ */
async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',                                   // The key material is provided as raw bytes
    new TextEncoder().encode(secret),        // Convert the secret string to bytes
    { name: 'HMAC', hash: 'SHA-256' },       // Algorithm: HMAC using SHA-256 hashing
    false,                                   // Non-extractable — can't read the key back out
    ['sign', 'verify'],                      // This key can be used for both signing and verifying
  );
}

/* ============================================================
   verifyToken — checks whether a session token is valid
   ============================================================
   Parameters:
     token  — the session token string read from the cookie
              (format: "base64EncodedData.base64EncodedSignature")
     secret — the AUTH_SECRET used to verify the HMAC signature
   Returns:
     The payload object (e.g. { email: "...", exp: 1234567890 })
     if the token is valid and not expired.
     null if the token is invalid, tampered with, or expired.

   WHAT THIS FUNCTION CHECKS:
     1. That the token has the expected "data.signature" format.
     2. That the HMAC signature matches the data — meaning the token
        was genuinely created by our login.js using the same secret,
        and nobody has altered it since.
     3. That the token hasn't expired (we check the "exp" timestamp
        stored inside the token's payload).
   ============================================================ */
async function verifyToken(token, secret) {
  try {
    // -- Split the token into data and signature parts --
    // The token looks like "data.signature". We find the LAST dot
    // in case the base64-encoded data itself contains dots.
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null; // Malformed token — no dot found at all

    const data   = token.slice(0, dot);        // Everything before the last dot is the data
    const sigB64 = token.slice(dot + 1);       // Everything after the last dot is the signature

    // -- Import the secret as a verification key --
    const key = await importKey(secret);

    // -- Decode the base64 signature back to raw bytes --
    // atob() decodes a base64 string to a regular string.
    // We then convert each character to its numeric char code
    // to get the raw byte array.
    const sig = Uint8Array.from(atob(sigB64), c => c.charCodeAt(0));

    // -- Verify the HMAC signature --
    // This checks: "was this 'data' string really signed using our secret?"
    // If anyone altered the data or created a fake token without the
    // secret, this returns false.
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data));
    if (!valid) return null; // Signature doesn't match — token is fake or tampered

    // -- Decode and parse the payload --
    // The data part is base64-encoded JSON. atob() decodes the base64,
    // JSON.parse() turns the JSON string back into an object.
    const payload = JSON.parse(atob(data));

    // -- Check expiry --
    // payload.exp is a Unix timestamp (seconds since Jan 1 1970).
    // Date.now() returns milliseconds, so we divide by 1000.
    // If the expiry time is in the past, the session has expired.
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    // Token is valid and not expired — return the payload data.
    return payload;
  } catch {
    // If anything unexpected goes wrong (e.g. invalid base64,
    // malformed JSON), treat the token as invalid.
    return null;
  }
}

/* ============================================================
   parseCookies — extracts all cookies from a Cookie header string
   ============================================================
   Parameters:
     header — the raw value of the "Cookie" HTTP header, which looks
              like: "name1=value1; name2=value2; name3=value3"
   Returns:
     A plain object where each key is a cookie name and each
     value is the corresponding cookie value.
     e.g. { name1: "value1", name2: "value2", name3: "value3" }

   WHY DO WE NEED THIS?
   HTTP requests include all cookies as a single string in the
   "Cookie" header. There's no built-in JavaScript function that
   parses this into a usable object (unlike document.cookie in
   browsers, which has some helpers). So we split it ourselves.
   ============================================================ */
function parseCookies(header) {
  const cookies = {};
  // Split the header by semicolons to get individual "name=value" pairs.
  for (const part of (header || '').split(';')) {
    // Find the first equals sign — that separates name from value.
    const idx = part.indexOf('=');
    if (idx === -1) continue; // Skip malformed entries with no equals sign
    // .trim() removes any leading/trailing whitespace from the name.
    cookies[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return cookies;
}

/* ============================================================
   onRequest — the middleware entry point
   ============================================================
   Cloudflare calls this function automatically for EVERY incoming
   request to the website. It runs before any page or API function.

   Parameters:
     context — an object Cloudflare provides containing:
       context.request — the incoming HTTP request
       context.env     — environment variables (secrets from dashboard)
       context.next    — a function to call if we want to let the
                         request continue to its destination
   Returns:
     Either:
       - The result of next() — i.e. the actual page/function response
         (when the user is allowed through).
       - A redirect Response to /login (when the user is not logged in).
       - A 503 error Response (if AUTH_SECRET isn't configured).
   ============================================================ */
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url); // Parse the URL so we can read the path

  // -- Subsection: Allow public paths through without checking --
  // If the request is for /login or /api/login, we skip authentication
  // entirely. Otherwise users could never reach the login page!
  // .some() returns true if ANY item in the array satisfies the condition.
  // We check both exact match (url.pathname === p) and sub-paths
  // (url.pathname.startsWith(p + '/')) for flexibility.
  if (PUBLIC_PATHS.some(p => url.pathname === p || url.pathname.startsWith(p + '/'))) {
    return next(); // Let the request through as-is
  }

  // -- Subsection: Get the signing secret --
  const secret = env.AUTH_SECRET;

  // If AUTH_SECRET isn't configured, block access entirely to avoid exposing data.
  // It would be dangerous to allow access with no way to verify tokens.
  // 503 means "Service Unavailable".
  if (!secret) {
    return new Response('Authentication not configured. Set AUTH_SECRET in Cloudflare Pages environment variables.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // -- Subsection: Read and verify the session cookie --
  // The "Cookie" header contains all cookies the browser is sending.
  const cookies = parseCookies(request.headers.get('Cookie'));

  // Look for our specific session cookie by name.
  const token   = cookies[COOKIE_NAME];

  if (token) {
    // We have a token — verify it's genuine and not expired.
    const payload = await verifyToken(token, secret);
    if (payload) {
      return next(); // Valid session — allow request to continue
    }
    // If payload is null, the token was invalid or expired.
    // We fall through to the redirect below.
  }

  // -- Subsection: Redirect to login --
  // No valid session found. Build a login URL and include the
  // path the user was trying to reach as a "?next=" parameter,
  // so after they log in they can be sent back to where they wanted to go.
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', url.pathname); // e.g. ?next=/dashboard
  return Response.redirect(loginUrl.toString(), 302); // 302 = temporary redirect
}
