// content.js — runs on every github.com page
// Detects profile pages, extracts public email from the DOM,
// and saves it to extension storage.

(function () {
  // Only run on user profile pages: github.com/username
  // Not on repos, orgs, settings, etc.
  const path = location.pathname;
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 1) return; // must be /username only
  if (parts[0].startsWith(".")) return;

  const username = parts[0];

  // --- Extract email from the profile DOM -----------------------------------
  // GitHub renders the public email in a <li> with an SVG mail icon.
  // The text content of the <li> is the email address.
  function extractEmail() {
    // Method 1: look for the email list item (GitHub's current markup)
    const emailLink = document.querySelector('a[href^="mailto:"]');
    if (emailLink) return emailLink.textContent.trim();

    // Method 2: look for li items containing @ in profile sidebar
    const items = document.querySelectorAll(".p-name, .p-email, [itemprop='email']");
    for (const el of items) {
      const text = el.textContent.trim();
      if (text.includes("@") && text.includes(".")) return text;
    }

    // Method 3: scan all sidebar list items for email pattern
    const lis = document.querySelectorAll("ul.vcard-details li");
    for (const li of lis) {
      const label = li.getAttribute("aria-label") || "";
      const text = li.textContent.trim();
      if (label.toLowerCase().includes("email") || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        return text;
      }
    }

    return null;
  }

  // --- Wait for profile sidebar to load, then extract ----------------------
  function tryExtract(attemptsLeft = 10) {
    const email = extractEmail();
    if (email) {
      saveEmail(username, email);
      showBadge(email);
      return;
    }
    if (attemptsLeft > 0) {
      setTimeout(() => tryExtract(attemptsLeft - 1), 500);
    }
  }

  // --- Save to extension storage -------------------------------------------
  function saveEmail(login, email) {
    chrome.storage.local.get(["emails"], (data) => {
      const emails = data.emails || [];
      const exists = emails.find((e) => e.login === login);
      if (!exists) {
        emails.unshift({
          login,
          email,
          profile: `https://github.com/${login}`,
          seen_at: new Date().toISOString(),
        });
        chrome.storage.local.set({ emails });
        // Notify background to update badge count
        chrome.runtime.sendMessage({ type: "EMAIL_FOUND", count: emails.length });
      }
    });
  }

  // --- Show a small floating badge on the page -----------------------------
  function showBadge(email) {
    if (document.getElementById("realman-badge")) return;
    const badge = document.createElement("div");
    badge.id = "realman-badge";
    badge.title = "Saved by Realman extension";
    badge.style.cssText = `
      position: fixed; bottom: 16px; right: 16px; z-index: 99999;
      background: #1f2328; color: #fff; border-radius: 8px;
      padding: 8px 14px; font: 13px/1.4 system-ui, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,.3); cursor: pointer;
      display: flex; align-items: center; gap: 8px;
    `;
    badge.innerHTML = `
      <span style="font-size:16px">✉️</span>
      <div>
        <div style="font-weight:600">Email saved</div>
        <div style="opacity:.75;font-size:11px">${email}</div>
      </div>
      <span style="margin-left:8px;opacity:.5;font-size:16px;cursor:pointer" id="realman-close">✕</span>
    `;
    document.body.appendChild(badge);
    badge.querySelector("#realman-close").addEventListener("click", (e) => {
      e.stopPropagation();
      badge.remove();
    });
    // Auto-hide after 4 seconds
    setTimeout(() => badge?.remove(), 4000);
  }

  tryExtract();
})();
