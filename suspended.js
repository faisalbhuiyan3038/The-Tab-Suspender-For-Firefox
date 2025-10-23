// suspended.js

// Get URL parameters
function getQueryParams() {
  let params = {};
  window.location.search.substr(1).split("&").forEach(function (item) {
    let [key, value] = item.split("=");
    if (key) {
      params[key] = decodeURIComponent(value);
    }
  });
  return params;
}

// Apply theme to document
function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

// Initialize the page
function init() {
  // Load and apply dark mode setting
  browser.storage.local.get(['darkMode']).then(result => {
    applyTheme(result.darkMode ?? false);
  });
  
  const params = getQueryParams();
  const origUrl = params.origUrl;
  const title = params.title;
  const favIconUrl = params.favIconUrl; // Get the favicon URL

  // --- NEW: Set Favicon ---
  const defaultIcon = "icons/icon32.png";

  if (favIconUrl) {
    // Set the page's own favicon (in the tab bar)
    const link = document.getElementById('favicon-link');
    if (link) {
      link.href = favIconUrl;
      // Add error handler to fall back to default
      link.onerror = () => { link.href = defaultIcon; };
    }
    // No <img> tag logic, as requested
  }

  // Display the original URL
  const anchor = document.createElement('a');
  anchor.href = origUrl;
  anchor.textContent = origUrl;
  
  const pageUrlContainer = document.getElementById('page-url');
  if (pageUrlContainer) {
    pageUrlContainer.appendChild(anchor);
  }

  // Set the page title
  document.title = `💤 ${title || origUrl}`;

  // Make the whole page clickable
  document.body.addEventListener('click', () => {
    if (origUrl) {
      browser.runtime.sendMessage({ action: "resumeTab", origUrl });
    }
  });
}

init();

// Listen for theme updates
browser.runtime.onMessage.addListener((message) => {
  if (message.action === 'updateTheme') {
    applyTheme(message.isDark);
  }
});

