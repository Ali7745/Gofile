// Gopeed Extension: Google Drive Direct Download (robust)
// Resolves Google Drive share links into a short-lived direct download URL (googleusercontent)
// by following redirects, handling confirm tokens, and preserving cookies during resolution.
//
// Note: The final googleusercontent URL is usually time-limited; that's OK for immediate downloads in Gopeed.

function extractFileId(inputUrl) {
  const url = new URL(inputUrl);
  let fileId = "";

  if (url.hostname === "drive.google.com") {
    // https://drive.google.com/file/d/<ID>/view
    if (url.pathname.startsWith("/file/d/")) {
      const parts = url.pathname.split("/");
      fileId = parts[3] || "";
    }
    // https://drive.google.com/uc?id=<ID>&export=download
    if (!fileId && url.searchParams.has("id")) {
      fileId = url.searchParams.get("id") || "";
    }
    // https://drive.google.com/open?id=<ID>
    if (!fileId && url.pathname === "/open" && url.searchParams.has("id")) {
      fileId = url.searchParams.get("id") || "";
    }
  }

  if (!fileId && url.hostname === "drive.usercontent.google.com") {
    fileId = url.searchParams.get("id") || "";
  }

  return fileId;
}

function parseSetCookie(setCookieHeader) {
  // Very small cookie jar: parse "name=value; ..." and keep name=value
  if (!setCookieHeader) return [];
  // Some runtimes return multiple cookies in one string separated by comma,
  // but commas can appear in Expires. We'll split conservatively.
  // Try to split on ", " only when it looks like a new cookie starts.
  const parts = setCookieHeader.split(/,\s*(?=[^;=]+=[^;]+)/g);
  const cookies = [];
  for (const p of parts) {
    const nv = p.split(";")[0].trim();
    if (nv.includes("=")) cookies.push(nv);
  }
  return cookies;
}

function mergeCookies(existing, incoming) {
  // Keep last value per cookie name
  const map = new Map();
  for (const c of existing) {
    const i = c.indexOf("=");
    map.set(c.slice(0, i), c);
  }
  for (const c of incoming) {
    const i = c.indexOf("=");
    map.set(c.slice(0, i), c);
  }
  return Array.from(map.values());
}

function findConfirmToken(html) {
  if (!html) return "";
  // Common patterns
  // 1) ...confirm=XXXX&id=...
  let m = html.match(/confirm=([0-9A-Za-z_-]+)/);
  if (m) return m[1];

  // 2) Escaped in JSON/JS
  m = html.match(/confirm\\u003d([0-9A-Za-z_-]+)/);
  if (m) return m[1];

  // 3) downloadUrl":"https:\/\/drive.usercontent.google.com\/download?...confirm=XXXX...
  m = html.match(/downloadUrl"\s*:\s*"[^"]*confirm=([0-9A-Za-z_-]+)/);
  if (m) return m[1];

  return "";
}

async function fetchWithRedirects(startUrl, headers = {}, maxHops = 10) {
  let url = startUrl;
  let cookies = [];
  let lastResp = null;

  for (let hop = 0; hop < maxHops; hop++) {
    const reqHeaders = { ...headers };
    if (cookies.length) reqHeaders["cookie"] = cookies.join("; ");

    // Use manual redirects so we can capture the final URL and keep cookies.
    const resp = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: reqHeaders,
    });

    lastResp = resp;

    const setCookie = resp.headers.get("set-cookie");
    if (setCookie) {
      cookies = mergeCookies(cookies, parseSetCookie(setCookie));
    }

    const loc = resp.headers.get("location");
    const status = resp.status;

    // 3xx redirect
    if (status >= 300 && status < 400 && loc) {
      url = new URL(loc, url).toString();
      continue;
    }

    // Not a redirect — return response + current URL + cookies
    return { resp, url, cookies };
  }

  return { resp: lastResp, url, cookies };
}

async function resolveGoogleDriveDirect(fileId) {
  // Prefer drive.usercontent first; it often leads to direct redirect.
  const base1 = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download`;
  const base2 = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

  const commonHeaders = {
    // Some servers behave better with a UA; Gopeed runtime may set one already.
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  // Try 1: follow redirects; if we end on googleusercontent, we're done.
  let { resp, url, cookies } = await fetchWithRedirects(base1, commonHeaders, 10);
  if (url.includes("googleusercontent.com") && (resp?.status || 0) >= 200) {
    return { directUrl: url };
  }

  // If HTML page, try to find confirm token then retry with confirm
  let body = "";
  try {
    const ct = resp?.headers?.get("content-type") || "";
    if (ct.includes("text/html") || ct.includes("application/xhtml+xml")) {
      body = await resp.text();
    }
  } catch (_) {}

  let token = findConfirmToken(body);

  // Also try cookie-based token (download_warning)
  if (!token && cookies.length) {
    for (const c of cookies) {
      const name = c.split("=")[0];
      if (name.startsWith("download_warning")) {
        token = c.split("=").slice(1).join("="); // value
        break;
      }
    }
  }

  if (token) {
    const urlWithConfirm1 = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&confirm=${encodeURIComponent(token)}`;
    ({ resp, url } = await fetchWithRedirects(urlWithConfirm1, commonHeaders, 10));
    if (url.includes("googleusercontent.com")) return { directUrl: url };

    const urlWithConfirm2 = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}&confirm=${encodeURIComponent(token)}`;
    ({ resp, url } = await fetchWithRedirects(urlWithConfirm2, commonHeaders, 10));
    if (url.includes("googleusercontent.com")) return { directUrl: url };
  }

  // Fallback: return a best-effort download URL (Gopeed may still handle it)
  return { directUrl: base2 };
}

function guessNameFromCtx(ctx, fileId) {
  // If user passed a "name" query param in referrer (some share links include it)
  try {
    if (ctx.req?.headers?.Referer) {
      const r = new URL(ctx.req.headers.Referer);
      const n = r.searchParams.get("name");
      if (n) return n;
    }
  } catch (_) {}
  return `gdrive_${fileId}`;
}

gopeed.events.onResolve(async (ctx) => {
  try {
    const fileId = extractFileId(ctx.req.url);
    if (!fileId) return;

    const { directUrl } = await resolveGoogleDriveDirect(fileId);
    const fileName = guessNameFromCtx(ctx, fileId);

    ctx.res = {
      name: fileName,
      files: [
        {
          name: fileName,
          req: { url: directUrl },
        },
      ],
    };
  } catch (e) {
    // If anything goes wrong, let Gopeed handle the original URL as-is.
    return;
  }
});
