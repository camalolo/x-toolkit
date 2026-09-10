# X Toolkit

## Architecture

Two content scripts with different world contexts:

| File | World | Role |
|------|-------|------|
| `inject.js` | MAIN | Reads React props from DOM, extracts video URLs, writes `data-xdl-url` attribute |
| `content.js` | ISOLATED | Injects download button UI, handles clicks, sends messages to background. Also handles country-based post filtering and video click interception |
| `background.js` | Service worker | Downloads video via `chrome.downloads.download()`. Fetches `AboutAccountQuery` GraphQL for country lookups |
| `popup.html/js/css` | Popup | Settings UI: video click toggle + country filter management |

Cross-world communication uses DOM attributes (shared between worlds) and `window.postMessage`.

## Key technical details

- **React props extraction**: `inject.js` finds elements with `__reactProps$*` keys and walks the component tree to locate tweet objects containing `entities.media[].video_info.variants`.
- **Video quality**: Picks the highest-bitrate MP4 variant from `video_info.variants`.
- **Virtual scroll handling**: Detects article recycling by comparing stored tweet ID with current URL; clears stale attributes when a tweet changes.
- **Button placement**: Inserted before the share button's container (last child of `[role="group"]` action bar).
- **Video click**: Capture-phase click listener on `document`; blocks navigation on video surfaces (excludes `[role="button"]`/slider controls) and directly toggles `video.muted`/`play()`/`pause()`. Gated by `xdl_video_click` (default on).

## Common issues

### Button not appearing
- Check that the tweet actually has a video (not just an image)
- The `inject.js` may need 1-2 seconds to scan new tweets after scroll
- React props path may change with X.com updates — check `findTweet()` in `inject.js`

### Download fails
- Ensure `https://video.twimg.com/*` is in `host_permissions`
- Check the browser console for `chrome.runtime.lastError` messages

## Publishing

```bash
npm run pack      # Build .zip and .crx
npm run publish   # Tag and release
```

## Country Filter Feature

Hides posts from countries the user chooses to block, using X's "About This Account" IP-inferred country data.

### Data flow
1. `content.js` extracts `screen_name` from the tweet's `<time>` permalink (stable vs. quoted-tweet links) + detects quoted-tweet author (status links outside `[data-testid="tweetText"]`)
2. Sends `XDL_LOOKUP` message with screen_name + CSRF token (from `ct0` cookie) to background
3. `background.js` fetches `AboutAccountQuery` GraphQL endpoint → `about_profile.account_based_in`
4. Result cached (in-memory Map + `chrome.storage.local`, pruned to 3000 entries) with 24h TTL; null results remembered (`countryUnknown`) to stop re-asking
5. Post hidden if author OR quoted-tweet author is from a blocked country — via inline `style.display:none !important` (React-proof), gated by a `data-xdl-status` lock that skips re-processing unchanged tweets

### Performance invariants (don't regress)
- Event-driven scanning: MutationObserver collects *dirty articles only*; full-scan fallback runs every 3s; both no-op when `document.hidden`
- `processCountry` is a no-op for a tweet whose status URL hasn't changed (flicker prevention)

### Storage schema (`chrome.storage.local`)
- `xdl_filter_enabled` (bool) — master toggle
- `xdl_blocked_countries` (string[]) — blocked country names
- `xdl_cache` (object) — `{ screenName: {country, accurate, ts} }`

### Known limitations
- **queryId fragility**: `AboutAccountQuery` queryId changes per X.com deploy. Two fallback IDs are hardcoded in `background.js` (`QUERY_IDS`). If lookups fail, check for a new queryId in X.com's JS bundles.
- **Rate limiting**: Sequential queue with 200ms delay between API calls. Heavy scrolling may temporarily exceed limits.
- **CSRF dependency**: Requires logged-in session (reads `ct0` cookie via `document.cookie`).
