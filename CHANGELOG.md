## 1.0.1

- **Monitors are synchronised by default.** Moving, pinning or unpinning buttons on one bar now changes every bar of the applet (other monitors) out of the box. Existing installs keep their saved choice; turn on *Synchronise monitors* in the settings.
- **Fix: turning synchronisation on no longer drops pins.** The pins of every bar are merged (union) instead of the first bar's list replacing the others.
- Live test for synchronised bars (drag on either bar, pin, unpin) and a unit check of the shared state.

## 1.0.0

First release. A window list for the Cinnamon panel that looks and behaves like the window buttons of the Windows 11 taskbar; geometry, colours and behaviours were measured on a Windows 11 24H2 installation (see `docs/REFERENCE.md`).

**Buttons**
- Centred 40×40 tiles with the measured fill and 1 px border per state (idle, hover, pressed, focused, focused + hover), running indicator (6 px grey / 16 px accent), launch bounce, attention flash (urgency hint and demands-attention).
- Several windows of one app: stacked "back page" drawn behind the tile, as in Windows 11.
- Pinned and running apps mix freely; pins persist and are imported from the Grouped window list on first run.
- Notification badge, progress bar (window progress, XApp, Unity LauncherEntry) and Super+1…9.

**Thumbnails and peek**
- Thumbnail flyout that slides from under the bar; peek on hover over a card in two styles (only that window, or above the others).
- Jump list with recent files, pin / unpin, close window / all windows.

**Drag and drop**
- Reorder by dragging the icon (neighbours slide aside), drag Start-menu entries to pin.
- Dragging a file over a button brings that window forward (adjustable delay); over a button with several windows the thumbnails open so files can be dragged between windows of the same app.

**Settings**
- Icon size: automatic or manual (16 px up to the bar's size); synchronise several monitors (same windows, order and pins); peek style and delays; animations; badges, progress and recent files.
- Languages: English (default) and Brazilian Portuguese, including the settings window.
- Works on horizontal and vertical panels.

Tested on Cinnamon 6.6.9 (X11). Install from the attached zip or with `./install.sh`.
