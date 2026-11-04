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

function displayThumbnail(dataUrl) {
  if (!dataUrl) return;
  try {
    document.body.style.backgroundImage = `url(${dataUrl})`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center center';
    document.body.classList.add('has-bg');

    // const logo = document.querySelector('.logo-container');
    // if (logo) {
    //   logo.style.display = 'none'; // Hide the SVG logo
    // }
  } catch (error) {
    console.error("Error applying thumbnail:", error);
  }
}

function resizeImage(dataUrl, maxWidth, maxHeight, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      // Simple scaling logic
      if (width > height) {
        if (width > maxWidth) {
          height = Math.round(height * (maxWidth / width));
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width = Math.round(width * (maxHeight / height));
          height = maxHeight;
        }
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      ctx.drawImage(img, 0, 0, width, height);

      // Export as low-quality WEBP for better compression
      resolve(canvas.toDataURL('image/webp', quality));
    };
    img.onerror = (err) => {
      console.error("Image resize failed", err);
      reject(err);
    };
    img.src = dataUrl;
  });
}


const pageParams = getQueryParams();

// Set the real title before anything asynchronous runs: if the tab is discarded or the browser
// restores it while storage is still being read, it must not be left as "Tab Suspended"
document.title = pageParams.title || pageParams.origUrl || document.title;

async function init() {
  const params = pageParams;
  const origUrl = params.origUrl;
  const title = params.title;
  const favIconUrl = params.favIconUrl;
  const tabId = params.tabId;
  const hasCapture = params.hasCapture === 'true';

  const [localSettings, syncSettings] = await Promise.all([
    chrome.storage.local.get(['darkMode']),
    chrome.storage.sync.get(['resizeWidth', 'resizeHeight', 'resizeQuality', 'suspendEmoji'])
  ]);

  applyTheme(localSettings.darkMode ?? false);

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

  const emoji = syncSettings.suspendEmoji === undefined ? 'none' : syncSettings.suspendEmoji;
  document.title = emoji === 'none' ? (title || origUrl) : `${emoji} ${title || origUrl}`;

  document.body.addEventListener('click', () => {
    if (origUrl) {
      chrome.runtime.sendMessage({ action: "resumeTab", origUrl });
    }
  });

  if (tabId) {
    try {
      const thumbData = await chrome.storage.local.get("thumbnail_" + tabId);
      const existingThumbnail = thumbData["thumbnail_" + tabId];

      // Case 1: Thumbnail already exists in storage
      if (existingThumbnail) {
        console.log("Displaying existing thumbnail");
        displayThumbnail(existingThumbnail);

        // Case 2: legacy URL (older versions stored the full screenshot for the page to resize)
      } else if (hasCapture) {
        console.log("Processing new screenshot...");
        const tempData = await chrome.storage.local.get("temp_img_" + tabId);
        const fullResImage = tempData["temp_img_" + tabId];

        if (fullResImage) {
          const width = syncSettings.resizeWidth || 1280;
          const height = syncSettings.resizeHeight || 720;
          const quality = syncSettings.resizeQuality || 0.5;

          const smallDataUrl = await resizeImage(fullResImage, width, height, quality);

          // Save the small thumbnail to *its own* key
          await chrome.storage.local.set({ ["thumbnail_" + tabId]: smallDataUrl });

          // Display the new thumbnail
          displayThumbnail(smallDataUrl);

          // Clean up the large temporary image
          await chrome.storage.local.remove("temp_img_" + tabId);
        }
      }
    } catch (error) {
      console.error("Error during screenshot processing:", error);
      // Clean up temp image just in case
      if (tabId) {
        await chrome.storage.local.remove("temp_img_" + tabId);
      }
    }
  }
}

// Tell the background the page is complete, so it can be discarded without losing its state
init()
  .catch(error => console.error("Error initializing suspended page:", error))
  .finally(() => {
    chrome.runtime.sendMessage({ action: 'suspendedPageReady' }).catch(() => {});
  });

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'updateTheme') {
    applyTheme(message.isDark);
  }
});
