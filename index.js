gopeed.events.onResolve((ctx) => {
  const url = new URL(ctx.req.url);
  let fileId = "";

  // Extract file ID from different URL formats
  if (url.hostname === "drive.google.com") {
    if (url.pathname.startsWith("/file/d/")) {
      fileId = url.pathname.split("/")[3];
    } else if (url.searchParams.has("id")) {
      fileId = url.searchParams.get("id");
    }
  } else if (url.hostname === "drive.usercontent.google.com") {
    fileId = url.searchParams.get("id");
  }

  if (!fileId) {
    return;
  }

  // Construct the direct download URL with confirm=t
  // This bypasses the virus scan warning for large files
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

  // Try to get the file name from the original URL if possible
  let fileName = "file"; // Default name
  if (ctx.req.headers && ctx.req.headers['Referer']) {
      const refererUrl = new URL(ctx.req.headers['Referer']);
      const nameParam = refererUrl.searchParams.get('name');
      if (nameParam) {
          fileName = nameParam;
      }
  }


  ctx.res = {
    name: fileName,
    files: [
      {
        name: fileName, // Gopeed will usually resolve the real name from headers
        req: {
          url: directUrl,
        },
      },
    ],
  };
});
