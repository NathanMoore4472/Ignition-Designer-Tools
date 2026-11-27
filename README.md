# Ignition Designer Tools

Quality-of-life tools for the Ignition Perspective Designer: a floating toolbar, center/auto-follow on selection, and zoom controls.
They are injected automatically into every Designer session over the Chrome DevTools Protocol.

## Project structure

```
designer-tools/
├── auto-injector.py      # Background CDP watcher & console router
├── backgroundScript.py   # Runs auto-injector in the background (task tray icon for logs, reloading scripts and quitting)
├── designer-tools.vbs    # Starts backgroundScript.py with no console window
├── designer-tools.lnk    # Shortcut to the .vbs (adjust its target path, see below)
├── icon.ico              # Tray icon
└── scripts/
    ├── 00_toolbar.js         # Toolbar docked in the ruler bar or floating (Ctrl + \, right-click for options)
    ├── 01_zoom-controls.js   # Zoom in / out / reset (Alt+= / Alt+- / Alt+0)
    └── 02_designer-find.js   # Auto-follow & Center (F / Shift+F)
```

Every `.js` file in `scripts/` is injected automatically into each Designer session, in alphabetical order.
This means you can use numbered prefixes to change the order that icons appear in the toolbar.

Scripts add buttons to the toolbar with `window.DesignerToolbar.register({ id, label, title, active, onClick })`
(or push the same config onto `window.__toolbarQueue` if the toolbar hasn't loaded yet).

Logs are saved to `background_script.log` on each run; the log is cleared after every restart.
Upon quitting, a clean up is performed and the toolbar is removed from any Designer sessions.

## Features & shortcuts

### Toolbar

The toolbar has three modes. Right-click it to switch; the choice applies to all Designer tabs and is remembered.

- **Dock in ruler bar (default):** a compact strip at the left end of the view editor's top ruler. It sizes itself to the ruler and re-attaches if the Designer redraws the editor.
- **Dock above ruler:** its own strip across the top of the editor; the rulers and canvas are moved down to make room. Hiding the toolbar gives the space back.
- **Floating:** a free-floating bar you can drag anywhere over the Designer.

A toolbar icon always sits in the ruler corner (the square where the two rulers meet at 0,0). Click it to show or hide the toolbar; it is highlighted while the toolbar is showing.

| Shortcut | Action |
|---|---|
| `Ctrl + \` | Show / hide the toolbar — applies to all Designer tabs and is remembered until shown again |
| Click the ruler-corner icon | Show / hide the toolbar |
| Right-click the toolbar | Menu: Dock above ruler / Dock in ruler bar / Floating / Reset floating position & size / Hide toolbar |
| Drag the "⋮⋮ Tools" handle | Move the toolbar (floating; position is remembered) |
| Scroll over "⋮⋮ Tools" | Make the toolbar bigger / smaller (floating; size is remembered) |
| Double-click "⋮⋮ Tools" | Reset position to top-left and size to normal (floating; 100% zoom size) |

The floating toolbar keeps the same size when the Designer zoom changes, and stays on-screen when the window is resized.
Pages without a ruler bar fall back to floating.

From the console: `DesignerToolbar.setMode('docked' | 'above' | 'floating')`, `DesignerToolbar.setHidden(true | false)`.

### Center / Auto-Follow / Zoom-to-Fit

| Shortcut | Action |
|---|---|
| `F` | Center the selected component(s) in the viewport (multi-select centers the whole group) |
| `Shift + F` | Toggle Auto-Follow (auto-center when selecting in the Project Browser) |
| `Shift + Z` | Toggle Zoom-to-Fit (remembered) |

- **Zoom-to-Fit OFF:** centering only pans.
- **Zoom-to-Fit ON:** centering also zooms so the whole selection fits on screen (e.g. selecting a container shows all its children). Never zooms in past 100%. Requires the zoom controls script to be loaded too.

### Zoom

| Shortcut | Action |
|---|---|
| `Alt + =` | Zoom in |
| `Alt + -` | Zoom out |
| `Alt + 0` | Reset zoom to 100% |

Toolbar buttons: "−", current zoom % (click to reset), "+".
Zoom steps range from 1% to 300%. The selected component is re-centered after each zoom.

Also available from the console: `DesignerZoom.zoomIn()`, `.zoomOut()`, `.resetZoom()`, `.setZoom(1.5)`, `.level`

## Requirements

If you just want to manually paste `scripts/02_designer-find.js` into an external debugger, there are no prerequisites.

For auto-attaching to your Designer windows, with console messages routed to a command window, you need Python and `websockets`:

```
pip install websockets
```

To run in the background in the task tray you also need:

```
pip install Pillow pystray
```

## Running

### In a terminal

Open a terminal in the `designer-tools` folder (or Shift + right-click inside the folder > **Open in Terminal**), then run:

```
python auto-injector.py
```

### In the background (task tray)

Double-click `designer-tools.vbs`. An icon appears in your task tray; right-click it for:

| Menu item | Action |
|---|---|
| Show Terminal | Opens a live view of the log (also the default on double-click) |
| Reload Scripts | Cleans up all open Designer sessions, then re-injects the `scripts/` folder (picks up edits, new or deleted scripts without restarting the Designer) |
| Quit | Cleans up all Designer sessions and exits |

There is also a `designer-tools` shortcut that you can move wherever you like. Right-click it > **Properties** and change the target path to your install location.

## Download

Grab the latest zip from the [Releases](../../releases) page and extract it anywhere.
