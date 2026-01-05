// Gopeed Extension: Google Drive Direct + Cookie Helper (Android-friendly)
// - Follows the "Download anyway" flow by extracting confirm token.
// - Collects Set-Cookie values during resolution.
// - Attaches Cookie header to the final download request (helps on Android).
// - Displays the required cookie in the task name so you can copy it easily.
//
// Runtime: Gopeed uses goja (no browser/node APIs). fetch/XMLHttpRequest are available.
// Docs: https://docs.gopeed.com/dev-extension.html

function extractFileId(inputUrl) {
  const url = new URL(inputUrl);
  let fileId = "";

  if (url.hostname === "drive.google.com") {
    if (url.pathname.startsWith("/file/d/")) {
      const parts = url.pathname.split("/");
      fileId = parts[3] || "";
    } else if (url.searchParams.has("id")) {
      fileId = url.searchParams.get("id") || "";
    } else if (url.pathname === "/open" && url.searchParams.has("id")) {
      fileId = url.searchParams.get("id") || "";
    }
  }

  if (!fileId && url.hostname === "drive.usercontent.google.com") {
    fileId = url.searchParams.get("id") || "";
  }

  return fileId;
}

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch(e){ return v; }
}

function parseSetCookie(setCookieHeader) {
  // Returns [{name, value}]
  const cookies = [];
  if (!setCookieHeader) return cookies;

  // Some runtimes may return string or array-like joined by \n
  const parts = String(setCookieHeader).split(/\n+/).filter(Boolean);
  for (let p of parts) {
    const first = p.split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) {
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (name) cookies.push({ name, value });
    }
  }
  return cookies;
}

function mergeCookieJar(jar, newOnes) {
  for (const c of newOnes) {
    jar[c.name] = c.value;
  }
  return jar;
}

function cookieJarToHeader(jar) {
  const pairs = [];
  for (const k in jar) {
    if (Object.prototype.hasOwnProperty.call(jar, k)) {
      pairs.push(k + "=" + jar[k]);
    }
  }
  return pairs.join("; ");
}

function extractConfirmToken(html) {
  // Typical patterns include confirm=t or confirm=<token>
  // We'll search for confirm= in hrefs/forms
  const m = html.match(/confirm=([0-9A-Za-z\-_]+)/);
  return m ? m[1] : "";
}

function extractFileName(html) {
  // Try to find filename shown on the warning page
  // We keep it best-effort; Gopeed may still resolve from headers.
  const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (m && m[1]) return m[1].trim();
  return "";
}

async function fetchWithJar(url, jar, ua) {
  const headers = {};
  const cookie = cookieJarToHeader(jar);
  if (cookie) headers["Cookie"] = cookie;
  if (ua) headers["User-Agent"] = ua;

  const resp = await fetch(url, { method: "GET", redirect: "manual", headers });
  const setCookie = resp.headers.get("set-cookie");
  if (setCookie) mergeCookieJar(jar, parseSetCookie(setCookie));

  return resp;
}

function joinCookies(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";
  // merge without duplicates by name best-effort
  const map = {};
  for (const part of (a + "; " + b).split(";")) {
    const s = part.trim();
    if (!s) continue;
    const eq = s.indexOf("=");
    if (eq > 0) map[s.slice(0, eq)] = s.slice(eq + 1);
  }
  const out = [];
  for (const k in map) out.push(k + "=" + map[k]);
  return out.join("; ");
}

gopeed.events.onResolve(async (ctx) => {
  try {
    const inputUrl = ctx.req.url;
    const fileId = extractFileId(inputUrl);

    if (!fileId) {
      ctx.res = { name: "Google Drive", files: [{ name: "unknown", req: { url: inputUrl } }] };
      return;
    }

    const ua = (gopeed.settings && gopeed.settings.user_agent) ? String(gopeed.settings.user_agent) : "";
    const extraCookie = (gopeed.settings && gopeed.settings.extra_cookie) ? String(gopeed.settings.extra_cookie).trim() : "";

    // We'll build a cookie jar from resolution requests
    const jar = {};

    // Step 1: hit the export=download endpoint
    const baseUrl = "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(fileId);
    let resp = await fetchWithJar(baseUrl, jar, ua);

    // If google responds with redirect (rare here), follow it manually
    let location = resp.headers.get("location");
    if (location && location.startsWith("/")) location = "https://drive.google.com" + location;

    // If response is 200 HTML, it may be the warning page, need confirm token
    let finalUrl = baseUrl;
    let cookieForUser = cookieJarToHeader(jar);

    if (resp.status === 200) {
      const ct = resp.headers.get("content-type") || "";
      if (ct.includes("text/html")) {
        const html = await resp.text();
        const token = extractConfirmToken(html);
        const guessedName = extractFileName(html);

        if (token) {
          finalUrl = baseUrl + "&confirm=" + encodeURIComponent(token);
          // Try again with confirm token to get redirect to googleusercontent
          resp = await fetchWithJar(finalUrl, jar, ua);

          location = resp.headers.get("location");
          if (location && location.startsWith("/")) location = "https://drive.google.com" + location;

          if (location) {
            // Some flows redirect to drive.usercontent.google.com
            // Follow once more to get final googleusercontent URL
            const resp2 = await fetchWithJar(location, jar, ua);
            let loc2 = resp2.headers.get("location");
            if (loc2 && loc2.startsWith("/")) loc2 = "https://drive.usercontent.google.com" + loc2;
            if (loc2) finalUrl = loc2;
            else finalUrl = location;
          }

          cookieForUser = cookieJarToHeader(jar);
          if (guessedName) ctx.req.name = guessedName; // best-effort
        }
      }
    } else if (resp.status >= 300 && resp.status < 400 && location) {
      // Redirect chain
      const resp2 = await fetchWithJar(location, jar, ua);
      let loc2 = resp2.headers.get("location");
      if (loc2 && loc2.startsWith("/")) loc2 = "https://drive.usercontent.google.com" + loc2;
      finalUrl = loc2 || location;
      cookieForUser = cookieJarToHeader(jar);
    }

    // Include any user-provided extra cookie
    const effectiveCookie = joinCookies(cookieForUser, extraCookie);

    // Make the cookie visible for copying (Android): put it in the task name and log it.
    const displayCookie = effectiveCookie ? effectiveCookie : "(no cookie captured)";
    gopeed.logger && gopeed.logger.info && gopeed.logger.info("GoogleDrive Cookie: " + displayCookie);

    // Build a human-ish file name
    let fileName = "gdrive_" + fileId;
    // Try to keep original filename from URL query if present
    try {
      const u = new URL(inputUrl);
      const n = u.searchParams.get("filename") || u.searchParams.get("name");
      if (n) fileName = safeDecode(n);
    } catch(e){}

    ctx.res = {
      name: fileName + " | Cookie: " + displayCookie,
      files: [
        {
          name: fileName,
          req: {
            url: finalUrl,
            headers: (effectiveCookie || ua) ? {
              ...(effectiveCookie ? { "Cookie": effectiveCookie } : {}),
              ...(ua ? { "User-Agent": ua } : {})
            } : undefined
          }
        }
      ]
    };
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    gopeed.logger && gopeed.logger.error && gopeed.logger.error("GoogleDrive resolve error: " + msg);
    ctx.res = { name: "Google Drive (error)", files: [{ name: "error", req: { url: ctx.req.url } }] };
  }
});
