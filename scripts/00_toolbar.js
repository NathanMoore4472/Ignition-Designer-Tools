(() => {
  const TOGGLE_KEY = '\\'; // Ctrl + \ toggles toolbar visibility
  const HIDDEN_KEY = '__designerToolbarHidden';
  const MODE_KEY = '__designerToolbarMode'; // 'docked' (in the ruler bar) | 'floating'
  const HOST_ID = '__ignition-custom-toolbar-host';
  const MENU_ID = '__ignition-custom-toolbar-menu';
  const RULER_SELECTOR = '.view-editor > .ruler-x';

  // ---- Tear down a previous instance (re-injection) ----
  document.getElementById(HOST_ID)?.remove();
  document.getElementById(MENU_ID)?.remove();
  if (window.__toolbarKeyHandler) {
    window.removeEventListener('keydown', window.__toolbarKeyHandler, true);
  }
  if (window.__toolbarZoomHandler) {
    window.removeEventListener('resize', window.__toolbarZoomHandler);
    window.visualViewport?.removeEventListener('resize', window.__toolbarZoomHandler);
  }
  if (window.__toolbarHiddenSync) {
    window.removeEventListener('storage', window.__toolbarHiddenSync);
    window.removeEventListener('focus', window.__toolbarHiddenSync);
  }
  if (window.__toolbarMenuCloser) {
    window.removeEventListener('pointerdown', window.__toolbarMenuCloser, true);
  }
  window.__toolbarDockObserver?.disconnect();

  window.__toolbarQueue = window.__toolbarQueue || [];

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;pointer-events:none;transform-origin:0 0;';

  // ---- Mode ----
  const readMode = () => {
    try { return localStorage.getItem(MODE_KEY) === 'floating' ? 'floating' : 'docked'; } catch { return 'docked'; }
  };
  let mode = readMode();
  const findRuler = () => document.querySelector(RULER_SELECTOR);
  // Where the toolbar actually is right now: docked only when a ruler exists to dock into
  const isDocked = () => host.parentElement?.matches?.(RULER_SELECTOR) === true;

  // ---- Floating position (draggable, remembered per gateway origin) ----
  const POS_KEY = '__designerToolbarPos';
  const DEFAULT_POS = { left: 8, top: 8 };
  let pos = { ...DEFAULT_POS };
  try {
    const saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) pos = saved;
  } catch {}

  const savePos = () => {
    try { localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch {}
  };

  // Keep the toolbar fully on-screen (e.g. after a window resize)
  const clampPos = () => {
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(0, window.innerWidth - rect.width);
    const maxTop = Math.max(0, window.innerHeight - rect.height);
    pos.left = Math.min(Math.max(0, pos.left), maxLeft);
    pos.top = Math.min(Math.max(0, pos.top), maxTop);
  };

  const applyPos = () => {
    host.style.left = `${pos.left}px`;
    host.style.top = `${pos.top}px`;
  };

  // ---- Floating size (independent of Designer zoom, remembered per gateway origin) ----
  // refDpr: the devicePixelRatio at which the toolbar renders at scale 1. It is saved once
  // (first run, or when the size is reset) so reloading at another Designer zoom level
  // no longer changes the toolbar size. userScale is changed deliberately via the handle.
  const SIZE_KEY = '__designerToolbarSize';
  const MIN_SCALE = 0.5;
  const MAX_SCALE = 3;
  let size = null;
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    if (saved && saved.refDpr > 0 && saved.userScale > 0) size = saved;
  } catch {}

  const saveSize = () => {
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(size)); } catch {}
  };

  // Estimate the devicePixelRatio the page would have at 100% Designer zoom (i.e. the
  // Windows display scaling). In Chromium, outerWidth is not affected by page zoom but
  // innerWidth is, so outerWidth / innerWidth ≈ current zoom level.
  const estimateBaseDpr = () => {
    const dpr = window.devicePixelRatio || 1;
    const outer = window.outerWidth;
    const inner = window.innerWidth;
    if (!(outer > 0 && inner > 0)) return { base: dpr, zoom: null };

    const zoom = outer / inner;
    let base = dpr / zoom;
    // Windows scaling comes in 25% steps; snap when close (absorbs any window-frame width)
    const snapped = Math.round(base * 4) / 4;
    if (Math.abs(base - snapped) < 0.06) base = snapped;
    // Sanity check, otherwise fall back to the current DPR
    if (!(base >= 0.5 && base <= 4)) return { base: dpr, zoom };
    return { base, zoom };
  };

  const resetSize = () => {
    const dpr = window.devicePixelRatio || 1;
    const { base, zoom } = estimateBaseDpr();
    size = { refDpr: base, userScale: 1 };
    saveSize();
    console.log(
      `[Toolbar] Size reset: dpr=${dpr}, outer/inner=${window.outerWidth}/${window.innerWidth}` +
      ` (zoom ~${zoom ? Math.round(zoom * 100) + '%' : 'unknown'}), base dpr=${base}`
    );
  };
  if (!size) resetSize();

  // Scale that renders the toolbar at its normal on-screen size at the current Designer zoom
  const baseScale = () => {
    const dpr = window.devicePixelRatio || 1;
    const vvScale = window.visualViewport?.scale || 1;
    const zoomFactor = (dpr / size.refDpr) * vvScale;
    return zoomFactor > 0 ? 1 / zoomFactor : 1;
  };

  // ---- Layout: put the host where the mode says, and size it ----
  const layoutFloating = () => {
    host.style.position = 'fixed';
    host.style.right = '';
    host.style.transformOrigin = '0 0';
    host.style.transform = `scale(${size.userScale * baseScale()})`;
    if (host.isConnected) {
      clampPos();
      applyPos();
    }
  };

  // Docked: sized to the ruler's height, but never smaller than 75% of the normal size so it
  // stays readable at low zoom (it then hangs slightly below the ruler).
  const layoutDocked = (ruler) => {
    host.style.position = 'absolute';
    host.style.left = 'auto';
    host.style.right = '4px';
    host.style.transformOrigin = '100% 0';
    host.style.transform = 'none';
    const natural = host.getBoundingClientRect().height;
    const rulerH = ruler.getBoundingClientRect().height;
    if (!(natural > 0 && rulerH > 0)) { host.style.top = '0px'; return; }
    const normal = baseScale();
    const scale = Math.min(normal * 1.5, Math.max(normal * 0.75, rulerH / natural));
    host.style.transform = `scale(${scale})`;
    host.style.top = `${Math.max(0, (rulerH - natural * scale) / 2)}px`;
  };

  let lastRulerH = -1;
  const relayout = () => {
    if (!document.body) return;
    const ruler = mode === 'docked' ? findRuler() : null;
    const target = ruler || document.body;
    if (host.parentElement !== target) target.appendChild(host);
    bar.classList.toggle('docked', Boolean(ruler));
    handle.title = ruler
      ? 'Right-click for options (float / dock) · Ctrl+\\ to hide/show'
      : 'Drag to move · Scroll to resize · Double-click to reset position and size · Right-click for options · Ctrl+\\ to hide/show';
    if (ruler) {
      lastRulerH = ruler.getBoundingClientRect().height;
      layoutDocked(ruler);
    } else {
      lastRulerH = -1;
      layoutFloating();
    }
  };

  const setMode = (next) => {
    mode = next === 'floating' ? 'floating' : 'docked';
    try { localStorage.setItem(MODE_KEY, mode); } catch {}
    relayout();
    console.log(`[Toolbar] Mode: ${mode} (all tabs)`);
  };

  window.__toolbarZoomHandler = relayout;
  window.addEventListener('resize', relayout);
  window.visualViewport?.addEventListener('resize', relayout);

  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .bar {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 6px;
        background: rgba(24, 26, 31, 0.92);
        border: 0px solid rgba(255, 255, 255, 0.14);
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 11px;
        pointer-events: auto;
        user-select: none;
        backdrop-filter: blur(4px);
        white-space: nowrap;
      }
      .bar.hidden { display: none; }
      button {
        appearance: none;
        background: #2b2f38;
        color: #e4e7ec;
        border: 0px solid rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s, color 0.12s;
        white-space: nowrap;
      }
      button:hover {
        background: #383e4a;
        border-color: rgba(255, 255, 255, 0.25);
      }
      button:active { transform: translateY(1px); }
      button.active {
        background: #1d4ed8;
        border-color: #60a5fa;
        color: #ffffff;
      }
      .hint {
        color: #8b949e;
        padding: 0 4px;
        font-size: 10px;
      }
      .handle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: grab;
        touch-action: none;
        border-radius: 4px;
        padding: 2px 4px 2px 2px;
      }
      .handle:hover { background: rgba(255, 255, 255, 0.06); }
      .handle.dragging { cursor: grabbing; }
      .grip {
        color: #6b7280;
        font-size: 12px;
        letter-spacing: -2px;
        line-height: 1;
      }

      /* Docked: compact strip that fits the 20px ruler bar */
      .bar.docked {
        gap: 2px;
        padding: 1px 2px;
        border-radius: 3px;
        box-shadow: none;
      }
      .bar.docked button {
        padding: 1px 6px;
        font-size: 10.5px;
        line-height: 14px;
        border-radius: 3px;
      }
      .bar.docked button:active { transform: none; }
      .bar.docked .handle { cursor: context-menu; padding: 0 2px; }
      .bar.docked .hint { display: none; }
      .bar.docked .grip { font-size: 11px; }
    </style>
    <div class="bar" id="bar">
      <span class="handle" id="handle">
        <span class="grip">⋮⋮</span><span class="hint">Tools</span>
      </span>
    </div>
  `;

  const bar = shadow.getElementById('bar');
  const handle = shadow.getElementById('handle');
  const buttons = new Map();

  // Prevent pointer/mouse events from stealing focus or bubbling into Perspective's canvas
  const blockFocusSteal = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const shieldEvents = (el) => {
    el.addEventListener('mousedown', blockFocusSteal);
    el.addEventListener('pointerdown', blockFocusSteal);
    el.addEventListener('mouseup', (e) => e.stopPropagation());
    el.addEventListener('pointerup', (e) => e.stopPropagation());
  };
  shieldEvents(bar);

  // ---- Right-click menu (rendered in its own fixed host so it is never clipped by the ruler) ----
  const menuHost = document.createElement('div');
  menuHost.id = MENU_ID;
  menuHost.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;display:none;transform-origin:0 0;';
  const menuShadow = menuHost.attachShadow({ mode: 'open' });
  menuShadow.innerHTML = `
    <style>
      .menu {
        min-width: 190px;
        padding: 4px;
        background: rgba(24, 26, 31, 0.97);
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 11px;
        color: #e4e7ec;
        user-select: none;
      }
      .item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 8px;
        border-radius: 4px;
        cursor: pointer;
        white-space: nowrap;
      }
      .item:hover { background: #383e4a; }
      .check { width: 10px; color: #60a5fa; }
      .key { margin-left: auto; color: #8b949e; font-size: 10px; }
      .sep { height: 1px; margin: 4px 2px; background: rgba(255, 255, 255, 0.1); }
      .item.disabled { color: #6b7280; cursor: default; }
      .item.disabled:hover { background: none; }
    </style>
    <div class="menu" id="menu">
      <div class="item" data-act="docked"><span class="check"></span>Dock in ruler bar</div>
      <div class="item" data-act="floating"><span class="check"></span>Floating (drag to move)</div>
      <div class="sep"></div>
      <div class="item" data-act="reset"><span class="check"></span>Reset floating position &amp; size</div>
      <div class="item" data-act="hide"><span class="check"></span>Hide toolbar<span class="key">Ctrl+\\</span></div>
    </div>
  `;
  const menu = menuShadow.getElementById('menu');
  shieldEvents(menu);

  const closeMenu = () => { menuHost.style.display = 'none'; };

  const openMenu = (x, y) => {
    menu.querySelectorAll('[data-act]').forEach((item) => {
      const act = item.dataset.act;
      item.querySelector('.check').textContent = act === mode ? '✓' : '';
      // Reset only applies to floating mode
      item.classList.toggle('disabled', act === 'reset' && mode !== 'floating');
    });
    if (!menuHost.isConnected) document.body.appendChild(menuHost);
    // Cancel the zoom controls' body zoom and the Designer zoom, like the floating toolbar
    const bodyZoom = parseFloat(document.body.style.zoom) || 1;
    menuHost.style.zoom = bodyZoom === 1 ? '' : String(1 / bodyZoom);
    menuHost.style.transform = `scale(${baseScale()})`;
    menuHost.style.display = 'block';
    const r = menuHost.getBoundingClientRect();
    menuHost.style.left = `${Math.max(0, Math.min(x, window.innerWidth - r.width))}px`;
    menuHost.style.top = `${Math.max(0, Math.min(y, window.innerHeight - r.height))}px`;
  };

  bar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(e.clientX, e.clientY);
  });
  menu.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });

  menu.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const item = e.target.closest?.('[data-act]');
    if (!item || item.classList.contains('disabled')) return;
    const act = item.dataset.act;
    closeMenu();
    if (act === 'docked' || act === 'floating') setMode(act);
    else if (act === 'reset') resetFloating();
    else if (act === 'hide') setHidden(true);
  });

  // Click anywhere else closes the menu
  window.__toolbarMenuCloser = (e) => {
    if (menuHost.style.display === 'none') return;
    if (!e.composedPath().includes(menuHost)) closeMenu();
  };
  window.addEventListener('pointerdown', window.__toolbarMenuCloser, true);

  // ---- Dragging via the "Tools" handle (floating only) ----
  let drag = null;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || isDocked()) return;
    drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, left: pos.left, top: pos.top };
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
  });

  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    e.stopPropagation();
    pos.left = drag.left + (e.clientX - drag.startX);
    pos.top = drag.top + (e.clientY - drag.startY);
    clampPos();
    applyPos();
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    handle.classList.remove('dragging');
    try { handle.releasePointerCapture(e.pointerId); } catch {}
    savePos();
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Mouse wheel over the handle resizes the toolbar (floating only)
  handle.addEventListener('wheel', (e) => {
    if (isDocked()) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.deltaY) return;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, size.userScale * factor));
    size.userScale = Math.round(next * 100) / 100;
    saveSize();
    relayout();
  }, { passive: false });

  // Reset position and size (size 1x at 100% Designer zoom)
  const resetFloating = () => {
    pos = { ...DEFAULT_POS };
    resetSize();
    savePos();
    relayout();
  };

  handle.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDocked()) resetFloating();
  });

  const renderButton = ({ id, label, title = '', active = false, onClick }) => {
    let btn = buttons.get(id);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.tabIndex = -1; // Exclude from Tab focus order
      btn.addEventListener('focus', () => btn.blur());
      bar.appendChild(btn);
      buttons.set(id, btn);
    }
    btn.textContent = label;
    btn.title = title;
    btn.classList.toggle('active', Boolean(active));
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick?.(btn);
    };
    return btn;
  };

  // ---- Hidden state (shared by every Designer tab on this gateway via localStorage) ----
  function readHidden() {
    try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
  }

  function setHidden(hidden) {
    bar.classList.toggle('hidden', Boolean(hidden));
    if (hidden) closeMenu();
    try { localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0'); } catch {}
    console.log(`[Toolbar] ${hidden ? 'Hidden' : 'Visible'} (all tabs)`);
  }

  window.DesignerToolbar = {
    register(config) {
      renderButton(config);
      relayout(); // toolbar width changed
    },
    update(id, updates) {
      const btn = buttons.get(id);
      if (!btn) return;
      if (updates.label !== undefined) btn.textContent = updates.label;
      if (updates.title !== undefined) btn.title = updates.title;
      if (updates.active !== undefined) btn.classList.toggle('active', Boolean(updates.active));
    },
    toggleVisibility() {
      setHidden(!bar.classList.contains('hidden'));
    },
    setHidden,
    setMode,
    get mode() { return mode; },
    relayout
  };

  // Other tabs: the 'storage' event fires when one tab changes a value. 'focus' is a
  // fallback re-check in case the embedded browser doesn't deliver storage events.
  window.__toolbarHiddenSync = (e) => {
    if (e?.type === 'storage' && e.key !== HIDDEN_KEY && e.key !== MODE_KEY) return;
    bar.classList.toggle('hidden', readHidden());
    const nextMode = readMode();
    if (nextMode !== mode) {
      mode = nextMode;
      relayout();
    }
  };
  window.addEventListener('storage', window.__toolbarHiddenSync);
  window.addEventListener('focus', window.__toolbarHiddenSync);
  bar.classList.toggle('hidden', readHidden());

  window.__toolbarKeyHandler = (e) => {
    if (e.key === 'Escape') closeMenu();
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === TOGGLE_KEY) {
      e.preventDefault();
      e.stopPropagation();
      window.DesignerToolbar.toggleVisibility();
    }
  };
  window.addEventListener('keydown', window.__toolbarKeyHandler, true);

  // ---- Stay docked when the Designer re-renders ----
  // The ruler can be created after us or replaced by React; re-check at most every 50ms.
  // (A timer rather than requestAnimationFrame, which doesn't run in hidden/background pages.)
  let checkQueued = false;
  const checkDock = () => {
    checkQueued = false;
    if (!document.body) return;
    const ruler = mode === 'docked' ? findRuler() : null;
    const target = ruler || document.body;
    if (host.parentElement !== target) {
      relayout();
    } else if (ruler && Math.abs(ruler.getBoundingClientRect().height - lastRulerH) > 0.5) {
      relayout(); // ruler resized (zoom)
    }
  };
  window.__toolbarDockObserver = new MutationObserver(() => {
    if (checkQueued) return;
    checkQueued = true;
    setTimeout(checkDock, 50);
  });

  const mount = () => {
    if (!document.body) return;
    while (window.__toolbarQueue.length) {
      renderButton(window.__toolbarQueue.shift());
    }
    relayout();
    window.__toolbarDockObserver.observe(document.body, { childList: true, subtree: true });
    console.log(`[Toolbar] Ready, ${isDocked() ? 'docked in ruler bar' : 'floating'} (Ctrl+\\ to toggle, right-click for options).`);
  };

  if (document.body) {
    mount();
  } else {
    window.addEventListener('DOMContentLoaded', mount, { once: true });
  }
})();
