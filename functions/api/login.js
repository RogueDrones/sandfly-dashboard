/* ============================================================
   Cloudflare Pages Function — POST /api/login
   ============================================================
   This file runs on Cloudflare's servers (not in the browser).
   It is called when the user submits the login form. It:
     1. Reads the submitted email and password.
     2. Compares them against the correct credentials stored
        in Cloudflare's secret environment variables.
     3. If they match, creates a signed session token and
        sends it back to the browser as a cookie.
     4. If they don't match, returns an error.

   WHAT IS A SESSION TOKEN?
   A session token is like a stamped wristband at an event. Once
   you've proven who you are (by entering the correct password),
   the server gives your browser a wristband. On every future
   request the browser shows that wristband (the cookie), and
   the server lets you in without you having to log in again.

   WHAT IS HMAC?
   HMAC stands for Hash-based Message Authentication Code. Think
   of it like a wax seal on a letter. The server creates the seal
   using a secret key. If anyone tampers with the token or tries
   to forge one, the seal won't match the secret key when the
   server checks it, and the fake token is rejected.

   Environment variables required (set in Cloudflare Pages dashboard):
     AUTH_EMAIL    — the one allowed email address
     AUTH_PASSWORD — the one allowed password
     AUTH_SECRET   — a long random string used as the HMAC signing key
   ============================================================ */

// -- Subsection: Constants --
// The name of the cookie that stores the session token. Must match
// the name used in _middleware.js and logout.js.
const COOKIE_NAME    = 'sd_session';

// How long (in seconds) a login session lasts before it expires.
// 7 * 24 * 60 * 60 = 604800 seconds = 7 days.
const SESSION_SECONDS = 7 * 24 * 60 * 60; // 7 days

/* ============================================================
   importHmacKey — prepares the signing key from a plain text secret
   ============================================================
   Parameters:
     secret  — the raw secret string (e.g. AUTH_SECRET from env vars)
     usages  — array of what we're allowed to do with the key,
               e.g. ['sign'] or ['verify']
   Returns:
     A CryptoKey object that the browser's built-in crypto API
     can use to sign or verify data with HMAC-SHA256.

   WHY THIS STEP?
   The Web Crypto API (the standard crypto library built into
   modern browsers and Cloudflare Workers) needs keys in a special
   format. We can't just pass a string directly — we have to
   "import" it into a CryptoKey first.
   ============================================================ */
async function importHmacKey(secret, usages) {
  return crypto.subtle.importKey(
    'raw',                                  // The key is provided as raw bytes
    new TextEncoder().encode(secret),       // Convert the secret string to bytes
    { name: 'HMAC', hash: 'SHA-256' },      // Use HMAC with SHA-256 as the hash function
    false,                                  // Non-extractable: the raw key cannot be read back out
    usages,                                 // What this key can do: 'sign', 'verify', or both
  );
}

/* ============================================================
   signToken — creates a signed session token from a payload object
   ============================================================
   Parameters:
     payload — a plain JavaScript object containing the session data,
               e.g. { email: "user@example.com", exp: 1234567890 }
     secret  — the AUTH_SECRET string used to sign the token
   Returns:
     A string in the format "base64EncodedData.base64EncodedSignature".
     This is similar to a simplified JWT (JSON Web Token).

   HOW IT WORKS:
     1. We JSON-encode the payload and then base64-encode that, giving
        us a URL-safe text representation of the data.
     2. We use the secret key to create an HMAC signature over that text.
     3. We base64-encode the signature and append it after a dot.
     The result looks like: "eyJlbWFpbCI6..."."{signature}"

   The signature is the wax seal. If anyone changes even one character
   of the data part, the signature will no longer match when we verify it.
   ============================================================ */
async function signToken(payload, secret) {
  // Convert the payload object to a base64 string. btoa() converts
  // a string to base64. JSON.stringify() turns the object into a JSON string.
  const data   = btoa(JSON.stringify(payload));

  // Import the secret as an HMAC signing key.
  const key    = await importHmacKey(secret, ['sign']);

  // Create the HMAC signature. The signature is calculated over the
  // base64-encoded data string (converted to bytes first).
  const sig    = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));

  // Convert the raw signature bytes into a base64 string so it can
  // be stored in a cookie (cookies can only contain text).
  // new Uint8Array(sig) gives us the signature as an array of numbers.
  // String.fromCharCode(...array) converts those numbers to characters.
  // btoa() then base64-encodes the result.
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

  // Join data and signature with a dot, e.g. "data.signature"
  return `${data}.${sigB64}`;
}

/* ============================================================
   safeEqual — compares two strings in a way that prevents
   "timing attacks"
   ============================================================
   Parameters:
     a             — the first string (e.g. the submitted password)
     b             — the second string (e.g. the correct password)
     signingSecret — a secret used internally to make the comparison safe
   Returns:
     true if the strings are identical, false otherwise.

   WHY NOT JUST USE a === b?
   Normally, the === operator in JavaScript compares characters
   one by one and stops as soon as it finds a mismatch. This means
   a wrong password that starts with the right letter takes VERY
   slightly longer to reject than one that starts with the wrong
   letter. A sophisticated attacker could time thousands of login
   attempts and use those tiny time differences to guess the password
   character by character. This is called a "timing attack".

   safeEqual prevents this by hashing both strings with HMAC and
   then comparing the hashes using XOR (^), which always takes
   exactly the same amount of time regardless of where the strings
   differ. If the final XOR result is 0, the hashes (and therefore
   the original strings) were identical.
   ============================================================ */
async function safeEqual(a, b, signingSecret) {
  // Import the secret as a signing key (for use in this comparison only).
  const key = await importHmacKey(signingSecret, ['sign']);
  const enc = new TextEncoder();

  // Hash both strings simultaneously using the same key.
  // Promise.all runs both operations at the same time and waits for both to finish.
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.sign('HMAC', key, enc.encode(a)),
    crypto.subtle.sign('HMAC', key, enc.encode(b)),
  ]);

  // Convert the raw hash bytes into typed arrays so we can compare them.
  const arrA = new Uint8Array(hashA);
  const arrB = new Uint8Array(hashB);

  // XOR every corresponding byte from hashA and hashB.
  // XOR (^) produces 0 if both bits are the same, 1 if they differ.
  // We OR (|=) all results together: if ANY byte differs, diff will be non-zero.
  let diff = 0;
  for (let i = 0; i < arrA.length; i++) diff |= arrA[i] ^ arrB[i];

  // diff === 0 only if every byte was identical, meaning the strings matched.
  return diff === 0;
}

/* ============================================================
   onRequestPost — main login handler (POST /api/login)
   ============================================================
   This is the function Cloudflare calls when a POST request
   arrives at /api/login. It is the only thing that can grant
   a user a session cookie.

   Parameters:
     context — provided by Cloudflare. Contains:
       context.request — the HTTP request object (has headers, body, etc.)
       context.env     — the environment variables from the Cloudflare dashboard
   Returns:
     A JSON response: { ok: true } on success (with a Set-Cookie header),
     or { error: "..." } with an appropriate HTTP error status on failure.
   ============================================================ */
export async function onRequestPost(context) {
  const { request, env } = context;

  // -- Subsection: Load credentials from environment variables --
  // These are set in the Cloudflare Pages dashboard, not in code,
  // so they're never exposed in the source files.
  const validEmail    = env.AUTH_EMAIL;
  const validPassword = env.AUTH_PASSWORD;
  const secret        = env.AUTH_SECRET;

  // If any of the required environment variables are missing,
  // refuse to proceed. 503 means "Service Unavailable" — the server
  // exists but isn't ready to handle the request properly.
  if (!validEmail || !validPassword || !secret) {
    return jsonResponse({ error: 'Server authentication not configured.' }, 503);
  }

  // -- Subsection: Parse the request body --
  // The login form sends the email and password as the "body" of the
  // POST request. It can arrive in two formats:
  //   1. JSON (application/json): { "email": "...", "password": "..." }
  //   2. Form-encoded (application/x-www-form-urlencoded): email=...&password=...
  // We check the Content-Type header to know which format to expect.
  let email = '', password = '';
  const ct = request.headers.get('Content-Type') || '';
  try {
    if (ct.includes('application/json')) {
      // The body is a JSON string — parse it directly.
      const body = await request.json();
      email    = body.email    ?? '';
      password = body.password ?? '';
    } else {
      // The body is form-encoded — use the formData() parser.
      const body = await request.formData();
      email    = body.get('email')    ?? '';
      password = body.get('password') ?? '';
    }
  } catch {
    // If parsing fails for any reason, return a 400 Bad Request.
    return jsonResponse({ error: 'Invalid request body.' }, 400);
  }

  // -- Subsection: Verify credentials using constant-time comparison --
  // We check BOTH email and password before deciding whether to reject,
  // so the response time doesn't reveal whether the email was right.
  const emailOk    = await safeEqual(email,    validEmail,    secret);
  const passwordOk = await safeEqual(password, validPassword, secret);

  if (!emailOk || !passwordOk) {
    // We use the same generic error for both "wrong email" and
    // "wrong password" — this prevents an attacker from figuring
    // out which part was incorrect (called "username enumeration").
    return jsonResponse({ error: 'Invalid email or password.' }, 401);
  }

  // -- Subsection: Build a signed session token --
  // The payload is the data we want to store in the token: the user's
  // email and when the session expires. exp is a Unix timestamp
  // (seconds since 1 January 1970). Date.now() gives milliseconds,
  // so we divide by 1000 to get seconds.
  const payload = {
    email,
    exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  };

  // signToken creates the "data.signature" string described above.
  const token = await signToken(payload, secret);

  // -- Subsection: Build the Set-Cookie header --
  // This tells the browser to store the token as a cookie named sd_session.
  // The browser will automatically include this cookie in every future
  // request to this website, which is how the middleware knows the
  // user is logged in.
  const cookie = [
    `${COOKIE_NAME}=${token}`, // The cookie name and value
    'HttpOnly',                // JavaScript in the browser CANNOT read this cookie.
                               // This protects against XSS attacks where malicious
                               // scripts try to steal session tokens.
    'Secure',                  // Only send this cookie over HTTPS, never plain HTTP.
    'SameSite=Strict',         // Only send with requests from this same website.
                               // Prevents CSRF — cross-site request forgery attacks
                               // where other websites try to make requests on your behalf.
    `Max-Age=${SESSION_SECONDS}`, // How long the browser should keep the cookie (7 days).
    'Path=/',                  // Send this cookie for ALL paths on this domain.
  ].join('; ');                // Cookie attributes are separated by semicolons.

  // Return success. The Set-Cookie header in the response makes the browser
  // store the session cookie, so the user is now "logged in".
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}

/* ============================================================
   onRequestGet — rejects GET requests to /api/login
   ============================================================
   The login endpoint should only ever receive POST requests
   (form submissions). A GET request to /api/login makes no
   sense and we reject it with 405 Method Not Allowed.
   ============================================================ */
// Only POST is valid for this endpoint
export async function onRequestGet() {
  return jsonResponse({ error: 'Method not allowed.' }, 405);
}

/* ============================================================
   jsonResponse — helper to create a JSON HTTP response
   ============================================================
   Parameters:
     body         — a JavaScript object to send back as JSON
     status       — the HTTP status code (200 = OK, 401 = Unauthorised, etc.)
     extraHeaders — optional extra response headers (e.g. Set-Cookie)
   Returns:
     A Response object Cloudflare can send back to the browser.

   This is just a convenience wrapper so we don't have to repeat
   JSON.stringify and the Content-Type header everywhere.
   ============================================================ */
function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    // The spread operator (...extraHeaders) merges any extra headers
    // (like Set-Cookie) into the headers object alongside Content-Type.
  });
}
