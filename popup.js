/* ==========================================================================
   X Toolkit - popup.js
   Settings popup: video click behavior, country filter with real-time
   block counts and new-country detection badges.
   ========================================================================== */

var seenCountries = [];

document.addEventListener('DOMContentLoaded', init);
document.addEventListener('pagehide', saveSeenCountries);

function init() {
  chrome.storage.local.get(['xdl_filter_enabled', 'xdl_seen_countries', 'xdl_video_click'], function (data) {
    seenCountries = data.xdl_seen_countries || [];

    var videoToggle = document.getElementById('videoClickToggle');
    videoToggle.checked = data.xdl_video_click !== false; // default: on
    videoToggle.addEventListener('change', function () {
      chrome.storage.local.set({ xdl_video_click: videoToggle.checked });
    });

    var toggle = document.getElementById('masterToggle');
    toggle.checked = !!data.xdl_filter_enabled;
    toggle.addEventListener('change', function () {
      chrome.storage.local.set({ xdl_filter_enabled: toggle.checked });
    });

    renderList();
  });

  // Real-time updates while popup is open
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.xdl_cache || changes.xdl_blocked_stats || changes.xdl_blocked_countries) {
      renderList();
    }
  });

  document.getElementById('clearCache').addEventListener('click', function () {
    chrome.storage.local.set({ xdl_cache: {}, xdl_blocked_stats: {} });
  });
}

function renderList() {
  chrome.storage.local.get(['xdl_cache', 'xdl_blocked_countries', 'xdl_blocked_stats'], function (data) {
    var cache = data.xdl_cache || {};
    var blocked = data.xdl_blocked_countries || [];
    var stats = data.xdl_blocked_stats || {};

    // Aggregate user counts per country
    var userCounts = {};
    for (var user in cache) {
      var entry = cache[user];
      if (!entry || !entry.country) continue;
      if (!userCounts[entry.country]) userCounts[entry.country] = 0;
      userCounts[entry.country]++;
    }

    var countries = Object.keys(userCounts).toSorted(function (a, b) {
      return userCounts[b] - userCounts[a];
    });

    var list = document.getElementById('countryList');
    list.innerHTML = '';

    if (countries.length === 0) {
      var empty = document.createElement('p');
      empty.className = 'empty';
      empty.innerHTML = 'No countries discovered yet.<br>Browse X.com to populate.';
      list.append(empty);
      return;
    }

    for (var index = 0; index < countries.length; index++) {
      var country = countries[index];
      var item = document.createElement('label');
      item.className = 'country-item';

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = blocked.includes(country);
      checkbox.dataset.country = country;
      checkbox.addEventListener('change', onToggle);

      var nameWrap = document.createElement('span');
      nameWrap.className = 'country-name';
      nameWrap.textContent = country;

      // NEW badge for countries not seen in previous popup sessions
      if (!seenCountries.includes(country)) {
        var badge = document.createElement('span');
        badge.className = 'new-badge';
        badge.textContent = 'NEW';
        nameWrap.append(badge);
      }

      // Meta: user count + block count
      var meta = document.createElement('span');
      meta.className = 'country-meta';
      var parts = [userCounts[country] + (userCounts[country] === 1 ? ' user' : ' users')];
      var blockCount = stats[country] || 0;
      if (blockCount > 0) {
        parts.push(blockCount + (blockCount === 1 ? ' blocked' : ' blocked'));
      }
      meta.textContent = parts.join(' \u00B7 ');

      item.append(checkbox, nameWrap, meta);
      list.append(item);
    }
  });
}

function onToggle(event) {
  var country = event.target.dataset.country;
  chrome.storage.local.get('xdl_blocked_countries', function (data) {
    var blocked = data.xdl_blocked_countries || [];
    if (event.target.checked) {
      if (!blocked.includes(country)) blocked.push(country);
    } else {
      blocked = blocked.filter(function (c) { return c !== country; });
    }
    chrome.storage.local.set({ xdl_blocked_countries: blocked });
  });
}

function saveSeenCountries() {
  chrome.storage.local.get('xdl_cache', function (data) {
    var cache = data.xdl_cache || {};
    var seen = {};
    for (var user in cache) {
      if (cache[user] && cache[user].country) seen[cache[user].country] = true;
    }
    chrome.storage.local.set({ xdl_seen_countries: Object.keys(seen) });
  });
}
