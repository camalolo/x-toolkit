/* ==========================================================================
   X Video Downloader - inject.js
   Runs in the MAIN world to read React component props from the DOM and
   extract direct video URLs. Communicates findings to the content script
   via data attributes (shared between worlds).
   ========================================================================== */

(function () {
  var VIDEO_ATTR = 'data-xdl-url';
  var TWEET_ID_ATTR = 'data-xdl-tid';
  var DONE_ATTR = 'data-xdl-done';

  /* -- Helpers ---------------------------------------------------------- */

  function reactPropertiesKey(element) {
    var keys = Object.keys(element);
    for (const key of keys) {
      if (key.includes('reactProps')) return key;
    }
    return null;
  }

  /**
   * Pick the best-quality MP4 variant from a Twitter/X video_info block.
   */
  function bestVariant(variants) {
    var best = null;
    for (var v of variants) {
      if (v.content_type === 'video/mp4' && (!best || (v.bitrate || 0) > (best.bitrate || 0))) best = v;
    }
    return best || variants.at(-1);
  }

  function urlFromTweet(tweet) {
    if (!tweet) return null;
    var media = tweet.entities && tweet.entities.media;
    if ((!media || media.length === 0) && tweet.retweeted_status) {
      media = tweet.retweeted_status.entities && tweet.retweeted_status.entities.media;
    }
    if ((!media || media.length === 0) && tweet.quoted_status) {
      media = tweet.quoted_status.entities && tweet.quoted_status.entities.media;
    }
    if (!media) return null;
    for (var m of media) {
      if ((m.type === 'video' || m.type === 'animated_gif') && m.video_info && m.video_info.variants) {
        var v = bestVariant(m.video_info.variants);
        if (v && v.url) return v.url;
      }
    }
    return null;
  }

  /**
   * Walk the React props tree to find a tweet object that carries media.
   * Tries known fast paths first, then a bounded depth-first fallback.
   */
  function findTweet(properties) {
    // Fast paths — common React component tree locations
    var p = properties;
    var tries = [
      p && p.children && p.children[0] && p.children[0].props && p.children[0].props.children && p.children[0].props.children[0] && p.children[0].props.children[0].props && p.children[0].props.children[0].props.tweet,
      p && p.children && p.children[0] && p.children[0].props && p.children[0].props.tweet,
      p && p.children && p.children[1] && p.children[1].props && p.children[1].props.tweet,
    ];
    for (var t of tries) {
      if (t && ((t.entities && t.entities.media) || t.retweeted_status)) return t;
    }

    // Bounded fallback search (with cycle guard)
    return search(properties, 0, new Set());
  }

  function search(object, depth, visited) {
    if (!object || typeof object !== 'object' || depth > 7) return null;
    if (visited.has(object)) return null;
    visited.add(object);
    if (object.entities && object.entities.media) return object;
    if (object.retweeted_status && object.retweeted_status.entities && object.retweeted_status.entities.media) return object.retweeted_status;

    var followKeys = ['props', 'tweet', 'result', 'legacy', 'retweeted_status', 'quoted_status'];
    for (var k of followKeys) {
      if (object[k]) {
        var found = search(object[k], depth + 1, visited);
        if (found) return found;
      }
    }
    if (Array.isArray(object.children)) {
      for (var index_ = 0; index_ < object.children.length; index_++) {
        var f = search(object.children[index_], depth + 1, visited);
        if (f) return f;
      }
    }
    return null;
  }

  function getTweetId(article) {
    var link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    var match = (link.href || '').match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  /* -- Scanning --------------------------------------------------------- */

  function scanArticle(article) {
    var tid = getTweetId(article);
    var stored = article.getAttribute(TWEET_ID_ATTR);

    // Detect virtual-scroll recycling
    if (stored && tid && stored !== tid) {
      article.removeAttribute(VIDEO_ATTR);
      article.removeAttribute(DONE_ATTR);
    }

    if (article.hasAttribute(DONE_ATTR)) return;

    var labeled = article.querySelector('[aria-labelledby]');
    if (!labeled) return;

    var key = reactPropertiesKey(labeled);
    if (!key) return;

    var properties = labeled[key];
    if (!properties) return;

    var tweet = findTweet(properties);
    if (!tweet) return; // will retry next cycle

    var url = urlFromTweet(tweet);
    if (url) article.setAttribute(VIDEO_ATTR, url);
    if (tid) article.setAttribute(TWEET_ID_ATTR, tid);
    article.setAttribute(DONE_ATTR, '1');
  }

  function scanAll() {
    if (document.hidden) return; // skip rescans in background tabs
    try {
      var articles = document.querySelectorAll('article[data-testid="tweet"]');
      for (var index = 0; index < articles.length; index++) scanArticle(articles[index]);
    } catch { /* ignore */ }
  }

  // Listen for on-demand rescan from content script
  window.addEventListener('message', function (event) {
    if (event.source !== globalThis) return;
    if (event.data && event.data.type === 'XDL_RESCAN') scanAll();
  });

  scanAll();
  setInterval(scanAll, 1500);
})();
