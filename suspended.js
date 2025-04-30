// suspended.js - Minimal changes needed

// Use 'chrome' namespace for consistency, though 'browser' often works
const api = typeof chrome !== "undefined" ? chrome : browser;

// Get URL parameters
function getQueryParams() {
  let params = {};
  // Use URLSearchParams for easier parsing
  const searchParams = new URLSearchParams(window.location.search);
  for (const [key, value] of searchParams.entries()) {
    params[key] = value; // Already decoded by URLSearchParams
  }
  return params;
}

// Apply theme to document
function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

// Initialize the page
function init() {
  // Load and apply dark mode setting from storage
  api.storage.local.get(['darkMode']).then(result => {
    applyTheme(result.darkMode ?? false); // Default to light if not set
  }).catch(error => console.error("Error getting dark mode setting:", error)); // Add error handling

  const params = getQueryParams();
  const origUrl = params.origUrl;
  const title = params.title || origUrl || "Suspended Tab"; // Use fallback title

  // Display the original URL and make it clickable
  const urlContainer = document.getElementById('page-url');
  if (origUrl) {
    const anchor = document.createElement('a');
    anchor.href = '#'; // Prevent default navigation, handled by click listener
    anchor.textContent = origUrl;
    anchor.title = `Click to restore: ${title}`; // Add tooltip
    urlContainer.innerHTML = ''; // Clear any placeholder
    urlContainer.appendChild(anchor);

    // Set the page title
    document.title = `Suspended: ${title}`;

    // Restore function
    const restoreTab = () => {
      console.log("Attempting to resume tab via message...");
      api.runtime.sendMessage({ action: "resumeTab", origUrl: origUrl })
        .catch(error => console.error("Error sending resumeTab message:", error)); // Add error handling for send message
    };

    // Make the link and body clickable to restore
    anchor.addEventListener('click', (e) => {
      e.preventDefault(); // Prevent '#' navigation
      restoreTab();
    });
    document.body.addEventListener('click', (e) => {
      // Only trigger restore if the click is directly on the body or the container,
      // not on the link itself (which has its own listener)
      if (e.target === document.body || e.target === urlContainer) {
        restoreTab();
      }
    });

    // Allow restoring with Enter key when link is focused
    anchor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        restoreTab();
      }
    });


  } else {
    urlContainer.textContent = "Error: Original URL not found.";
    document.title = "Suspended Tab - Error";
  }
}

// Run initialization when the DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init(); // Initialize directly if already loaded
}


// Listen for theme updates from the background script
api.runtime.onMessage.addListener((message, sender) => {
  // Check the action and ensure it's specifically for theme updates
  if (message.action === 'applyTheme' && typeof message.isDark !== 'undefined') {
    console.log("Received theme update:", message.isDark);
    applyTheme(message.isDark);
    // Optional: Send a response back to the background script if needed
    // return Promise.resolve({ status: "Theme updated" });
  } else if (message.action === 'updateTheme') {
    // This might come from the popup - handle similarly
    console.log("Received theme update (legacy action name?):", message.isDark);
    if (typeof message.isDark !== 'undefined') {
      applyTheme(message.isDark);
    }
  }
  // Return false or undefined for synchronous handling or if no response needed
  return false;
});
