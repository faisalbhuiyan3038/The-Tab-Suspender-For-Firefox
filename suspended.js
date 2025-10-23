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

function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

function init() {
  browser.storage.local.get(['darkMode']).then(result => {
    applyTheme(result.darkMode ?? false);
  });
  
  const params = getQueryParams();
  const origUrl = params.origUrl;
  const title = params.title;
  const favIconUrl = params.favIconUrl; 

  const defaultIcon = "icons/icon32.png";

  if (favIconUrl) {
    const link = document.getElementById('favicon-link');
    if (link) {
      link.href = favIconUrl;
      link.onerror = () => { link.href = defaultIcon; };
    }
  }

  const anchor = document.createElement('a');
  anchor.href = origUrl;
  anchor.textContent = origUrl;
  
  const pageUrlContainer = document.getElementById('page-url');
  if (pageUrlContainer) {
    pageUrlContainer.appendChild(anchor);
  }

  document.title = `💤 ${title || origUrl}`;

  document.body.addEventListener('click', () => {
    if (origUrl) {
      browser.runtime.sendMessage({ action: "resumeTab", origUrl });
    }
  });
}

init();

browser.runtime.onMessage.addListener((message) => {
  if (message.action === 'updateTheme') {
    applyTheme(message.isDark);
  }
});

