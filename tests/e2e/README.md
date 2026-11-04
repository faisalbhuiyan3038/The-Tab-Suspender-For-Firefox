# End-to-end tests

Real-browser scenarios for the suspension lifecycle, driven with `puppeteer-core`:
Chrome for Testing (CDP) and Firefox (WebDriver BiDi). Nothing here is shipped.

```powershell
npm run test:e2e                       # everything (~6 min)
node tests/e2e/run.js chrome lifecycle # one browser / group
```

Groups: `lifecycle` (discard titles + thumbnails, update while running, browser restart, update at
browser start, unsuspend all), `beforeunload`, `preexisting` (Chrome screenshot of a tab opened
before install), `upgrade` (from an older build with suspended tabs).

Requirements: Chrome for Testing in `~/.cache/puppeteer/chrome/*` (or `CHROME_PATH`), Firefox at the
default install path (or `FIREFOX_PATH`). Each scenario group uses a fresh temporary profile and a
local HTTP server; the extension is staged unminified from the repo sources.

Environment: `E2E_SW_LOG=1` echoes the Chrome service worker console. `E2E_SRC=<dir>` runs against
another checkout (e.g. a `git worktree` of an older commit). `E2E_OLD_REF` sets the commit used by
the Chrome `upgrade` scenario (default `d5c83d5`); Firefox upgrades from `releases/v2.0-release.zip`.

How updates are simulated:
- Chrome: the extension is re-installed from the same directory through CDP `Extensions.loadUnpacked`
  (in-place update, `onInstalled` reason `update`). `chrome.runtime.reload()` is *not* used: it
  disables the extension first, which is a different path. An actual Web Store update was not
  reproduced locally.
- Firefox: a newer version is installed as a temporary add-on over the running one (in-place upgrade).
  Temporary add-ons don't survive a restart, so Firefox restart persistence is not covered.
