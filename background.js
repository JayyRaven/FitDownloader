// FitGirl FuckingFast Batch Downloader - background service worker (MV3)

// Default maximum number of FuckingFast links we will actively process at once
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 5;

const DEFAULT_SETTINGS = {
  concurrency: DEFAULT_MAX_CONCURRENT_DOWNLOADS
};

function swapProtocol(url) {
  if (url.startsWith("https://")) return url.replace("https://", "http://");
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

// In-memory sessions keyed by Chrome tab ID
// sessions[tabId] = { tabId, sourceUrl, hasStarted, items: [{ url, label, state, downloadId|null }] }
let sessions = {};
let sessionsLoaded = false;

// Map downloadId -> { tabId, index } into sessions[tabId].items
let downloadIdToKey = new Map();
let downloadMapLoaded = false;
const ACTIVE_ITEM_STATES = new Set(["queued", "starting", "downloading", "paused"]);

// Track configs for our initiated downloads
const pendingDownloadConfigsByUrl = new Map();
const downloadConfigsById = new Map();

// Intercept filename determination so only the first file prompts the user,
// and all subsequent files automatically save to the same location without asking.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let config = downloadConfigsById.get(item.id);
  if (!config && item.url) {
    config = pendingDownloadConfigsByUrl.get(item.url);
  }

  // Not our extension's download: do not interfere
  if (!config) {
    return;
  }

  if (item.id && config) {
    downloadConfigsById.set(item.id, config);
  }

  // First download in set: let Chrome's Save As prompt proceed
  if (config.isFirstInBatch) {
    if (config.filename) {
      suggest({
        filename: config.filename,
        conflictAction: "uniquify"
      });
    } else {
      suggest();
    }
    return;
  }

  // Subsequent downloads in set: route to target filename with conflictAction uniquify,
  // which suppresses the Save As prompt and saves into the same location.
  const targetName = config.filename || item.filename;
  suggest({
    filename: targetName,
    conflictAction: "uniquify"
  });
});

function clampConcurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CONCURRENT_DOWNLOADS;
  // Hard limit between 1 and 20 to avoid abuse
  return Math.max(1, Math.min(20, Math.round(n)));
}

async function getCurrentSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    concurrency: clampConcurrency(stored.concurrency)
  };
}

async function loadDownloadMap() {
  if (downloadMapLoaded) return;
  const stored = await chrome.storage.local.get("ffDownloadMap");
  if (stored.ffDownloadMap && typeof stored.ffDownloadMap === "object") {
    downloadIdToKey = new Map(
      Object.entries(stored.ffDownloadMap).map(([id, key]) => [
        Number(id),
        key
      ])
    );
  }
  downloadMapLoaded = true;
}

async function saveDownloadMap() {
  const obj = {};
  for (const [id, key] of downloadIdToKey.entries()) {
    obj[id] = key;
  }
  await chrome.storage.local.set({ ffDownloadMap: obj });
}

async function loadSessions() {
  if (sessionsLoaded) return;
  const stored = await chrome.storage.local.get("ffSessions");
  if (stored.ffSessions && typeof stored.ffSessions === "object") {
    sessions = stored.ffSessions;
  }
  sessionsLoaded = true;
}

async function saveSessions() {
  await chrome.storage.local.set({ ffSessions: sessions });
}

function normalizeLink(link) {
  if (!link || typeof link.url !== "string" || !link.url.length) return null;
  return {
    url: link.url,
    label: typeof link.label === "string" && link.label.length ? link.label : link.url
  };
}

function toQueuedItem(link) {
  return {
    url: link.url,
    label: link.label || link.url,
    state: "queued",
    downloadId: null
  };
}

function normalizeSessionItem(item) {
  const link = normalizeLink(item);
  if (!link) return null;
  return {
    url: link.url,
    label: link.label,
    state: item && typeof item.state === "string" ? item.state : "queued",
    downloadId: item && Number.isInteger(item.downloadId) ? item.downloadId : null,
    error: item && typeof item.error === "string" ? item.error : null
  };
}

function normalizeSessionShape(session) {
  if (!session || typeof session !== "object") {
    return {
      tabId: null,
      sourceUrl: "",
      title: "",
      hasStarted: false,
      paused: false,
      generation: 0,
      firstDownloadPrompted: false,
      firstDownloadDetermined: false,
      subfolder: "",
      allItems: [],
      items: []
    };
  }

  const normalizedItems = Array.isArray(session.items)
    ? session.items.map(normalizeSessionItem).filter(Boolean)
    : [];

  const rawAllItems = Array.isArray(session.allItems) ? session.allItems : [];
  const normalizedAllItems = rawAllItems.map(normalizeLink).filter(Boolean);
  const allItems =
    normalizedAllItems.length > 0
      ? normalizedAllItems
      : normalizedItems.map((item) => ({ url: item.url, label: item.label }));

  return {
    ...session,
    sourceUrl: typeof session.sourceUrl === "string" ? session.sourceUrl : "",
    title: typeof session.title === "string" ? session.title : "",
    hasStarted: session.hasStarted === true,
    paused: session.paused === true,
    generation: Number.isInteger(session.generation) ? session.generation : 0,
    firstDownloadPrompted: session.firstDownloadPrompted === true,
    firstDownloadDetermined: session.firstDownloadDetermined === true,
    subfolder: typeof session.subfolder === "string" ? session.subfolder : "",
    allItems,
    items: normalizedItems
  };
}

function getSessionGeneration(session) {
  return Number.isInteger(session?.generation) ? session.generation : 0;
}

function hasActiveItems(session) {
  if (!session || session.hasStarted !== true || !Array.isArray(session.items)) {
    return false;
  }
  return session.items.some((item) => ACTIVE_ITEM_STATES.has(item.state));
}

function normalizeSessionUrl(url) {
  if (typeof url !== "string" || !url.length) return "";

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch (e) {
    return url.split("#")[0];
  }
}

function shouldReuseSessionForTab(session, tab) {
  if (!session) return false;

  const activeRun = hasActiveItems(session);
  const samePage =
    normalizeSessionUrl(session.sourceUrl) === normalizeSessionUrl(tab?.url);

  // If there are downloads currently in progress (downloading or queued), keep the active run
  if (activeRun) {
    return true;
  }

  // If downloads are NOT active:
  // If the batch was started (or finished), or if items were filtered down to a subset,
  // do NOT reuse that shrunk session. Force a fresh link scan!
  if (session.hasStarted) {
    return false;
  }

  if (Array.isArray(session.allItems) && Array.isArray(session.items) && session.items.length < session.allItems.length) {
    return false;
  }

  // Pre-start state can be reused on the same page only if it hasn't started yet and has all items
  return samePage;
}

function isSessionGenerationCurrent(tabId, generation) {
  const session = sessions[tabId];
  if (!session) return false;
  return getSessionGeneration(session) === generation;
}

function getSessionItemForRun(tabId, index, generation) {
  if (!isSessionGenerationCurrent(tabId, generation)) return null;
  const session = sessions[tabId];
  if (!session || !Array.isArray(session.items) || !session.items[index]) {
    return null;
  }
  return session.items[index];
}

function createSessionFromExtractedLinks(tab, title, links, generation) {
  const allItems = Array.isArray(links) ? links.map(normalizeLink).filter(Boolean) : [];
  return normalizeSessionShape({
    tabId: tab.id,
    sourceUrl: tab.url,
    title: title || "",
    hasStarted: false,
    paused: false,
    generation,
    allItems,
    items: allItems.map(toQueuedItem)
  });
}

function searchDownloadById(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (results) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(Array.isArray(results) && results.length ? results[0] : null);
    });
  });
}

async function reconcileSessionForTab(tabId) {
  await loadSessions();
  await loadDownloadMap();

  const existing = sessions[tabId];
  if (!existing) return;

  const session = normalizeSessionShape(existing);
  let sessionsChanged = false;
  let mapChanged = false;

  for (let i = 0; i < session.items.length; i++) {
    const item = session.items[i];

    if (item.downloadId == null) {
      if (item.state === "starting") {
        continue;
      }
      if (item.state === "downloading" || item.state === "paused") {
        item.state = "error";
        sessionsChanged = true;
      }
      continue;
    }

    const downloadId = item.downloadId;
    const download = await searchDownloadById(downloadId);

    if (!download) {
      downloadIdToKey.delete(downloadId);
      mapChanged = true;
      item.downloadId = null;
      if (ACTIVE_ITEM_STATES.has(item.state)) {
        item.state = "cancelled";
      }
      sessionsChanged = true;
      continue;
    }

    if (download.state === "complete") {
      downloadIdToKey.delete(downloadId);
      mapChanged = true;
      item.downloadId = null;
      item.state = "completed";
      sessionsChanged = true;
      continue;
    }

    if (download.state === "interrupted") {
      downloadIdToKey.delete(downloadId);
      mapChanged = true;
      item.downloadId = null;
      item.state = download.error === "USER_CANCELED" ? "cancelled" : "error";
      sessionsChanged = true;
      continue;
    }

    const nextState = download.paused ? "paused" : "downloading";
    if (item.state !== nextState) {
      item.state = nextState;
      sessionsChanged = true;
    }

    const existingKey = downloadIdToKey.get(downloadId);
    const generation = getSessionGeneration(session);
    if (
      !existingKey ||
      existingKey.tabId !== tabId ||
      existingKey.index !== i ||
      existingKey.generation !== generation
    ) {
      downloadIdToKey.set(downloadId, { tabId, index: i, generation });
      mapChanged = true;
    }
  }

  if (session.hasStarted && !hasActiveItems(session)) {
    session.hasStarted = false;
    session.paused = false;
    sessionsChanged = true;
  }

  if (sessionsChanged) {
    sessions[tabId] = session;
    broadcastSessionUpdate(tabId);
  }

  if (sessionsChanged || mapChanged) {
    await Promise.all([
      sessionsChanged ? saveSessions() : Promise.resolve(),
      mapChanged ? saveDownloadMap() : Promise.resolve()
    ]);
  }
}

async function rebuildSessionForTab(tab, generation) {
  const { title, items } = await extractFuckingFastLinks(tab.id);
  const rebuilt = createSessionFromExtractedLinks(tab, title, items, generation);
  sessions[tab.id] = rebuilt;
  await saveSessions();
  return rebuilt;
}

function broadcastSessionUpdate(tabId) {
  // In MV3, sendMessage may reject with "Receiving end does not exist"
  // when no views (popup, etc.) are open. We explicitly ignore that.
  const session = sessions[tabId];
  if (!session) return;
  try {
    chrome.runtime.sendMessage({ type: "session_updated", tabId, session }, () => {
      // Accessing lastError clears it and prevents "Uncaught (in promise)" noise
      // when there is no receiver (e.g. popup closed).
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // Ignore synchronous errors as well (very rare)
  }
}

/**
 * Extract all FuckingFast links from the current FitGirl page.
 * Runs in the context of the page via chrome.scripting.executeScript.
 */
async function extractFuckingFastLinks(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const rawTitle = document.title || "";
      const title = rawTitle.replace(/ - FitGirl Repacks.*/i, "").trim();

      // Scan containers for FuckingFast links
      const containers = [
        document.querySelector(".entry-content"),
        document.querySelector(".post"),
        document.body
      ].filter(Boolean);

      const items = [];

      for (const container of containers) {
        const anchors = container.querySelectorAll(
          'a[href*="fuckingfast.co/"], a[href*="fuckingfast.net/"]'
        );
        anchors.forEach((a) => {
          if (a.href) {
            let anchorLabel = a.textContent.trim();
            if (!anchorLabel || anchorLabel === a.href) {
              if (a.href.includes("#")) {
                try {
                  anchorLabel = decodeURIComponent(a.href.split("#")[1]);
                } catch (e) {
                  anchorLabel = a.href.split("#")[1];
                }
              }
            }
            items.push({ url: a.href, label: anchorLabel || a.href });
          }
        });
        if (items.length > 0) {
          break;
        }
      }

      // De-duplicate by URL while preserving first label
      const seen = new Set();
      const unique = [];
      for (const item of items) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        unique.push(item);
      }

      // Always also scan entire document body text/HTML for any other FuckingFast links
      // (some repack pages format links inside accordions, tables, or plain text)
      const bodyText = document.documentElement ? document.documentElement.innerHTML : (document.body.innerText || "");
      const matches =
        bodyText.match(
          /https?:\/\/(?:[a-zA-Z0-9-]+\.)*fuckingfast\.(?:co|net)\/[^\s"'<>\\]+/g
        ) || [];
      for (const u of matches) {
        if (!seen.has(u)) {
          seen.add(u);
          let textLabel = u;
          if (u.includes("#")) {
            try {
              textLabel = decodeURIComponent(u.split("#")[1]);
            } catch (e) {
              textLabel = u.split("#")[1];
            }
          }
          unique.push({ url: u, label: textLabel });
        }
      }

      return { title, items: unique };
    }
  });

  if (result && Array.isArray(result.items)) {
    return { title: result.title || "", items: result.items };
  }

  return { title: "", items: [] };
}

function extractFuckingFastId(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  try {
    const parsed = new URL(rawUrl);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (!parts.length) return null;
    if (parts[parts.length - 1] === "go" && parts.length > 1) {
      return parts[parts.length - 2];
    }
    return parts[parts.length - 1];
  } catch (e) {
    const clean = rawUrl.split("#")[0].split("?")[0].replace(/\/+$/, "");
    return clean.split("/").pop() || null;
  }
}

function extractFilenameFromUrl(rawUrl, defaultLabel) {
  if (typeof rawUrl === "string" && rawUrl.includes("#")) {
    const hash = rawUrl.split("#")[1];
    if (hash) {
      try {
        const decoded = decodeURIComponent(hash).trim();
        if (decoded) return decoded;
      } catch (e) {
        return hash.trim();
      }
    }
  }
  if (typeof defaultLabel === "string" && defaultLabel.includes(".")) {
    return defaultLabel.trim();
  }
  return null;
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
    }

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      if (tab.status === "complete" && !resolved) {
        resolved = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function attemptDirectPost(origin, fileId, cleanUrl) {
  const goUrl = `${origin}/f/${fileId}/go`;
  const res = await fetch(goUrl, {
    method: "POST",
    headers: {
      "HX-Request": "true",
      "HX-Current-URL": cleanUrl,
      Referer: cleanUrl,
      "Cache-Control": "no-cache",
      Accept: "*/*"
    },
    credentials: "include",
    redirect: "follow"
  });

  if (res.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (res.status === 403) {
    throw new Error("CLOUDFLARE_BLOCKED");
  }

  const hx = res.headers.get("hx-redirect") || res.headers.get("hx-location");
  if (hx) {
    return new URL(hx, origin).href;
  }

  if (
    res.redirected &&
    res.url &&
    !res.url.includes("/f/") &&
    !res.url.endsWith("/go")
  ) {
    return res.url;
  }

  const loc = res.headers.get("location");
  if (loc) {
    return new URL(loc, origin).href;
  }

  if (res.ok) {
    const text = await res.text();
    const dlMatch = text.match(
      /https?:\/\/(?:[a-zA-Z0-9-]+\.)*fuckingfast\.[a-z]+\/dl\/[^\s"'<>\\]+/i
    );
    if (dlMatch) return dlMatch[0];
    const anyDlMatch = text.match(/https?:\/\/[^\s"'<>]+\/dl\/[^\s"'<>\\]+/i);
    if (anyDlMatch) return anyDlMatch[0];
  }

  throw new Error("No direct link returned from POST");
}

async function attemptGet(cleanUrl, origin) {
  const res = await fetch(cleanUrl, {
    credentials: "include",
    headers: {
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (res.status === 403) throw new Error("CLOUDFLARE_BLOCKED");
  if (res.status === 429) throw new Error("RATE_LIMITED");

  if (res.ok) {
    const html = await res.text();
    const match = html.match(
      /https?:\/\/(?:[a-zA-Z0-9-]+\.)*fuckingfast\.[a-z]+\/dl\/[^\s"'<>\\]+/i
    );
    if (match) return match[0];
  }
  throw new Error("Direct link not found in GET HTML");
}

async function resolveViaTab(cleanUrl, fileId, origin) {
  const tab = await chrome.tabs.create({ url: cleanUrl, active: false });
  try {
    await waitForTabComplete(tab.id, 15000);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: async (id) => {
        const start = Date.now();
        while (Date.now() - start < 12000) {
          const title = document.title || "";
          if (
            !title.includes("Just a moment") &&
            !document.querySelector("#challenge-running") &&
            !document.querySelector("#cf-challenge-running")
          ) {
            break;
          }
          await new Promise((r) => setTimeout(r, 600));
        }

        try {
          const res = await fetch(`/f/${id}/go`, {
            method: "POST",
            headers: {
              "HX-Request": "true",
              "HX-Current-URL": window.location.href,
              "Cache-Control": "no-cache"
            }
          });
          const hx =
            res.headers.get("hx-redirect") || res.headers.get("hx-location");
          if (hx) return new URL(hx, window.location.origin).href;
          if (res.redirected && res.url) return res.url;
          const body = await res.text();
          const match = body.match(/https?:\/\/[^\s"'<>]+\/dl\/[^\s"'<>\\]+/i);
          if (match) return match[0];
        } catch (e) {
          // continue
        }

        const dlAnchor = document.querySelector('a[href*="/dl/"]');
        if (dlAnchor && dlAnchor.href) return dlAnchor.href;

        return null;
      },
      args: [fileId]
    });

    if (result) return result;
    throw new Error("Could not extract download link via background tab");
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (e) {
      // ignore
    }
  }
}

/**
 * Given a FuckingFast landing URL, extract the underlying direct /dl/... URL
 * using HTMX POST, fallback GET, or background tab with Cloudflare bypass.
 */
async function getDirectDownloadUrl(fuckingFastUrl) {
  const fileId = extractFuckingFastId(fuckingFastUrl);
  if (!fileId) {
    throw new Error("Invalid FuckingFast URL: " + fuckingFastUrl);
  }

  let origin = "https://fuckingfast.co";
  try {
    const u = new URL(fuckingFastUrl);
    origin = u.origin;
  } catch (e) {
    // fallback
  }

  const cleanUrl = `${origin}/${fileId}`;

  // Attempt 1: Direct HTMX POST
  try {
    return await attemptDirectPost(origin, fileId, cleanUrl);
  } catch (err) {
    if (err.message === "RATE_LIMITED") {
      // Wait 3 seconds and retry once
      await new Promise((r) => setTimeout(r, 3000));
      try {
        return await attemptDirectPost(origin, fileId, cleanUrl);
      } catch (retryErr) {
        // If still rate limited, try tab fallback
      }
    }

    // Attempt 2: Try GET request (for legacy pages / mirrors)
    try {
      return await attemptGet(cleanUrl, origin);
    } catch (getErr) {
      // If blocked or not found, proceed to tab fallback
    }

    // Attempt 3: Background tab resolution (solves Cloudflare Turnstile if present)
    return await resolveViaTab(cleanUrl, fileId, origin);
  }
}

// Global resolution chain to space out requests to FuckingFast and prevent 429 rate limits
let resolveQueue = Promise.resolve();
function scheduleResolve(fn) {
  const next = resolveQueue.then(async () => {
    try {
      return await fn();
    } finally {
      // 1-second delay between resolution attempts
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
  resolveQueue = next.catch(() => {});
  return next;
}

function extractSubfolder(fullPath) {
  if (!fullPath || typeof fullPath !== "string") return "";
  const normalized = fullPath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) return "";
  const dir = normalized.substring(0, lastSlash);

  const lower = dir.toLowerCase();
  const dlIdx = lower.lastIndexOf("/downloads");
  if (dlIdx !== -1) {
    const sub = dir.substring(dlIdx + "/downloads".length).replace(/^\/+/, "");
    if (sub) return sub;
  }
  return "";
}

function waitForFirstDownloadDestination(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollInterval = null;

    function cleanup() {
      settled = true;
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      chrome.downloads.onChanged.removeListener(listener);
    }

    function checkItem() {
      if (settled) return;
      chrome.downloads.search({ id: downloadId }, (results) => {
        if (settled) return;
        if (chrome.runtime.lastError) return;
        if (!results || !results[0]) return;

        const item = results[0];
        // If filename is now populated and user didn't cancel
        if (item.filename && item.filename.length > 0) {
          // If state is not interrupted or user didn't cancel
          if (item.state !== "interrupted") {
            cleanup();
            resolve(item.filename);
            return;
          }
        }

        if (item.state === "interrupted") {
          cleanup();
          reject(new Error(item.error || "Download interrupted"));
          return;
        }
      });
    }

    // Check immediately
    checkItem();

    // Poll every 400ms to catch when the user confirms the Save As dialog
    pollInterval = setInterval(checkItem, 400);

    function listener(delta) {
      if (delta.id !== downloadId || settled) return;

      if (delta.filename && delta.filename.current) {
        cleanup();
        resolve(delta.filename.current);
        return;
      }

      if (delta.error && delta.error.current) {
        cleanup();
        reject(new Error(delta.error.current));
        return;
      }

      if (delta.state && delta.state.current === "interrupted") {
        cleanup();
        reject(new Error("Download interrupted"));
        return;
      }

      // Any progress indicator (bytesReceived, totalBytes, state change)
      // means the user confirmed the Save As prompt and download has started
      if (delta.bytesReceived || delta.state?.current === "in_progress" || delta.canResume) {
        checkItem();
      }
    }

    chrome.downloads.onChanged.addListener(listener);
  });
}

/**
 * Start a Chrome download for the given URL and resolve with its downloadId.
 * @param {string} dlUrl
 * @param {string|null} filename
 * @param {boolean} isFirstInBatch
 * @param {boolean} saveAs
 */
function startDownload(dlUrl, filename, isFirstInBatch = false, saveAs = false) {
  return new Promise((resolve, reject) => {
    const options = {
      url: dlUrl,
      saveAs: saveAs === true
    };

    let cleanName = null;
    if (filename && typeof filename === "string") {
      cleanName = filename
        .replace(/\\/g, "/")
        .replace(/[<>:"|?*]/g, "_")
        .trim();
      if (cleanName) {
        options.filename = cleanName;
      }
    }

    const config = {
      filename: cleanName,
      isFirstInBatch: isFirstInBatch === true
    };
    pendingDownloadConfigsByUrl.set(dlUrl, config);

    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        pendingDownloadConfigsByUrl.delete(dlUrl);
        // Fallback without explicit filename if Chrome rejected the filename
        if (options.filename) {
          const fallbackOptions = { url: dlUrl, saveAs: saveAs === true };
          chrome.downloads.download(fallbackOptions, (fallbackId) => {
            if (chrome.runtime.lastError || fallbackId === undefined) {
              reject(
                chrome.runtime.lastError ||
                  new Error("chrome.downloads.download() failed")
              );
            } else {
              downloadConfigsById.set(fallbackId, config);
              resolve(fallbackId);
            }
          });
          return;
        }
        reject(
          chrome.runtime.lastError ||
            new Error("chrome.downloads.download() failed")
        );
        return;
      }
      downloadConfigsById.set(downloadId, config);
      resolve(downloadId);
    });
  });
}

/**
 * Ensure we have a session for the given active FitGirl tab.
 */
async function ensureSessionForTab(tab) {
  await loadSessions();
  await reconcileSessionForTab(tab.id);

  const existing = sessions[tab.id];
  let session = existing ? normalizeSessionShape(existing) : null;
  if (session) {
    sessions[tab.id] = session;
    if (shouldReuseSessionForTab(session, tab)) {
      return session;
    }
  }

  const nextGeneration = session ? getSessionGeneration(session) + 1 : 0;
  return rebuildSessionForTab(tab, nextGeneration);
}

/**
 * Pump the queue for a specific FitGirl URL: start new downloads
 * up to the concurrency limit. Called when a batch starts and whenever
 * a download for that URL completes.
 */
async function pumpQueueForTab(tabId, expectedGeneration) {
  await loadSessions();
  const existingSession = sessions[tabId];
  if (!existingSession) return;
  const session = normalizeSessionShape(existingSession);
  sessions[tabId] = session;
  if (!session || !Array.isArray(session.items) || !session.items.length) return;

  const runGeneration =
    expectedGeneration == null ? getSessionGeneration(session) : expectedGeneration;
  if (!isSessionGenerationCurrent(tabId, runGeneration)) return;

  const { concurrency } = await getCurrentSettings();
  const maxConcurrent = clampConcurrency(concurrency);

  if (session.paused) return;

  const activeCount = session.items.filter(
    (item) => item.state === "starting" || item.state === "downloading"
  ).length;

  // If the first download hasn't determined its destination yet,
  // allow only 1 active item (the first one) and wait for the user to complete the Save As dialog.
  if (!session.firstDownloadDetermined) {
    if (activeCount > 0) {
      return;
    }
  }

  const effectiveMax = session.firstDownloadDetermined ? maxConcurrent : 1;
  let availableSlots = effectiveMax - activeCount;
  if (availableSlots <= 0) return;

  await loadDownloadMap();

  for (let i = 0; i < session.items.length && availableSlots > 0; i++) {
    const item = getSessionItemForRun(tabId, i, runGeneration);
    if (!item) continue;
    if (item.state !== "queued") continue;

    availableSlots--;
    item.state = "starting";

    (async (index, generation) => {
      try {
        const activeItemBeforeFetch = getSessionItemForRun(tabId, index, generation);
        if (!activeItemBeforeFetch || activeItemBeforeFetch.state !== "starting") {
          return;
        }

        const filename = extractFilenameFromUrl(
          activeItemBeforeFetch.url,
          activeItemBeforeFetch.label
        );

        const dlUrl = await scheduleResolve(() =>
          getDirectDownloadUrl(activeItemBeforeFetch.url)
        );

        const activeItemBeforeDownload = getSessionItemForRun(tabId, index, generation);
        if (!activeItemBeforeDownload || activeItemBeforeDownload.state !== "starting") {
          return;
        }

        // The first file in the set asks where to save (saveAs: true).
        // Subsequent files automatically download to that same location (saveAs: false).
        const isFirst = !session.firstDownloadPrompted;
        if (isFirst) {
          session.firstDownloadPrompted = true;
          await saveSessions();
        }

        const currentSubfolder = session.subfolder || "";
        const finalFilename = currentSubfolder && filename
          ? `${currentSubfolder}/${filename}`
          : filename;

        let downloadId;
        try {
          downloadId = await startDownload(dlUrl, finalFilename, isFirst, isFirst);
        } catch (dlErr) {
          const altUrl = swapProtocol(dlUrl);
          console.warn("Download failed, retrying with", altUrl, dlErr);
          downloadId = await startDownload(altUrl, finalFilename, isFirst, isFirst);
        }

        const activeItemAfterDownload = getSessionItemForRun(tabId, index, generation);
        if (!activeItemAfterDownload || activeItemAfterDownload.state !== "starting") {
          try {
            chrome.downloads.cancel(downloadId);
          } catch (e) {
            // ignore
          }
          return;
        }

        activeItemAfterDownload.downloadId = downloadId;
        activeItemAfterDownload.state = "downloading";
        activeItemAfterDownload.error = null;
        downloadIdToKey.set(downloadId, { tabId, index, generation });
        await Promise.all([saveSessions(), saveDownloadMap()]);
        broadcastSessionUpdate(tabId);

        // When the first file is prompted, wait for the user to confirm the Save As dialog.
        // Once the destination is selected, mark it determined and immediately pump the rest of the files!
        if (isFirst) {
          try {
            const chosenPath = await waitForFirstDownloadDestination(downloadId);
            session.subfolder = extractSubfolder(chosenPath);
            session.firstDownloadDetermined = true;
            await saveSessions();
            broadcastSessionUpdate(tabId);
            // Resume pumping remaining items in the set
            pumpQueueForTab(tabId, generation);
          } catch (promptErr) {
            if (promptErr && promptErr.message === "USER_CANCELED") {
              activeItemAfterDownload.state = "cancelled";
              session.hasStarted = false;
              await saveSessions();
              broadcastSessionUpdate(tabId);
              return;
            }
          }
        }
      } catch (err) {
        const activeItemOnError = getSessionItemForRun(tabId, index, generation);
        if (!activeItemOnError) return;
        console.warn("Failed to start FuckingFast URL:", activeItemOnError.url, err);
        activeItemOnError.state = "error";
        activeItemOnError.error = err.message || String(err);
        activeItemOnError.downloadId = null;
        await saveSessions();
        broadcastSessionUpdate(tabId);
        pumpQueueForTab(tabId, generation);
      }
    })(i, runGeneration);
  }
}

// Track completion of underlying Chrome downloads
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !delta.state.current) return;

  const state = delta.state.current;
  if (state !== "complete" && state !== "interrupted") return;

  (async () => {
    await loadDownloadMap();
    const key = downloadIdToKey.get(delta.id);
    if (!key) return;

    await loadSessions();
    const existingSession = sessions[key.tabId];
    if (!existingSession) {
      downloadIdToKey.delete(delta.id);
      await saveDownloadMap();
      return;
    }
    const session = normalizeSessionShape(existingSession);
    sessions[key.tabId] = session;
    if (!isSessionGenerationCurrent(key.tabId, key.generation)) {
      downloadIdToKey.delete(delta.id);
      await saveDownloadMap();
      return;
    }
    if (!session || !session.items || !session.items[key.index]) {
      downloadIdToKey.delete(delta.id);
      await saveDownloadMap();
      return;
    }

    const item = session.items[key.index];
    downloadIdToKey.delete(delta.id);
    item.downloadId = null;
    if (state === "complete") {
      item.state = "completed";
      item.error = null;
    } else {
      const errCode = delta.error?.current;
      item.state = errCode === "USER_CANCELED" ? "cancelled" : "error";
      item.error = errCode || "Download interrupted";
    }
    await Promise.all([saveSessions(), saveDownloadMap()]);
    broadcastSessionUpdate(key.tabId);
    // Try to start the next queued download
    pumpQueueForTab(key.tabId, key.generation);
  })();
});

// Clean up tab-scoped sessions when a tab is closed or navigated/reloaded
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    (async () => {
      await loadSessions();
      const session = sessions[tabId];
      // When page reloads/navigates, if no downloads are actively in progress, clear the session so fresh links are found
      if (session && !hasActiveItems(session)) {
        delete sessions[tabId];
        await saveSessions();
      }
    })();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    await loadSessions();
    if (sessions[tabId]) {
      delete sessions[tabId];
      await saveSessions();
    }

    await loadDownloadMap();
    let changed = false;
    for (const [downloadId, key] of Array.from(downloadIdToKey.entries())) {
      if (key.tabId === tabId) {
        downloadIdToKey.delete(downloadId);
        changed = true;
      }
    }
    if (changed) {
      await saveDownloadMap();
    }
  })();
});

// Message-based API for popup UIs
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "scan_current_tab") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });

        if (!tab || !tab.id || !tab.url?.includes("fitgirl-repacks.site")) {
          sendResponse({
            ok: false,
            error: "Please open a FitGirl repack page first."
          });
          return;
        }

        const sess = await ensureSessionForTab(tab);
        sendResponse({ ok: true, session: sess, tabId: tab.id });
      } catch (err) {
        console.error("scan_current_tab failed:", err);
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true; // keep channel open for async response
  }

  if (message.type === "start_downloads") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });

        if (!tab || !tab.url) {
          sendResponse({
            ok: false,
            error: "No active FitGirl tab found."
          });
          return;
        }

        const tabId = tab.id;
        const session = normalizeSessionShape(await ensureSessionForTab(tab));
        sessions[tabId] = session;

        const selectedUrls = new Set(
          (message.items || [])
            .map((i) => i.url)
            .filter((u) => typeof u === "string" && u.length)
        );

        if (!selectedUrls.size) {
          sendResponse({
            ok: false,
            error: "No files selected for download."
          });
          return;
        }

        const candidateLinks =
          Array.isArray(session.allItems) && session.allItems.length
            ? session.allItems
            : (session.items || []).map((item) => ({
                url: item.url,
                label: item.label || item.url
              }));

        const selectedItems = candidateLinks
          .filter((item) => selectedUrls.has(item.url))
          .map(toQueuedItem);

        if (!selectedItems.length) {
          sendResponse({
            ok: false,
            error: "Selected files were not found in the current page scan."
          });
          return;
        }

        // Start a new run generation to invalidate any stale async workers.
        session.generation = getSessionGeneration(session) + 1;
        const runGeneration = session.generation;
        session.items = selectedItems;
        session.hasStarted = true;
        session.paused = false;
        session.firstDownloadPrompted = false;
        session.firstDownloadDetermined = false;
        session.subfolder = "";

        // Clear mapping entries for this tab
        await loadDownloadMap();
        for (const [downloadId, key] of Array.from(downloadIdToKey.entries())) {
          if (key.tabId === tabId) {
            downloadIdToKey.delete(downloadId);
          }
        }
        sessions[tabId] = session;
        await Promise.all([saveSessions(), saveDownloadMap()]);
        broadcastSessionUpdate(tabId);

        // Start the queue pump for this tab (will respect concurrency limit)
        pumpQueueForTab(tabId, runGeneration);

        sendResponse({ ok: true });
      } catch (err) {
        console.error("start_downloads failed:", err);
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "get_settings") {
    (async () => {
      try {
        const current = await getCurrentSettings();
        sendResponse({ ok: true, settings: current });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "save_settings") {
    const newConcurrency = clampConcurrency(message?.settings?.concurrency);
    chrome.storage.sync.set(
      { concurrency: newConcurrency },
      () => {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError.message
          });
        } else {
          sendResponse({
            ok: true,
            settings: { concurrency: newConcurrency }
          });
        }
      }
    );
    return true;
  }

  if (message.type === "get_session") {
    (async () => {
      try {
        await loadSessions();
        sendResponse({ ok: true, sessions });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "cancel_downloads") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (!tab || !tab.url) {
          sendResponse({
            ok: false,
            error: "No active FitGirl tab found."
          });
          return;
        }
        const tabId = tab.id;
        const existingSession = sessions[tabId];
        if (!existingSession) {
          sendResponse({ ok: true });
          return;
        }
        const session = normalizeSessionShape(existingSession);

        // Invalidate current run first so in-flight workers stop mutating state.
        session.generation = getSessionGeneration(session) + 1;
        session.hasStarted = false;
        session.paused = false;
        session.firstDownloadPrompted = false;
        session.firstDownloadDetermined = false;
        session.subfolder = "";

        // Cancel all active and queued downloads
        await loadDownloadMap();
        for (let i = 0; i < session.items.length; i++) {
          const item = session.items[i];
          if (item.downloadId != null) {
            try {
              chrome.downloads.cancel(item.downloadId);
            } catch (e) {
              // ignore
            }
            downloadIdToKey.delete(item.downloadId);
            item.downloadId = null;
          }
          if (ACTIVE_ITEM_STATES.has(item.state)) {
            item.state = "cancelled";
          }
        }
        sessions[tabId] = session;
        await Promise.all([saveSessions(), saveDownloadMap()]);

        // Rebuild immediately for the current page so popup opens into fresh
        // detection state without requiring a manual reset action.
        if (tab.url?.includes("fitgirl-repacks.site")) {
          const refreshed = await rebuildSessionForTab(tab, session.generation);
          sessions[tabId] = refreshed;
        }

        broadcastSessionUpdate(tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "pause_downloads" || message.type === "resume_downloads") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (!tab || !tab.url) {
          sendResponse({
            ok: false,
            error: "No active FitGirl tab found."
          });
          return;
        }
        const tabId = tab.id;
        const existingSession = sessions[tabId];
        if (!existingSession) {
          sendResponse({ ok: true });
          return;
        }
        const session = normalizeSessionShape(existingSession);

        const shouldPause = message.type === "pause_downloads";
        session.paused = shouldPause;

        for (let i = 0; i < session.items.length; i++) {
          const item = session.items[i];
          if (item.downloadId == null) continue;

          try {
            if (shouldPause && item.state === "downloading") {
              chrome.downloads.pause(item.downloadId);
              item.state = "paused";
            } else if (!shouldPause && item.state === "paused") {
              chrome.downloads.resume(item.downloadId);
              item.state = "downloading";
            }
          } catch (e) {
            // ignore
          }
        }

        sessions[tabId] = session;
        await saveSessions();
        broadcastSessionUpdate(tabId);

        if (!shouldPause) {
          pumpQueueForTab(tabId);
        }

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "retry_failed") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (!tab || !tab.url) {
          sendResponse({ ok: false, error: "No active FitGirl tab found." });
          return;
        }
        const tabId = tab.id;
        const existingSession = sessions[tabId];
        if (!existingSession) {
          sendResponse({ ok: true });
          return;
        }
        const session = normalizeSessionShape(existingSession);

        let requeued = 0;
        for (const item of session.items) {
          if (item.state === "error") {
            item.state = "queued";
            item.error = null;
            item.downloadId = null;
            requeued++;
          }
        }

        if (requeued > 0) {
          session.generation = getSessionGeneration(session) + 1;
          const runGeneration = session.generation;
          session.hasStarted = true;
          session.paused = false;
          sessions[tabId] = session;
          await saveSessions();
          broadcastSessionUpdate(tabId);
          pumpQueueForTab(tabId, runGeneration);
        }

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message.type === "reset_batch") {
    (async () => {
      try {
        await loadSessions();
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true
        });
        if (!tab || !tab.url) {
          sendResponse({ ok: false, error: "No active FitGirl tab found." });
          return;
        }
        const tabId = tab.id;
        const existingSession = sessions[tabId];
        const currentGen = existingSession ? getSessionGeneration(existingSession) : 0;
        const refreshed = await rebuildSessionForTab(tab, currentGen + 1);
        sessions[tabId] = refreshed;
        await saveSessions();
        broadcastSessionUpdate(tabId);
        sendResponse({ ok: true, session: refreshed });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }
});
