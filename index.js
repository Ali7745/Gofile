// Gopeed Extension: GoFile API Resolver (Fixed)
// يحوّل https://gofile.io/d/<contentId> إلى روابط تحميل مباشرة

function extractContentId(url) {
  // مثال: https://gofile.io/d/9WQCql  => 9WQCql
  const m = url.match(/gofile\.io\/d\/([^/?#]+)/i);
  return m ? m[1] : null;
}

function pickBestName(item) {
  // الاسم أحيانًا يكون name أو filename
  return item?.name || item?.filename || "downloaded_file";
}

gopeed.events.onResolve(async (ctx) => {
  const pageUrl = ctx.req.url;
  const contentId = extractContentId(pageUrl);

  if (!contentId) {
    throw new Error("GoFile: cannot parse contentId from URL");
  }

  // GoFile API (قد يتغير مستقبلاً، لكن هذا الشائع)
  const apiUrl = `https://api.gofile.io/getContent?contentId=${encodeURIComponent(contentId)}`;

  const r = await fetch(apiUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GoFile API HTTP ${r.status}: ${t.slice(0, 200)}`);
  }

  const data = await r.json();

  // بعض الردود تكون: { status: "ok", data: { contents: { ... } } }
  if (!data || data.status !== "ok" || !data.data) {
    throw new Error("GoFile API returned unexpected response");
  }

  const contents = data.data.contents || data.data.children || data.data.files || null;
  if (!contents) {
    throw new Error("GoFile: no contents found (maybe password/protected/deleted)");
  }

  // contents غالبًا Object: { "<fileId>": { ...file... }, "<folderId>": { ... } }
  const items = Array.isArray(contents) ? contents : Object.values(contents);

  // فلتر: خذ الملفات فقط
  const files = items.filter((it) => {
    // نوع الملف قد يكون "file" أو it.type === "file"
    if (it.type) return String(it.type).toLowerCase() === "file";
    // أو وجود الحجم/الرابط
    return !!(it.link || it.directLink || it.url);
  });

  if (!files.length) {
    // أحياناً المحتوى يكون مجلد وفيه children داخل folder
    // نحاول نجمع ملفات من أي folder داخلي بسيط
    const maybeFolders = items.filter((it) => String(it.type || "").toLowerCase() === "folder" && it.children);
    if (maybeFolders.length) {
      const nested = [];
      for (const f of maybeFolders) {
        const ch = Array.isArray(f.children) ? f.children : Object.values(f.children);
        nested.push(...ch);
      }
      const nestedFiles = nested.filter((it) => String(it.type || "").toLowerCase() === "file" || it.link || it.directLink || it.url);
      if (nestedFiles.length) {
        files.push(...nestedFiles);
      }
    }
  }

  if (!files.length) {
    throw new Error("GoFile: no downloadable files found (maybe needs password/login)");
  }

  const outFiles = files.map((it) => {
    const direct =
      it.directLink ||
      it.link ||   // كثير من الأحيان هذا يكون download page، لكن أحيانًا يكون direct
      it.url;

    if (!direct) return null;

    return {
      name: pickBestName(it),
      req: {
        url: direct,
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      }
    };
  }).filter(Boolean);

  if (!outFiles.length) {
    throw new Error("GoFile: could not extract direct links");
  }

  // اسم المهمة (لو ملف واحد خذ اسمه)
  const taskName = outFiles.length === 1 ? outFiles[0].name : `gofile_${contentId}`;

  ctx.res = {
    name: taskName,
    files: outFiles
  };
});
