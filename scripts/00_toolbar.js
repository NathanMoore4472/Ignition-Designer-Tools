(() => {
  const TOGGLE_KEY = '\\'; // Ctrl + \ toggles toolbar visibility
  const HIDDEN_KEY = '__designerToolbarHidden';

  document.getElementById('__ignition-custom-toolbar-host')?.remove();
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

  window.__toolbarQueue = window.__toolbarQueue || [];

  const host = document.createElement('div');
  host.id = '__ignition-custom-toolbar-host';
  host.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;pointer-events:none;transform-origin:0 0;';

  // ---- Position (draggable, remembered per gateway origin) ----
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

  // ---- Size (independent of Designer zoom, remembered per gateway origin) ----
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

  const syncZoomScale = () => {
    const dpr = window.devicePixelRatio || 1;
    const vvScale = window.visualViewport?.scale || 1;
    // Zoom factor relative to the saved reference DPR + any visual viewport scale
    const zoomFactor = (dpr / size.refDpr) * vvScale;
    const inverseScale = zoomFactor > 0 ? size.userScale / zoomFactor : size.userScale;
    host.style.transform = `scale(${inverseScale})`;
    if (host.isConnected) {
      clampPos();
      applyPos();
    }
  };

  window.__toolbarZoomHandler = syncZoomScale;
  window.addEventListener('resize', syncZoomScale);
  window.visualViewport?.addEventListener('resize', syncZoomScale);
  syncZoomScale();

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
    </style>
    <div class="bar" id="bar">
      <span class="handle" id="handle" title="Drag to move · Scroll to resize · Double-click to reset position and size · Ctrl+\\ to hide/show">
        <span class="grip">⋮⋮</span><span class="hint">Tools</span>
      </span>
    </div>
  `;

  const bar = shadow.getElementById('bar');
  const buttons = new Map();

  // Prevent pointer/mouse events from stealing focus or bubbling into Perspective's canvas
  const blockFocusSteal = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  bar.addEventListener('mousedown', blockFocusSteal);
  bar.addEventListener('pointerdown', blockFocusSteal);
  bar.addEventListener('mouseup', (e) => e.stopPropagation());
  bar.addEventListener('pointerup', (e) => e.stopPropagation());

  // ---- Dragging via the "Tools" handle ----
  const handle = shadow.getElementById('handle');
  let drag = null;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
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

  // Mouse wheel over the handle resizes the toolbar
  handle.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.deltaY) return;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, size.userScale * factor));
    size.userScale = Math.round(next * 100) / 100;
    saveSize();
    syncZoomScale();
  }, { passive: false });

  // Double-click resets position and size (size 1x at the current Designer zoom)
  handle.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    pos = { ...DEFAULT_POS };
    resetSize();
    syncZoomScale();
    applyPos();
    savePos();
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

  window.DesignerToolbar = {
    register(config) {
      renderButton(config);
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
    setHidden
  };

  // ---- Hidden state (shared by every Designer tab on this gateway via localStorage) ----
  function readHidden() {
    try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch { return false; }
  }

  function setHidden(hidden) {
    bar.classList.toggle('hidden', Boolean(hidden));
    try { localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0'); } catch {}
    console.log(`[Toolbar] ${hidden ? 'Hidden' : 'Visible'} (all tabs)`);
  }

  // Other tabs: the 'storage' event fires when one tab changes the value. 'focus' is a
  // fallback re-check in case the embedded browser doesn't deliver storage events.
  window.__toolbarHiddenSync = (e) => {
    if (e?.type === 'storage' && e.key !== HIDDEN_KEY) return;
    bar.classList.toggle('hidden', readHidden());
  };
  window.addEventListener('storage', window.__toolbarHiddenSync);
  window.addEventListener('focus', window.__toolbarHiddenSync);
  bar.classList.toggle('hidden', readHidden());

  window.__toolbarKeyHandler = (e) => {
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === TOGGLE_KEY) {
      e.preventDefault();
      e.stopPropagation();
      window.DesignerToolbar.toggleVisibility();
    }
  };
  window.addEventListener('keydown', window.__toolbarKeyHandler, true);

  const mount = () => {
    if (!document.body) return;
    document.body.appendChild(host);
    while (window.__toolbarQueue.length) {
      renderButton(window.__toolbarQueue.shift());
    }
    // Restore the saved position once the bar has its real size
    clampPos();
    applyPos();
    console.log('[Toolbar] Ready (Press Ctrl+\\ to toggle).');
  };

  if (document.body) {
    mount();
  } else {
    window.addEventListener('DOMContentLoaded', mount, { once: true });
  }
})();