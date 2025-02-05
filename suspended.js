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

// Initialize the page
function init() {
  const params = getQueryParams();
  const origUrl = params.origUrl;
  const title = params.title;

  // Display the original URL
  document.getElementById('page-url').textContent = origUrl;

  // Set the page title
  document.title = `Suspended: ${title || origUrl}`;

  // Make the whole page clickable
  document.body.addEventListener('click', () => {
    if (origUrl) {
      browser.runtime.sendMessage({ action: "resumeTab", origUrl });
    }
  });
}

init();
