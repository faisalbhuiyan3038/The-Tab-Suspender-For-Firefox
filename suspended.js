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

// Displays the thumbnail and hides the default SVG
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

// Resizes a data: URL image using an in-memory canvas
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
      
      resolve(canvas.toDataURL('image/webp', quality));
    };
    img.onerror = (err) => {
      console.error("Image resize failed", err);
      reject(err);
    };
    img.src = dataUrl;
  });
}


async function init() {
  const params = getQueryParams();
  const origUrl = params.origUrl;
  const title = params.title;
  const favIconUrl = params.favIconUrl; 
  const tabId = params.tabId;
  const hasCapture = params.hasCapture === 'true';

  const [localSettings, syncSettings] = await Promise.all([
    browser.storage.local.get(['darkMode']),
    browser.storage.sync.get(['resizeWidth', 'resizeHeight', 'resizeQuality'])
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

  document.title = `💤 ${title || origUrl}`;

  document.body.addEventListener('click', () => {
    if (origUrl) {
      browser.runtime.sendMessage({ action: "resumeTab", origUrl });
    }
  });

  if (tabId) {
    try {
      const tabsData = await browser.storage.local.get('suspendedTabs');
      const allSuspended = tabsData.suspendedTabs || {};
      const tabInfo = allSuspended[tabId];

      if (tabInfo && tabInfo.thumbnail) {
        console.log("Displaying existing thumbnail");
        displayThumbnail(tabInfo.thumbnail);
      
      } else if (hasCapture && tabInfo) {
        console.log("Processing new screenshot...");
        const tempData = await browser.storage.local.get("temp_img_" + tabId);
        const fullResImage = tempData["temp_img_" + tabId];

        if (fullResImage) {
          const width = syncSettings.resizeWidth || 1280;
          const height = syncSettings.resizeHeight || 720;
          const quality = syncSettings.resizeQuality || 0.5;

          // Resize the image
          const smallDataUrl = await resizeImage(fullResImage, width, height, quality);
          
          // Save the small thumbnail to *permanent* storage
          tabInfo.thumbnail = smallDataUrl;
          await browser.storage.local.set({ suspendedTabs: allSuspended });
          
          // Display the new thumbnail
          displayThumbnail(smallDataUrl);
          
          // Clean up the large temporary image
          await browser.storage.local.remove("temp_img_" + tabId);
        }
      }
    } catch (error) {
      console.error("Error during screenshot processing:", error);
      // Clean up temp image just in case
      if (tabId) {
        await browser.storage.local.remove("temp_img_" + tabId);
      }
    }
  }
}

init();

browser.runtime.onMessage.addListener((message) => {
  if (message.action === 'updateTheme') {
    applyTheme(message.isDark);
  }
});

