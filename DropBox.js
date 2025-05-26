// --- START OF FILE worker.js (Dropbox Indexer) ---

// Set these as Secrets in your Worker Environment Variables:
// DROPBOX_ACCESS_TOKEN: Your Dropbox Access Token

const ROOT_DROPBOX_PATH = ""; // e.g., "" for root, or "/MyFiles" for a specific folder

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event.env));
});

async function handleRequest(request, env) {
  const DROPBOX_ACCESS_TOKEN = env.DROPBOX_ACCESS_TOKEN;
  if (!DROPBOX_ACCESS_TOKEN) {
    return new Response("Dropbox Access Token not configured.", { status: 500 });
  }

  const url = new URL(request.url);
  let pathname = url.pathname;

  if (pathname !== '/' && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  if (!pathname.startsWith('/')) {
    pathname = '/' + pathname;
  }

  const requestedPathInDropbox = (ROOT_DROPBOX_PATH + pathname).replace(/\/+/g, '/'); // Normalize slashes

  async function callDropboxApi(endpoint, bodyPayload, accessToken, contentDownload = false) {
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
    if (contentDownload) { // For /files/download endpoint which returns file content
        headers['Dropbox-API-Arg'] = JSON.stringify(bodyPayload);
        delete headers['Content-Type']; // Dropbox-API-Arg replaces body for GET-style download
    }

    const response = await fetch(`https://content.dropboxapi.com/2/${endpoint}`, { // Use content server for downloads
      method: contentDownload ? 'POST' : 'POST', // Download is POST even if it acts like GET
      headers: headers,
      body: contentDownload ? null : JSON.stringify(bodyPayload)
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = { error_summary: `HTTP ${response.status} - ${response.statusText}` };
      }
      console.error(`Dropbox API Error (${endpoint}):`, errorData);
      throw new Error(errorData.error_summary || `Failed API call to ${endpoint}`);
    }
    if (contentDownload) return response; // Return the raw response for file streams
    return response.json();
  }


  try {
    // Attempt to get metadata for the path to see if it's a file
    let itemMetadata;
    let isFile = false;
    try {
      itemMetadata = await callDropboxApi('files/get_metadata', {
        path: requestedPathInDropbox === '/' ? '' : requestedPathInDropbox,
        include_media_info: false,
        include_deleted: false,
        include_has_explicit_shared_members: false
      }, DROPBOX_ACCESS_TOKEN);
      if (itemMetadata && itemMetadata['.tag'] === 'file') {
        isFile = true;
      }
    } catch (e) {
      // If get_metadata fails, it might be a folder or non-existent. We'll try listing it as a folder.
      // A 409 error with path/not_found/.. is expected for folders.
      if (!e.message || !e.message.includes("path/not_found") && !e.message.includes("path/is_folder")) {
          // If it's not a "not_found" or "is_folder" error for a file path, then it's a real error
          if (!e.message || (!e.message.includes("path/is_folder") && requestedPathInDropbox !== (ROOT_DROPBOX_PATH || "/"))) {
             // If it's not a "is_folder" error for a file path, then it's a real error
            // console.warn(`Metadata check for ${requestedPathInDropbox} failed, but might be a folder. Error: ${e.message}`);
          }
      }
    }

    if (isFile) {
      const tempLinkData = await callDropboxApi('files/get_temporary_link', {
        path: itemMetadata.path_display
      }, DROPBOX_ACCESS_TOKEN);
      return Response.redirect(tempLinkData.link, 302);
    } else {
      // Assume it's a folder and try to list its contents
      const folderContents = await callDropboxApi('files/list_folder', {
        path: requestedPathInDropbox === '/' ? '' : requestedPathInDropbox,
        recursive: false,
        include_media_info: false,
        include_deleted: false,
        include_has_explicit_shared_members: false
      }, DROPBOX_ACCESS_TOKEN);

      let htmlContent = `<h1>Index of ${pathname}</h1><ul class="file-list">`;
      if (pathname !== '/') {
        const parentPath = pathname.substring(0, pathname.lastIndexOf('/')) || '/';
        htmlContent += `<li class="folder-item"><a href="${parentPath}">📁 ../</a></li>`;
      }

      folderContents.entries.sort((a, b) => {
        if (a['.tag'] === b['.tag']) return a.name.localeCompare(b.name);
        return a['.tag'] === 'folder' ? -1 : 1; // Folders first
      }).forEach(item => {
        const itemUrlPath = `${pathname === '/' ? '' : pathname}/${encodeURIComponent(item.name)}`;
        if (item['.tag'] === 'folder') {
          htmlContent += `<li class="folder-item"><a href="${itemUrlPath}">📁 ${item.name}/</a></li>`;
        } else {
          const fileSize = item.size ? formatBytes(item.size) : '';
          htmlContent += `<li class="file-item"><a href="${itemUrlPath}">📄 ${item.name}</a> <span class="file-size">(${fileSize})</span></li>`;
        }
      });
      htmlContent += `</ul>`;
      if (folderContents.has_more) {
          htmlContent += `<p><em>Note: More items exist in this folder but are not shown (pagination not implemented).</em></p>`;
      }
      return new Response(generateFullHtml(pathname, htmlContent), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  } catch (error) {
    console.error("Request handling error:", error);
    const errorHtml = generateFullHtml("Error", `<h1>An Error Occurred</h1><p>Path: ${requestedPathInDropbox}<br/>Message: ${error.message}</p>`);
    return new Response(errorHtml, { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function generateFullHtml(title, bodyContent) {
  // Same as the 1fichier example's generateFullHtml function
  return `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dropbox Index: ${title}</title><style>body{font-family:sans-serif;margin:20px;background-color:#f4f4f4;color:#333}.container{max-width:800px;margin:0 auto;background-color:#fff;padding:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}h1{border-bottom:2px solid #eee;padding-bottom:10px;margin-top:0}ul.file-list{list-style:none;padding:0}ul.file-list li{padding:8px 0;border-bottom:1px solid #eee}ul.file-list li:last-child{border-bottom:none}ul.file-list a{text-decoration:none;color:#007bff;font-weight:500}ul.file-list a:hover{text-decoration:underline}.file-size{color:#666;font-size:0.9em;margin-left:10px}.folder-item a::before{content:"📁 "}.file-item a::before{content:"📄 "}</style></head>
<body><div class="container">${bodyContent}</div></body></html>`;
}
// --- END OF FILE worker.js (Dropbox Indexer) ---
