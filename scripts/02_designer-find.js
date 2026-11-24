(() => {
  if (window.__centerSelectionHandler) {
    window.removeEventListener('keydown', window.__centerSelectionHandler, true);
  }
  if (window.__centerSelectionObserver) {
    window.__centerSelectionObserver.disconnect();
  }

  let autoFollow = false;

  // Zoom-to-fit: when ON, centering also zooms (via DesignerZoom) so the whole selection fits
  const FIT_KEY = '__designerFindZoomToFit';
  const FIT_PADDING = 0.9; // selection fills at most 90% of the visible area
  const FIT_MAX_ZOOM = 1;  // never zoom in past 100% when fitting
  let zoomToFit = false;
  try { zoomToFit = localStorage.getItem(FIT_KEY) === '1'; } catch {}

  const getSelected = () => Array.from(document.querySelectorAll(
    '.ia_designing__selection--selected, .view-parent.designing.selected'
  )).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  });

  const unionRect = (els) => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    });
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };

  // Nearest ancestor that actually scrolls (the designer canvas), else the document
  const findScroller = (el) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      const scrollY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      const scrollX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
      if (scrollX || scrollY) return node;
    }
    return document.scrollingElement || document.documentElement;
  };

  // Visible area of the scroller in viewport coordinates
  const visibleRect = (scroller) => {
    const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
    const r = isDoc
      ? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const right = Math.min(window.innerWidth, r.right);
    const bottom = Math.min(window.innerHeight, r.bottom);
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };

  // Scroll units per on-screen pixel. Measured (scroll a little, see how far the target
  // moved, scroll back) so it stays correct with CSS zoom from the zoom controls.
  const scrollRatio = (scroller, probe, axis) => {
    const prop = axis === 'x' ? 'scrollLeft' : 'scrollTop';
    const side = axis === 'x' ? 'left' : 'top';
    const before = scroller[prop];
    const prevBehavior = scroller.style.scrollBehavior;
    scroller.style.scrollBehavior = 'auto';
    let ratio = 1;
    for (const step of [50, -50]) {
      const start = probe.getBoundingClientRect()[side];
      scroller[prop] = before + step;
      const scrolled = scroller[prop] - before; // may be clamped at the edges
      const moved = start - probe.getBoundingClientRect()[side];
      scroller[prop] = before;
      if (Math.abs(moved) > 0.5 && scrolled !== 0) {
        ratio = scrolled / moved;
        break;
      }
    }
    scroller.style.scrollBehavior = prevBehavior;
    return Math.abs(ratio) > 0 && Number.isFinite(ratio) ? ratio : 1;
  };

  const panTo = (els) => {
    const scroller = findScroller(els[0]);
    const view = visibleRect(scroller);
    const sel = unionRect(els);
    const dx = (sel.left + sel.width / 2) - (view.left + view.width / 2);
    const dy = (sel.top + sel.height / 2) - (view.top + view.height / 2);
    scroller.scrollBy({
      left: dx * scrollRatio(scroller, els[0], 'x'),
      top: dy * scrollRatio(scroller, els[0], 'y'),
      behavior: 'smooth'
    });
  };

  // options.panOnly: skip zoom-to-fit (used by the zoom controls after a manual zoom)
  const centerSelected = (options = {}) => {
    const els = getSelected();
    if (!els.length) return false;

    const zoomApi = window.DesignerZoom;
    if (zoomToFit && !options.panOnly && zoomApi?.setZoom) {
      const scroller = findScroller(els[0]);
      const view = visibleRect(scroller);
      const sel = unionRect(els);
      if (sel.width > 0 && sel.height > 0 && view.width > 0 && view.height > 0) {
        const fit = Math.min(view.width * FIT_PADDING / sel.width, view.height * FIT_PADDING / sel.height);
        const target = Math.min(FIT_MAX_ZOOM, zoomApi.level * fit);
        if (Math.abs(target - zoomApi.level) / zoomApi.level > 0.02) {
          const before = zoomApi.level;
          zoomApi.setZoom(target); // the zoom controls pan to the selection after zooming
          if (zoomApi.level !== before) return true;
        }
      }
    }

    panTo(getSelected());
    return true;
  };

  const toggleZoomToFit = () => {
    zoomToFit = !zoomToFit;
    try { localStorage.setItem(FIT_KEY, zoomToFit ? '1' : '0'); } catch {}
    window.DesignerToolbar?.update('toggle-zoomtofit', {
      label: `Zoom-to-Fit: ${zoomToFit ? 'ON' : 'OFF'}`,
      active: zoomToFit
    });
    console.log(`[Center-F] Zoom-to-fit: ${zoomToFit ? 'ON' : 'OFF'}`);
  };

  const toggleAutoFollow = () => {
    autoFollow = !autoFollow;
    window.DesignerToolbar?.update('toggle-autofollow', {
      label: `Auto-Follow: ${autoFollow ? 'ON' : 'OFF'}`,
      active: autoFollow
    });
    console.log(`[Center-F] Auto-follow: ${autoFollow ? 'ON' : 'OFF'}`);
  };

  // Expose functions globally so any script or console command can call them
  window.DesignerFind = { centerSelected, toggleAutoFollow, toggleZoomToFit };

  // Register buttons on the top-left toolbar
  const registerButtons = () => {
    const addBtn = (cfg) => {
      if (window.DesignerToolbar) {
        window.DesignerToolbar.register(cfg);
      } else {
        window.__toolbarQueue = window.__toolbarQueue || [];
        window.__toolbarQueue.push(cfg);
      }
    };

    addBtn({
      id: 'center-selected',
      label: 'Center (F)',
      title: 'Center selected component in viewport (Shortcut: F)',
      onClick: () => centerSelected()
    });

    addBtn({
      id: 'toggle-autofollow',
      label: `Auto-Follow: ${autoFollow ? 'ON' : 'OFF'}`,
      title: 'Auto-center when selecting in Project Browser (Shortcut: Shift+F)',
      active: autoFollow,
      onClick: () => toggleAutoFollow()
    });

    addBtn({
      id: 'toggle-zoomtofit',
      label: `Zoom-to-Fit: ${zoomToFit ? 'ON' : 'OFF'}`,
      title: 'When centering, also zoom so the whole selection fits on screen (max 100%). Needs the zoom controls script. (Shortcut: Shift+Z)',
      active: zoomToFit,
      onClick: () => toggleZoomToFit()
    });
  };

  window.__centerSelectionHandler = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code !== 'KeyF' && e.code !== 'KeyZ') return;
    const tag = e.target?.tagName;
    if (e.target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA') return;

    // Shift + Z toggles zoom-to-fit
    if (e.code === 'KeyZ') {
      if (!e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      toggleZoomToFit();
      return;
    }

    if (e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleAutoFollow();
      return;
    }

    if (centerSelected()) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener('keydown', window.__centerSelectionHandler, true);

  let debounceTimer = null;
  window.__centerSelectionObserver = new MutationObserver((mutations) => {
    if (!autoFollow || document.hasFocus()) return;

    const selectionChanged = mutations.some(
      (m) => m.type === 'attributes' && m.target.classList?.contains('ia_designing__selection--selected')
    );
    if (selectionChanged) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(centerSelected, 50);
    }
  });

  const init = () => {
    if (!document.body) return;
    window.__centerSelectionObserver.observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
    registerButtons();
    console.log('[Center-F] Active.');
  };

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();