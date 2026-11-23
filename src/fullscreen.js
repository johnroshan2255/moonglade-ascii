// Fullscreen handling.
//
// Browsers only allow hiding their UI (address bar, tabs) from inside a user gesture, so:
//  - the first tap/click/key ("begin") requests fullscreen on every device,
//  - on touch devices any later tap on the game re-enters fullscreen if the player swiped out,
//  - desktop gets a toggle button + F key and is never forced back in,
//  - when launched as an installed app (manifest display: fullscreen) there is no browser UI at all.
// iPhone Safari has no element Fullscreen API; there the home-screen app is the way to go.

const doc = document;
const root = doc.documentElement;

export const fullscreenSupported = !!(root.requestFullscreen || root.webkitRequestFullscreen) &&
  (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? true);

export function isFullscreen() {
  return !!(doc.fullscreenElement || doc.webkitFullscreenElement);
}

/** Launched from the home screen as an installed app (no browser chrome already). */
export function isInstalledApp() {
  return window.matchMedia?.('(display-mode: fullscreen)').matches ||
    window.matchMedia?.('(display-mode: standalone)').matches ||
    navigator.standalone === true;
}

export async function enterFullscreen() {
  if (!fullscreenSupported || isFullscreen()) return;
  try {
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    else root.webkitRequestFullscreen();
  } catch {
    return; // denied (not in a gesture, iframe without permission, ...) — harmless
  }
  // On phones, keep the current orientation so the browser doesn't rotate mid-game.
  try {
    const type = screen.orientation?.type;
    if (type) await screen.orientation.lock(type.startsWith('portrait') ? 'portrait' : 'landscape');
  } catch { /* lock unsupported (desktop / iOS) */ }
}

export async function exitFullscreen() {
  if (!isFullscreen()) return;
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else doc.webkitExitFullscreen();
  } catch { /* ignore */ }
}

export function toggleFullscreen() {
  return isFullscreen() ? exitFullscreen() : enterFullscreen();
}

/**
 * Wires the HUD button, F key, and the "force back into fullscreen" behaviour on touch devices.
 * onChange is called after any size-affecting change so the renderer can resize.
 */
export function setupFullscreen({ button, canvas, touchDevice, onChange }) {
  const sync = () => {
    if (button) {
      button.hidden = !fullscreenSupported || isInstalledApp();
      button.textContent = isFullscreen() ? '⤡' : '⤢';
      button.setAttribute('aria-label', isFullscreen() ? 'Exit fullscreen' : 'Fullscreen');
    }
    onChange();
  };
  doc.addEventListener('fullscreenchange', sync);
  doc.addEventListener('webkitfullscreenchange', sync);
  // mobile address bar showing/hiding changes the visual viewport without a window resize
  window.visualViewport?.addEventListener('resize', onChange);
  window.addEventListener('orientationchange', () => setTimeout(onChange, 250));

  button?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFullscreen();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF' && !(e.target instanceof HTMLSelectElement)) toggleFullscreen();
  });

  if (touchDevice) {
    // Phones: if the player swiped out of fullscreen, the next touch on the game puts it back.
    canvas.addEventListener('pointerup', () => {
      if (!isFullscreen() && !isInstalledApp()) enterFullscreen();
    });
  }
  sync();
}
