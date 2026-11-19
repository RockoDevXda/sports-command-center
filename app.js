function copyTextSync(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.width = "2em";
  ta.style.height = "2em";
  ta.style.opacity = "0.01";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, 99999);
  try { document.execCommand("copy"); } catch (e) {}
  ta.remove();
}

function openSportsbookWithSlip() {
  if (!slip.length) return;
  const bkKey = document.getElementById("sportsbookSelect").value || "pp";
  const book = SPORTSBOOKS[bkKey] || SPORTSBOOKS.pp;
  const text = formatSlipForPlatform(book.mode);

  // Write to clipboard first while page still has active focus
  copyTextSync(text);

  const btn = document.getElementById("openBookBtn");
  btn.textContent = `✓ Copied! Launching ${book.name}...`;
  setTimeout(() => { btn.textContent = "🚀 Copy & Open App"; }, 2400);

  const ua = navigator.userAgent || "";
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);

  // Brief 180ms pause lets Android commit the clipboard before backgrounding Chrome
  setTimeout(() => {
    if (isMobile && book.scheme) {
      window.location.href = book.scheme;
      setTimeout(() => {
        if (!document.hidden) {
          window.location.href = book.web;
        }
      }, 1500);
    } else {
      window.open(book.web, "_blank", "noopener");
    }
  }, 180);
}
