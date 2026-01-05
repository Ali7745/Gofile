function extractFileId(url) {
  // 1) uc?id=FILEID
  let m = url.match(/[?&]id=([^&]+)/i);
  if (m) return decodeURIComponent(m[1]);

  // 2) /file/d/FILEID/
  m = url.match(/\/file\/d\/([^/]+)/i);
  if (m) return m[1];

  // 3) open?id=FILEID
  m = url.match(/\/open\?id=([^&]+)/i);
  if (m) return decodeURIComponent(m[1]);

  return null;
}

function pickConfirmToken(html) {
  // Google Drive large file confirm token patterns
  // 1) confirm=XXXX in download link
  let m = html.match(/confirm=([0-9A-Za-z_]+)&amp;id=/);
  if (m) return m[1];

  m = html.match(/confirm=([0-9A-Za-z_]+)&id=/);
  if (m) return m[1];

  // 2) Sometimes "download_warning" cookie is set; but token still in page
  return null;
}

function pickFilenameFromHeaders(headers) {
  const cd = headers.get("content-disposition") || "";
  // content-disposition: attachment; filename="..."
  let m = cd.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1].replace(/"/g, "").trim());
  } catch {
    return m[1].replace(/"/g, "").trim();
  }
}

gopeed.events.onResolve(async (ctx) => {
  const inUrl = ctx.req.url;
  const fileId = extractFileId(inUrl);

  if (!fileId) {
    throw new Error("Google Drive: cannot extract file id");
  }

  const base = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

  // 1) First request (may return file directly or a confirm page)
  const r1 = await fetch(base, {
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  // If Google responds with redirect to direct download
  const loc1 = r1.headers.get("location");
  if (loc1) {
    ctx.res = {
      name: `gdrive_${fileId}`,
      files: [{ name: `gdrive_${fileId}`, req: { url: loc1, headers: { "User-Agent": "Mozilla/5.0" } } }]
    };
    return;
  }

  const ct1 = r1.headers.get("content-type") || "";

  // If it's already the file (not HTML)
  if (!ct1.includes("text/html")) {
    const filename = pickFilenameFromHeaders(r1.headers) || `gdrive_${fileId}`;
    ctx.res = {
      name: filename,
      files: [{ name: filename, req: { url: base, headers: { "User-Agent": "Mozilla/5.0" } } }]
    };
    return;
  }

  // 2) HTML confirm page: extract confirm token
  const html = await r1.text();
  const confirm = pickConfirmToken(html);

  if (!confirm) {
    // Could be permission/login/blocked
    throw new Error(
      "Google Drive: confirm token not found. The file may require permission/login, or Google blocked automated download."
    );
  }

  const finalUrl = `https://drive.google.com/uc?export=download&confirm=${encodeURIComponent(confirm)}&id=${encodeURIComponent(fileId)}`;

  // 3) Return final URL to Gopeed (Google will then stream the file)
  ctx.res = {
    name: `gdrive_${fileId}`,
    files: [
      {
        name: `gdrive_${fileId}`,
        req: {
          url: finalUrl,
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Referer": "https://drive.google.com/"
          }
        }
      }
    ]
  };
});
