let popupWindow = null;
let slideTimer = null;
let popupVisible = false;
let prevActiveWindow = null;
const ANIMATION_DURATION = 150; // ms
const ANIMATION_STEPS = 20;

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInCubic(t) { return t * t * t; }

function stopSlide() {
  if (slideTimer) {
    try { slideTimer.stop(); } catch (e) {}
    slideTimer = null;
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
  // popup opens where the user is looking. When hiding, target the
  // popup's own output so it slides off the monitor it is actually on.
  if (forShow) {
    if (workspace.activeWindow && workspace.activeWindow !== win && workspace.activeWindow.output) {
      return workspace.activeWindow.output;
    }
    if (workspace.activeOutput) {
      return workspace.activeOutput;
    }
    if (win && win.output) {
      return win.output;
    }
  } else {
    if (win && win.output) {
      return win.output;
    }
    if (workspace.activeWindow && workspace.activeWindow.output) {
      return workspace.activeWindow.output;
    }
    if (workspace.activeOutput) {
      return workspace.activeOutput;
    }
  }
  return workspace.outputs[0];
}

function getPopupGeometry(win, forShow) {
  const output = getTargetOutput(win, forShow);
  const geo = output.geometry;

  const width = Math.floor(geo.width / 3);
  const height = geo.height;
  const y = geo.y;
  const finalX = geo.x + geo.width - width;
  const offscreenX = geo.x + geo.width; // Off-screen right edge of target monitor

  return {
    width: width,
    height: height,
    y: y,
    finalX: finalX,
    offscreenX: offscreenX
  };
}

function getFarOffscreenX(popupGeo) {
  // Park beyond the right edge of ALL outputs so the hidden window can
  // never land on a neighboring monitor (no minimize, no animation).
  let maxRight = popupGeo.offscreenX;
  try {
    for (const o of workspace.outputs) {
      maxRight = Math.max(maxRight, o.geometry.x + o.geometry.width);
    }
  } catch (e) {}
  return maxRight + popupGeo.width + 10000; // margin survives hotplug
}

function animate(win, startX, endX, popupGeo, easingFunc, callback) {
  if (!win) return;

  // Kill any in-flight animation so rapid toggles don't fight over geometry.
  stopSlide();

  const startTime = new Date().getTime();

  win.keepAbove = true;

  const timer = new QTimer();
  slideTimer = timer;
  timer.interval = Math.max(1, Math.round(ANIMATION_DURATION / ANIMATION_STEPS));

  timer.timeout.connect(function () {
    // Superseded by a newer animation, or window gone.
    if (slideTimer !== timer || !popupWindow || win !== popupWindow) {
      try { timer.stop(); } catch (e) {}
      return;
    }
    const currentTime = new Date().getTime();
    const elapsed = currentTime - startTime;
    let progress = Math.min(1, elapsed / ANIMATION_DURATION);

    const easedProgress = easingFunc(progress);
    const currentX = Math.round(startX + (endX - startX) * easedProgress);

    win.frameGeometry = {
      x: currentX,
      y: popupGeo.y,
      width: popupGeo.width,
      height: popupGeo.height
    };

    if (progress >= 1) {
      try { timer.stop(); } catch (e) {}
      if (slideTimer === timer) slideTimer = null;
      if (callback) callback();
    }
  });

  timer.start();
}

function slideIn(win) {
  if (!win) return;
  popupVisible = true;
  // Target the currently focused monitor.
  const popupGeo = getPopupGeometry(win, true);

  // Reset to the target monitor's off-screen edge (not the far parking
  // position) so slide distance/speed stays consistent.
  win.opacity = 0;
  try { win.keepBelow = false; } catch (e) {}
  win.frameGeometry = {
    x: popupGeo.offscreenX,
    y: popupGeo.y,
    width: popupGeo.width,
    height: popupGeo.height
  };

  win.opacity = 1;
  animate(win, popupGeo.offscreenX, popupGeo.finalX, popupGeo, easeOutCubic);
}

function slideOut(win) {
  if (!win) return;
  popupVisible = false;

  // Give focus back before the window starts moving, so it never
  // rides along across the monitor boundary.
  restoreFocus(win);

  const popupGeo = getPopupGeometry(win);

  // Start from the actual position, not the assumed final position,
  // so mid-animation toggles don't jump.
  let startX = popupGeo.finalX;
  try { startX = win.frameGeometry.x; } catch (e) {}

  animate(win, startX, popupGeo.offscreenX, popupGeo, easeInCubic, function () {
    win.opacity = 0;
    // Park beyond all outputs so the hidden window can't receive clicks
    // when off-screen lands on a neighboring monitor. No minimize, so no
    // compositor minimize animation. Focus was already returned above.
    try { win.keepAbove = false; } catch (e) {}
    try { win.keepBelow = true; } catch (e) {}
    try {
      win.frameGeometry = {
        x: getFarOffscreenX(popupGeo),
        y: popupGeo.y,
        width: popupGeo.width,
        height: popupGeo.height
      };
    } catch (e) {}
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

    slideIn(win);

    win.closed.connect(function () {
      if (popupWindow === win) popupWindow = null;
      popupVisible = false;
      stopSlide();
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
      slideOut(popupWindow);
    } else {
      rememberFocus();
      slideIn(popupWindow);
      workspace.activeWindow = popupWindow;
    }
  }
);
