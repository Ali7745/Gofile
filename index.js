// Gopeed Extension: GoFile FULL Resolver (FINAL)

function extractContentId(url) {
  const m = url.match(/gofile\.io\/d\/([^/?#]+)/i);
  return m ? m[1] : null;
}

async function api(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const url = `https://api.gofile.io/${path}${q ? "?" + q : ""}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  });
  if (!r.ok) throw new Error(`API ${path} HTTP ${r.status}`);
  return r.json();
}

gopeed.events.onResolve(async (ctx) => {
  const contentId = extractContentId(ctx.req.url);
  if (!contentId) throw new Error("Invalid GoFile URL");

  // 1️⃣ getContent
  const meta = await api("getContent", { contentId });

  if (meta.status !== "ok") {
    throw new Error("GoFile getContent failed");
  }

  const contents = Object.values(meta.data.contents || {});
  const files = contents.filter(it => it.type === "file");

  if (!files.length) {
    throw new Error("No files found in GoFile folder");
  }

  const out = [];

  for (const f of files) {
    // 2️⃣ generateDownloadLink (THIS IS THE KEY)
    const dl = await api("generateDownloadLink", {
      fileId: f.id
    });

    if (dl.status !== "ok") continue;

    out.push({
      name: f.name,
      req: {
        url: dl.data.downloadUrl,
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      }
    });
  }

  if (!out.length) {
    throw new Error("Failed to generate direct download links");
  }

  ctx.res = {
    name: out.length === 1 ? out[0].name : `gofile_${contentId}`,
    files: out
  };
});
