/* ==========================================================================
   X Video Downloader - content.js (ISOLATED world)
   Watches the timeline for video tweets (flagged by inject.js via the
   data-xdl-url attribute) and injects a download button next to the share
   button in each tweet's action bar.
   Also filters (hides) posts from user-blocked countries using the
   AboutAccountQuery data resolved by background.js.
   ========================================================================== */

(function () {
  var VIDEO_ATTR = 'data-xdl-url';
  var USER_ATTR = 'data-xdl-user';
  var COUNTRY_ATTR = 'data-xdl-country';
  var QUOTE_USER_ATTR = 'data-xdl-quote-user';
  var QUOTE_COUNTRY_ATTR = 'data-xdl-quote-country';
  var STATUS_ATTR = 'data-xdl-status';
  var CONTAINER_CLASS = 'xdl-btn-wrap';
  var ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" class="xdl-svg"><g><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></g></svg>';
  var ICON_SPINNER =
    '<svg viewBox="0 0 24 24" class="xdl-svg xdl-spin"><path d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z"></path></svg>';
  var ICON_CHECK =
    '<svg viewBox="0 0 24 24" class="xdl-svg"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"></path></svg>';

  /* -- Button creation -------------------------------------------------- */

  function createButton(article) {
    if (article.querySelector('.' + CONTAINER_CLASS)) return;

    // Locate the action bar — the [role="group"] containing like/reply buttons
    var bar = article.querySelector('[role="group"]');
    if (!bar) return;
    if (!bar.querySelector('[data-testid="like"]') && !bar.querySelector('[data-testid="reply"]')) return;

    // Find where to insert: right before the share button (after bookmark)
    var children = Array.prototype.slice.call(bar.children);
    var insertBefore = null;
    for (var index = 0; index < children.length; index++) {
      if (children[index].querySelector('[data-testid="bookmark"]')) {
        insertBefore = index + 1 < children.length ? children[index + 1] : null;
        break;
      }
    }
    if (!insertBefore) insertBefore = bar.lastElementChild; // fallback: before last child

    var wrap = document.createElement('div');
    wrap.className = CONTAINER_CLASS;

    var button = document.createElement('button');
    button.className = 'xdl-btn';
    button.setAttribute('type', 'button');
    button.setAttribute('aria-label', 'Download video');
    button.setAttribute('role', 'button');
    button.innerHTML = ICON_DOWNLOAD;
    button.addEventListener('click', onDownload);

    wrap.append(button);
    insertBefore.before(wrap);
  }

  function removeButton(article) {
    var existing = article.querySelector('.' + CONTAINER_CLASS);
    if (existing) existing.remove();
  }

  /* -- Download handler ------------------------------------------------- */

  function onDownload(event) {
    event.preventDefault();
    event.stopPropagation();

    var button = event.currentTarget;
    if (button.classList.contains('xdl-loading')) return;

    var article = button.closest('article[data-testid="tweet"]');
    if (!article) return;

    var url = article.getAttribute(VIDEO_ATTR);

    if (!url) {
      // Ask inject.js to rescan, then retry once
      window.postMessage({ type: 'XDL_RESCAN' }, '*');
      setTimeout(function () {
        var u = article.getAttribute(VIDEO_ATTR);
        if (u) doDownload(button, article, u);
        else flash(button, 'xdl-error');
      }, 600);
      return;
    }

    doDownload(button, article, url);
  }

  function doDownload(button, article, url) {
    button.classList.add('xdl-loading');
    button.innerHTML = ICON_SPINNER;

    // Build a friendly filename
    var filename = 'x_video.mp4';
    var link = article.querySelector('a[href*="/status/"]');
    if (link) {
      var m = (link.href || '').match(/\/([^/]+)\/status\/(\d+)/);
      if (m) filename = m[1] + '_' + m[2] + '.mp4';
    }

    chrome.runtime.sendMessage(
      { type: 'XDL_DOWNLOAD', url: url, filename: filename },
      function (resp) {
        button.classList.remove('xdl-loading');
        if (resp && resp.success) {
          button.innerHTML = ICON_CHECK;
          button.classList.add('xdl-ok');
          setTimeout(resetButton, 2000, button);
        } else {
          button.innerHTML = ICON_DOWNLOAD;
          flash(button, 'xdl-error');
        }
      }
    );
  }

  function resetButton(button) {
    button.innerHTML = ICON_DOWNLOAD;
    button.classList.remove('xdl-ok');
  }

  function flash(button, cls) {
    button.classList.add(cls);
    setTimeout(function () { button.classList.remove(cls); }, 1200);
  }

  /* -- Country filter --------------------------------------------------- */

  var pendingLookups = new Set();
  var localCache = {}; // screenName -> country string
  var countryUnknown = new Set(); // users with hidden/unavailable country — don't re-ask
  var blockedCountries = [];
  var filterEnabled = false;
  var ready = false; // becomes true once settings are loaded
  var CACHE_TTL = 24 * 60 * 60 * 1000; // must match background.js

  // Load initial settings + pre-populate cache from persistent storage
  chrome.storage.local.get(['xdl_filter_enabled', 'xdl_blocked_countries', 'xdl_cache'], function (data) {
    filterEnabled = !!data.xdl_filter_enabled;
    blockedCountries = data.xdl_blocked_countries || [];
    var cache = data.xdl_cache || {};
    var now = Date.now();
    for (var user in cache) {
      var entry = cache[user];
      if (!entry || now - (entry.ts || 0) >= CACHE_TTL) continue;
      if (entry.country) localCache[user] = entry.country;
      else countryUnknown.add(user);
    }
    ready = true;
    fullScan(); // re-process now that settings are available
  });

  // React to popup changes live
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.xdl_filter_enabled) {
      filterEnabled = !!changes.xdl_filter_enabled.newValue;
      reevaluateAll();
    }
    if (changes.xdl_blocked_countries) {
      blockedCountries = changes.xdl_blocked_countries.newValue || [];
      reevaluateAll();
    }
  });

  /**
   * Extract author screen name, canonical status URL, and quoted-tweet
   * screen name (if any) from the tweet's DOM.
   *
   * The author's permalink is the <a> wrapping the <time> element.
   * The quoted tweet's link is any OTHER a[href*="/status/"] inside the
   * article — excluding plain tweet-text links inside [data-testid="tweetText"],
   * which are not quote cards.
   */
  function getTweetInfo(article) {
    var time = article.querySelector('time');
    var link = time ? time.closest('a[href*="/status/"]') : null;
    if (!link) link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    var m = (link.href || '').match(/\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;

    var permalink = link.href;
    var textBox = article.querySelector('[data-testid="tweetText"]');
    var quoteScreenName = null;
    var allLinks = article.querySelectorAll('a[href*="/status/"]');
    for (var ql of allLinks) {
      if (ql.href === permalink) continue;
      if (textBox && textBox.contains(ql)) continue;
      var qm = (ql.href || '').match(/\/([^/]+)\/status\/\d+/);
      if (qm) {
        quoteScreenName = qm[1];
        break;
      }
    }

    return { screenName: m[1], statusUrl: permalink, quoteScreenName: quoteScreenName };
  }

  /**
   * Check both author and quoted-tweet countries. Block if either is blocked.
   * Returns true if the decision was applied (both countries resolved).
   */
  function applyBlockDecision(article) {
    var authorCountry = article.getAttribute(COUNTRY_ATTR);
    if (!authorCountry) return false;

    var quoteUser = article.getAttribute(QUOTE_USER_ATTR);
    var quoteCountry = quoteUser ? article.getAttribute(QUOTE_COUNTRY_ATTR) : null;

    // Wait for the quoted user's country, unless it's known-unavailable
    // (hidden country accounts can never block — don't wait forever)
    if (quoteUser && !quoteCountry && !countryUnknown.has(quoteUser)) return false;

    var shouldBlock = filterEnabled && (
      blockedCountries.includes(authorCountry) ||
      (quoteCountry && blockedCountries.includes(quoteCountry))
    );

    if (shouldBlock) {
      addBlock(article);
    } else {
      removeBlock(article);
    }
    return true;
  }

  function processCountry(article) {
    if (!ready) return;

    var info = getTweetInfo(article);
    if (!info) return;

    // --- Lock: skip entirely if this is the same tweet (no flicker) ---
    var storedStatus = article.getAttribute(STATUS_ATTR);
    var isSameTweet = storedStatus && storedStatus === info.statusUrl;

    if (!isSameTweet) {
      // New tweet or recycled article — reset, keep block until resolved
      article.setAttribute(STATUS_ATTR, info.statusUrl);
      article.setAttribute(USER_ATTR, info.screenName);
      article.removeAttribute(COUNTRY_ATTR);
      if (info.quoteScreenName) {
        article.setAttribute(QUOTE_USER_ATTR, info.quoteScreenName);
      } else {
        article.removeAttribute(QUOTE_USER_ATTR);
      }
      article.removeAttribute(QUOTE_COUNTRY_ATTR);
    }

    // Resolve author country from cache
    if (!article.getAttribute(COUNTRY_ATTR) && localCache[info.screenName]) {
      article.setAttribute(COUNTRY_ATTR, localCache[info.screenName]);
    }

    // Self-quote: quoted tweet is the same user — reuse the author's country
    if (info.quoteScreenName === info.screenName && article.getAttribute(COUNTRY_ATTR)) {
      article.setAttribute(QUOTE_COUNTRY_ATTR, article.getAttribute(COUNTRY_ATTR));
    }

    // Resolve quote country from cache
    if (info.quoteScreenName && !article.getAttribute(QUOTE_COUNTRY_ATTR) && localCache[info.quoteScreenName]) {
      article.setAttribute(QUOTE_COUNTRY_ATTR, localCache[info.quoteScreenName]);
    }

    // Request lookups for unresolved users (skip known-unknown countries)
    if (!article.getAttribute(COUNTRY_ATTR) && !pendingLookups.has(info.screenName) &&
        !countryUnknown.has(info.screenName)) {
      requestLookup(info.screenName);
    }
    if (info.quoteScreenName && info.quoteScreenName !== info.screenName &&
        !article.getAttribute(QUOTE_COUNTRY_ATTR) &&
        !pendingLookups.has(info.quoteScreenName) &&
        !countryUnknown.has(info.quoteScreenName)) {
      requestLookup(info.quoteScreenName);
    }

    // Apply decision if all countries are resolved
    applyBlockDecision(article);
  }

  function requestLookup(screenName) {
    pendingLookups.add(screenName);

    var csrf = (document.cookie.match(/ct0=([^;]+)/) || [])[1];
    if (!csrf) {
      pendingLookups.delete(screenName);
      return; // not logged in
    }

    chrome.runtime.sendMessage(
      { type: 'XDL_LOOKUP', screenName: screenName, csrf: csrf },
      function (resp) {
        pendingLookups.delete(screenName);
        if (chrome.runtime.lastError || !resp) return;

        if (!resp.country) {
          // Hidden country / unavailable account — remember so we stop re-asking
          countryUnknown.add(screenName);
          return;
        }

        localCache[screenName] = resp.country;

        // Update articles where this user is the author
        var asAuthor = document.querySelectorAll('article[' + USER_ATTR + '="' + screenName + '"]');
        for (var ai = 0; ai < asAuthor.length; ai++) {
          asAuthor[ai].setAttribute(COUNTRY_ATTR, resp.country);
        }

        // Update articles where this user is quoted
        var asQuote = document.querySelectorAll('article[' + QUOTE_USER_ATTR + '="' + screenName + '"]');
        for (var qi = 0; qi < asQuote.length; qi++) {
          asQuote[qi].setAttribute(QUOTE_COUNTRY_ATTR, resp.country);
        }

        // Re-evaluate all affected articles
        var affected = new Set(asAuthor);
        for (var qi2 = 0; qi2 < asQuote.length; qi2++) affected.add(asQuote[qi2]);
        affected.forEach(function (article) { applyBlockDecision(article); });
      }
    );
  }

  function addBlock(article) {
    if (article.style.display === 'none') return;
    article.style.setProperty('display', 'none', 'important');
    scheduleStatsUpdate();
  }

  function removeBlock(article) {
    if (article.style.display !== 'none') return;
    article.style.removeProperty('display');
    scheduleStatsUpdate();
  }

  /* -- Blocked stats (debounced write to storage) ---------------------- */

  var statsTimer = null;

  function scheduleStatsUpdate() {
    if (statsTimer) return;
    statsTimer = setTimeout(function () {
      statsTimer = null;
      var stats = {};
      var blocked = document.querySelectorAll('article[' + COUNTRY_ATTR + ']');
      for (var index = 0; index < blocked.length; index++) {
        if (blocked[index].style.display !== 'none') continue;
        var c = blocked[index].getAttribute(COUNTRY_ATTR);
        if (c) stats[c] = (stats[c] || 0) + 1;
      }
      chrome.storage.local.set({ xdl_blocked_stats: stats });
    }, 500);
  }

  function reevaluateAll() {
    var articles = document.querySelectorAll('article[' + STATUS_ATTR + ']');
    for (var index = 0; index < articles.length; index++) {
      applyBlockDecision(articles[index]);
    }
  }

  /* -- Timeline scanning ------------------------------------------------ */
  // Only articles touched by DOM mutations are re-scanned. A full scan runs
  // on a slow fallback interval (attribute-only updates don't fire the
  // observer) and is skipped entirely in background tabs.

  var dirtyArticles = new Set();

  function markDirty(node) {
    if (!node || node.nodeType !== 1 || !node.closest) return;
    var article = node.closest('article[data-testid="tweet"]');
    if (article) dirtyArticles.add(article);
  }

  function process() {
    if (document.hidden) return;
    if (dirtyArticles.size === 0) return;

    var targets = dirtyArticles;
    dirtyArticles = new Set();

    for (var article of targets) {
      if (!article.isConnected) continue;
      // Download button (video tweets only)
      if (article.hasAttribute(VIDEO_ATTR)) {
        createButton(article);
      } else {
        removeButton(article);
      }
      // Country filter (all tweets)
      processCountry(article);
    }
  }

  function fullScan() {
    if (document.hidden) return;
    var articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (var a of articles) dirtyArticles.add(a);
    process();
  }

  // Debounced MutationObserver: re-scan only the articles that changed
  var timer = null;
  var observer = new MutationObserver(function (mutations) {
    for (var m of mutations) {
      markDirty(m.target);
      var added = m.addedNodes;
      for (var nodeIndex = 0; nodeIndex < added.length; nodeIndex++) markDirty(added[nodeIndex]);
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(process, 400);
  });

  function start() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    fullScan();
    setInterval(fullScan, 3000); // slow fallback, covers attribute-only changes
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
