/* ==========================================================================
   X Video Downloader - background.js (MV3 service worker)
   Handles video download requests and country lookups via X's
   AboutAccountQuery GraphQL endpoint.
   ========================================================================== */

/* -- Download handler -------------------------------------------------- */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.type === 'XDL_DOWNLOAD') {
    handleDownload(message, sendResponse);
    return true;
  }
  if (message.type === 'XDL_LOOKUP') {
    handleLookup(message, sendResponse);
    return true;
  }
  return false;
});

function handleDownload(message, sendResponse) {
  chrome.downloads.download(
    {
      url: message.url,
      filename: sanitizeFilename(message.filename),
      saveAs: false,
    },
    function (downloadId) {
      if (chrome.runtime.lastError || !downloadId) {
        sendResponse({ success: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Download failed' });
      } else {
        sendResponse({ success: true, id: downloadId });
      }
    }
  );
}

function sanitizeFilename(name) {
  return (name || 'video.mp4').replaceAll(/[\\/:*?"<>|]/g, '_').slice(0, 200);
}

/* -- Country lookup --------------------------------------------------- */

// Public bearer token embedded in X.com's web client JavaScript (not secret)
var BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
// AboutAccountQuery — queryId changes per X.com deploy. Update if lookups fail.
var QUERY_IDS = ['zs_jFPFT78rBpXv9Z3U2YQ', 'XRqGa7EeokUU5kppkh13EA'];

var CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
var CACHE_MAX_ENTRIES = 3000; // bound storage size (prune oldest on flush)
var MAX_CONCURRENT = 5; // parallel lookup slots
var THROTTLE_MS = 10_000; // pool cool-down after a 429
var memCache = new Map(); // screenName -> {country, accurate, ts}
var inflight = new Map(); // screenName -> [sendResponse callbacks]
var queue = [];
var running = 0;
var throttleUntil = 0;

function handleLookup(message, sendResponse) {
  var screenName = message.screenName;

  // 1. In-memory cache
  var cached = memCache.get(screenName);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    sendResponse({ country: cached.country, accurate: cached.accurate });
    return;
  }

  // 2. Persistent cache (chrome.storage)
  chrome.storage.local.get('xdl_cache', function (data) {
    var store = data.xdl_cache || {};
    var entry = store[screenName];
    if (entry && Date.now() - entry.ts < CACHE_TTL) {
      memCache.set(screenName, entry);
      sendResponse({ country: entry.country, accurate: entry.accurate });
      return;
    }

    // 3. Deduplicate in-flight requests
    if (inflight.has(screenName)) {
      inflight.get(screenName).push(sendResponse);
      return;
    }
    inflight.set(screenName, [sendResponse]);

    // 4. Queue the API call (bounded parallel pool, backs off on 429)
    enqueue(function () {
      return fetchCountry(screenName, message.csrf)
        .then(function (result) {
          var entry_ = { country: result.country, accurate: result.accurate, ts: Date.now() };
          memCache.set(screenName, entry_);
          persistCache(screenName, entry_);
          resolveInflight(screenName, { country: result.country, accurate: result.accurate });
        })
        .catch(function (error) {
          if (error.message === 'Rate limited') {
            throttleUntil = Date.now() + THROTTLE_MS;
          }
          console.warn('[XDL] Lookup failed for @' + screenName + ':', error.message);
          resolveInflight(screenName, { country: null, error: error.message });
        });
    });
  });
}

function resolveInflight(screenName, response) {
  var callers = inflight.get(screenName);
  inflight.delete(screenName);
  if (callers) {
    for (var index = 0; index < callers.length; index++) {
      try { callers[index](response); } catch { /* port closed */ }
    }
  }
}

function persistCache(screenName, entry) {
  chrome.storage.local.get('xdl_cache', function (data) {
    var store = data.xdl_cache || {};
    store[screenName] = entry;

    var keys = Object.keys(store);
    var excess = keys.length - CACHE_MAX_ENTRIES;
    if (excess > 0) {
      // Drop the oldest entries to keep reads/writes O(bounded)
      keys.sort(function (a, b) { return (store[a].ts || 0) - (store[b].ts || 0); });
      for (var di = 0; di < excess; di++) delete store[keys[di]];
    }

    chrome.storage.local.set({ xdl_cache: store });
  });
}

/* -- Fetch pool: bounded parallelism + 429 backoff -------------------- */

function enqueue(task) {
  queue.push(task);
  pump();
}

function pump() {
  if (running >= MAX_CONCURRENT) return;
  var wait = Math.max(0, throttleUntil - Date.now());
  if (wait > 0) {
    setTimeout(pump, wait);
    return;
  }

  var task = queue.shift();
  if (!task) return;

  running++;
  Promise.resolve(task())
    .catch(function (error) {
      console.warn('[XDL] Pool task error:', error.message);
    })
    .then(function () {
      running--;
      pump();
    });
  pump(); // fill remaining slots
}

/* -- AboutAccountQuery fetch ------------------------------------------ */

async function fetchCountry(screenName, csrf) {
  if (!csrf) throw new Error('No CSRF token');

  var variables = JSON.stringify({ screenName: screenName });

  for (var index = 0; index < QUERY_IDS.length; index++) {
    var url = 'https://x.com/i/api/graphql/' + QUERY_IDS[index] + '/AboutAccountQuery?variables=' + encodeURIComponent(variables);

    var resp;
    try {
      resp = await fetch(url, {
        credentials: 'include',
        headers: {
          'authorization': 'Bearer ' + BEARER,
          'x-csrf-token': csrf,
          'content-type': 'application/json',
        },
      });
    } catch (error) {
      throw new Error('Network: ' + error.message);
    }

    if (resp.status === 429) {
      throw new Error('Rate limited');
    }
    if (resp.status === 403 || resp.status === 401) {
      throw new Error('Auth (' + resp.status + ')');
    }
    if (!resp.ok) {
      // Try next queryId
      if (index < QUERY_IDS.length - 1) continue;
      throw new Error('HTTP ' + resp.status);
    }

    var json = await resp.json();
    var result = json && json.data && json.data.user_result_by_screen_name && json.data.user_result_by_screen_name.result;
    if (!result) return { country: null, accurate: true };

    var about = result.about_profile;
    if (!about) return { country: null, accurate: true };

    return {
      country: about.account_based_in || null,
      accurate: about.location_accurate !== false,
    };
  }

  throw new Error('All queryIds exhausted');
}
