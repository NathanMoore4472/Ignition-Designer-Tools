(() => {
  // Zoom controls for the Perspective designer canvas.
  // Shortcuts: Alt + '=' zoom in, Alt + '-' zoom out, Alt + '0' reset.
  const HOST_ID = '__ignition-custom-toolbar-host';
  const LEVELS = [0.01, 0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  if (window.__zoomKeyHandler) {
    window.removeEventListener('keydown', window.__zoomKeyHandler, true);
  }

  // Keep the current level if the script is re-injected without a cleanup
  let zoom = window.__designerZoomLevel || 1;

  const label = () => `${Math.round(zoom * 100)}%`;

  const apply = () => {
    window.__designerZoomLevel = zoom;
    if (!document.body) return;

    // CSS zoom (unlike transform) affects layout, so scroll areas grow/shrink with the content
    document.body.style.zoom = zoom === 1 ? '' : String(zoom);

    // Counter-zoom the toolbar so it stays the same size and position
    const host = document.getElementById(HOST_ID);
    if (host) host.style.zoom = zoom === 1 ? '' : String(1 / zoom);

    window.DesignerToolbar?.update('zoom-reset', { label: label(), active: zoom !== 1 });

    // Keep the current selection in view after zooming, if designer-find is loaded
    // (pan only, so a manual zoom isn't immediately undone by zoom-to-fit)
    window.DesignerFind?.centerSelected?.({ panOnly: true });
  };

  const setZoom = (value) => {
    const next = Math.min(LEVELS[LEVELS.length - 1], Math.max(LEVELS[0], Number(value) || 1));
    if (next === zoom) return;
    zoom = next;
    apply();
    console.log(`[Zoom] ${label()}`);
  };

  const zoomIn = () => setZoom(LEVELS.find((l) => l > zoom + 0.001) ?? zoom);
  const zoomOut = () => setZoom([...LEVELS].reverse().find((l) => l < zoom - 0.001) ?? zoom);
  const resetZoom = () => setZoom(1);

  window.DesignerZoom = { zoomIn, zoomOut, resetZoom, setZoom, get level() { return zoom; } };

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
      id: 'zoom-out',
      label: '−',
      title: 'Zoom out (Shortcut: Alt+-)',
      onClick: zoomOut
    });

    addBtn({
      id: 'zoom-reset',
      label: label(),
      title: 'Reset zoom to 100% (Shortcut: Alt+0)',
      active: zoom !== 1,
      onClick: resetZoom
    });

    addBtn({
      id: 'zoom-in',
      label: '+',
      title: 'Zoom in (Shortcut: Alt+=)',
      onClick: zoomIn
    });
  };

  window.__zoomKeyHandler = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const tag = e.target?.tagName;
    if (e.target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA') return;

    let action = null;
    if (e.code === 'Equal' || e.code === 'NumpadAdd') action = zoomIn;
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') action = zoomOut;
    else if (e.code === 'Digit0' || e.code === 'Numpad0') action = resetZoom;
    if (!action) return;

    e.preventDefault();
    e.stopPropagation();
    action();
  };
  window.addEventListener('keydown', window.__zoomKeyHandler, true);

  const init = () => {
    if (!document.body) return;
    registerButtons();
    if (zoom !== 1) apply();
    console.log('[Zoom] Active (Alt+= / Alt+- / Alt+0).');
  };

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  }
})();
