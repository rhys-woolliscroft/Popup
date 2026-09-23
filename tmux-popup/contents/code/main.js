let popupWindow = null;
let fadeTimer = null;
let popupVisible = false;
let prevActiveWindow = null;
// Scaling is only (re)calculated on show, and only when the popup opens on
// a different monitor than last time. Hide never recalcs and never moves
// the window: it fades out in place, then minimizes. A minimized window is
// unmapped, so no output can claim it and no compositor rescale / TUI
// reflow happens while hidden.
let cachedShowGeo = null;
let lastShowOutputId = null;
const FADE_DURATION = 120; // ms
const FADE_STEPS = 10;
const SETTLE_MS = 50; // hidden settle so a scale configure lands before reveal

function stopFade() {
  if (fadeTimer) {
    try { fadeTimer.stop(); } catch (e) {}
    fadeTimer = null;
  }
}

function isValidWindow(win) {
  if (!win) return false;
  for (const w of workspace.stackingOrder) {
    if (w === win) return true;
  }
  return false;
}

function rememberFocus() {
  const current = workspace.activeWindow;
  if (current && current !== popupWindow) {
    prevActiveWindow = current;
  }
}

function restoreFocus(win) {
  // Only take focus back if the popup is still the active window, so we
  // don't yank the user away from something they switched to manually.
  if (workspace.activeWindow !== win) return;

  if (isValidWindow(prevActiveWindow)) {
    workspace.activeWindow = prevActiveWindow;
    return;
  }

  // Fall back to the first normal window in the stacking order.
  const order = workspace.stackingOrder;
  for (let i = order.length - 1; i >= 0; i--) {
    if (order[i] !== win && order[i].normalWindow) {
      workspace.activeWindow = order[i];
      return;
    }
  }

  workspace.activeWindow = null;
}

function getTargetOutput(win, forShow) {
  // When showing, target the currently focused window's monitor so the
  // popup opens where the user is looking.
  if (workspace.activeWindow && workspace.activeWindow !== win && workspace.activeWindow.output) {
    return workspace.activeWindow.output;
  }
  if (workspace.activeOutput) {
    return workspace.activeOutput;
  }
  if (win && win.output) {
    return win.output;
  }
  return workspace.outputs[0];
}

function outputId(output) {
  try {
    if (output && output.name) return String(output.name);
  } catch (e) {}
  try {
    const g = output.geometry;
    return g.x + ":" + g.y + ":" + g.width + "x" + g.height;
  } catch (e) {}
  return "unknown";
}

function isOutputAlive(id) {
  try {
    for (const o of workspace.outputs) {
      if (outputId(o) === id) return true;
    }
  } catch (e) {}
  return false;
}

function computeGeoForOutput(output) {
  const geo = output.geometry;
  const width = Math.floor(geo.width / 3);
  const height = geo.height;
  const y = geo.y;
  const finalX = geo.x + geo.width - width;
  return {
    width: width,
    height: height,
    y: y,
    finalX: finalX,
    outputId: outputId(output),
    srcGeo: { x: geo.x, y: geo.y, width: geo.width, height: geo.height }
  };
}

function getShowGeometry(win) {
  const output = getTargetOutput(win, true);
  const id = outputId(output);
  const geo = output.geometry;

  // Same monitor as last show: reuse cached scaling verbatim so the TUI
  // never sees a resize. Only recalc when the output is new, gone, or
  // its own geometry changed (resolution/rotation change).
  if (cachedShowGeo && lastShowOutputId === id && isOutputAlive(id)) {
    const s = cachedShowGeo.srcGeo;
    if (s && s.x === geo.x && s.y === geo.y && s.width === geo.width && s.height === geo.height) {
      return cachedShowGeo;
    }
  }

  const fresh = computeGeoForOutput(output);
  cachedShowGeo = fresh;
  lastShowOutputId = id;
  return fresh;
}

function getHideGeometry(win) {
  // Hide never recalcs sizing: fade in place, then teleport away.
  if (cachedShowGeo) return cachedShowGeo;
  // Fallback for hides before any cached show (should not happen):
  // snapshot the live rect.
  let w = 0, h = 0, y = 0, x = 0, srcGeo = null;
  try {
    const fg = win.frameGeometry;
    w = fg.width; h = fg.height; y = fg.y; x = fg.x;
  } catch (e) {}
  try {
    const out = (win && win.output) || workspace.activeOutput || workspace.outputs[0];
    const g = out.geometry;
    if (!w) w = Math.floor(g.width / 3);
    if (!h) h = g.height;
    srcGeo = { x: g.x, y: g.y, width: g.width, height: g.height };
  } catch (e) {}
  cachedShowGeo = {
    width: w, height: h, y: y, finalX: x,
    outputId: lastShowOutputId, srcGeo: srcGeo
  };
  return cachedShowGeo;
}

function setMinimized(win, minimized) {
  try { win.minimized = minimized; } catch (e) {}
}

function hideWindow(win) {
  // Fully invisible: minimize instead of moving. The window is unmapped,
  // so it keeps no output association and can be re-shown on any monitor
  // with at most one hidden configure (absorbed during SETTLE_MS).
  try { win.keepAbove = false; } catch (e) {}
  try { win.keepBelow = true; } catch (e) {}
  setMinimized(win, true);
}

function fade(win, from, to, callback) {
  if (!win) return;
  // Kill any in-flight fade so rapid toggles don't fight over opacity.
  stopFade();

  // No-op when already at target (e.g. opacity forced by compositor).
  if (from === to) {
    if (callback) callback();
    return;
  }

  const startTime = new Date().getTime();
  const timer = new QTimer();
  fadeTimer = timer;
  timer.interval = Math.max(1, Math.round(FADE_DURATION / FADE_STEPS));

  timer.timeout.connect(function () {
    // Superseded by a newer fade, or window gone.
    if (fadeTimer !== timer || !popupWindow || win !== popupWindow) {
      try { timer.stop(); } catch (e) {}
      return;
    }
    const elapsed = new Date().getTime() - startTime;
    const progress = Math.min(1, elapsed / FADE_DURATION);
    try { win.opacity = from + (to - from) * progress; } catch (e) {}

    if (progress >= 1) {
      try { timer.stop(); } catch (e) {}
      if (fadeTimer === timer) fadeTimer = null;
      if (callback) callback();
    }
  });

  timer.start();
}

function showPopup(win) {
  if (!win) return;
  popupVisible = true;
  // Sole recalc point: recomputes sizing only when opening on a new
  // monitor (see getShowGeometry cache).
  const popupGeo = getShowGeometry(win);

  stopFade();
  try { win.keepBelow = false; } catch (e) {}
  try { win.keepAbove = true; } catch (e) {}

  // Unminimize first (still invisible at opacity 0), then place straight
  // on the final rect: the window never travels across a monitor boundary.
  try { win.opacity = 0; } catch (e) {}
  setMinimized(win, false);
  try {
    try { workspace.sendClientToScreen(win, getTargetOutput(win, true)); } catch (e) {}
    win.frameGeometry = {
      x: popupGeo.finalX,
      y: popupGeo.y,
      width: popupGeo.width,
      height: popupGeo.height
    };
  } catch (e) {}

  // Let one hidden scale configure (if any) settle before revealing,
  // then fade in. Delayed start is its own one-shot timer so a rapid
  // toggle during settle still cancels cleanly via stopFade.
  const settle = new QTimer();
  fadeTimer = settle;
  settle.interval = SETTLE_MS;
  settle.timeout.connect(function () {
    if (fadeTimer !== settle || !popupWindow || win !== popupWindow) {
      try { settle.stop(); } catch (e) {}
      return;
    }
    try { settle.stop(); } catch (e) {}
    fadeTimer = null;
    // Window may have been hidden during settle; don't reveal then.
    if (!popupVisible || popupWindow !== win) return;
    fade(win, 0, 1);
  });
  settle.start();
}

function hidePopup(win) {
  if (!win) return;
  popupVisible = false;

  // Give focus back immediately; the fade happens in place underneath.
  restoreFocus(win);

  getHideGeometry(win); // ensure sizing cache exists; hide itself never moves/resizes
  stopFade();
  // Start from the live opacity so hiding mid-show-settle (still at 0)
  // doesn't flash up to 1 first.
  let from = 1;
  try { from = win.opacity; } catch (e) {}
  fade(win, from, 0, function () {
    if (popupVisible || popupWindow !== win) return;
    // Fully invisible: minimize. No position change, so no boundary
    // crossing and no rescale while hidden.
    hideWindow(win);
  });
}

// KWin 6 API window matching
workspace.windowAdded.connect(function (win) {
  if (!win) return;

  // Check both resourceClass and resourceName for Kitty matching
  const resClass = String(win.resourceClass || "").toLowerCase();
  const resName = String(win.resourceName || "").toLowerCase();

  if (resClass.includes("tmux-popup") || resName.includes("tmux-popup")) {
    popupWindow = win;

    // Remember what was focused before the popup steals it on creation.
    rememberFocus();

    win.skipTaskbar = true;
    win.skipPager = true;
    win.skipSwitcher = true;

    showPopup(win);

    win.closed.connect(function () {
      if (popupWindow === win) popupWindow = null;
      popupVisible = false;
      stopFade();
      cachedShowGeo = null;
      lastShowOutputId = null;
      restoreFocus(win);
    });
  }
});

// Register native global shortcut
registerShortcut(
  "ToggleMusicPopup",
  "Toggle Spotify Music Popup",
  "Meta+Z",
  function () {
    if (!popupWindow) return;

    if (popupVisible) {
      hidePopup(popupWindow);
    } else {
      rememberFocus();
      showPopup(popupWindow);
      workspace.activeWindow = popupWindow;
    }
  }
);
