# X Toolkit

Chrome extension toolkit for X.com (Twitter).

## Features

- **Video downloader** — one-click download button on every post with a video or animated GIF. Saves the highest-quality MP4 directly from the action bar.
- **Country filter** — hide posts (and quote-posts) from countries you choose, using X's own IP-inferred "About This Account" data. Manage blocked countries from the popup with real-time block counts.
- **Restore video click** — clicking a video plays / unmutes it instead of navigating away, the way it used to work.

## How it works

1. **`inject.js`** runs in the page's JavaScript context (MAIN world) and reads tweet data directly from React component props — no API calls, no authentication, no third-party services.
2. **`content.js`** (isolated world) watches the timeline via `MutationObserver`, injects the download button, applies the country filter (hiding resolved via the `AboutAccountQuery` GraphQL endpoint), and intercepts video clicks.
3. **`background.js`** (MV3 service worker) triggers downloads via `chrome.downloads.download()` and resolves country lookups through a bounded-parallel pool with caching.

## Installation

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select this folder
4. Navigate to any X.com post with a video — the download button appears automatically

## Development

```bash
npm install
npm run lint
npm run pack      # Builds .zip and .crx in dist/
npm run publish   # Tags release and publishes to GitHub
```
