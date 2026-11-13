# Win11-Like Window List

A window list applet for the **Cinnamon** desktop that looks and behaves like the window buttons of the **Windows 11 taskbar**. Companion of [Win11-Like Cinnamon Menu](https://github.com/Grekto-dev/win11-like-cinnamon-menu).

Internal identifier: `win11-window-list@cinnamon`. Geometry, colours and behaviours were measured from a real Windows 11 24H2 installation; the numbers are in [docs/REFERENCE.md](docs/REFERENCE.md).

## What it reproduces

- **Buttons**: 40×40 tiles with 4 px radius, 24 px icons centred in the tile, 4 px gap. Hover, focused, focused + hover and pressed fills, and the icon shrinking while pressed.
- **Running indicator**: 6×3 grey pill for a running app, 16×3 accent pill for the focused window, none for a pinned app that is not running.
- **Several windows of one app**: the tile narrows and a second tile peeks out on its right.
- **Pinned apps**: pinned and running buttons mix freely, as on Windows; pin from the jump list, by dragging an app from the Start menu onto the bar (an empty slot opens where it will land), or by dragging. On first run the pins of Cinnamon's *Grouped window list* are imported.
- **Peek**: with the pointer on a thumbnail card for ~0.4 s the window is previewed in place (also if it is minimized); moving to another card crossfades; leaving the cards ends it. Two styles in the settings: *Only the window* (every other window fades away, the window appears alone over the desktop) or *Above the other windows* (nothing is hidden; the window is drawn over whatever is on screen). Can be switched off or its delay changed.
- **Language**: English (default) or Brazilian Portuguese, chosen in the settings; it covers the jump list and the settings window itself (`po/pt_BR.po`, compiled with `scripts/build-locale.sh`; the applet installs the catalogue under `~/.local/share/locale` only while Portuguese is selected).
- **Drag to reorder**: only the icon follows the pointer (enlarged, along the bar), neighbours slide aside, the icon settles on release; Esc does nothing, like Windows. Holding a file dragged from another window over a button brings that app's window forward (delay adjustable, 400 ms by default); over a button with several windows the thumbnails open and holding the file over one of them raises that window, so files can be dragged between two windows of the same app.
- **Icon size**: *Automatic* follows the bar (half its thickness, 24 px on a 48 px bar) or *Manual* (16 px up to the bar's size).
- **Several monitors**: *Synchronise monitors* makes every bar that has it on show the same windows, order and pinned apps.
- **Progress and badges**: a progress bar (windows' `_NET_WM_PROGRESS`, XApp progress and the Unity LauncherEntry protocol) replaces the indicator; the notification count and LauncherEntry counts show as a badge; LauncherEntry `urgent` flashes the button.
- **Recent files** in the jump list (follows the system privacy setting).
- **Click behaviour**: not running → launch (icon hops); one window → focus, or minimise if it already has focus; several windows → opens the thumbnail flyout, which stays open until you click elsewhere or press Esc. Middle click or Shift + click opens a new window.
- **Thumbnail flyout**: opens after 0.4 s of hover, follows the pointer from button to button, shows live previews with title and close button, peeks at the window under the pointer, middle click on a card closes that window. Falls back to a compact list when the cards do not fit the screen.
- **Jump list** (right click): the app's desktop actions under *Tasks*, the app itself, pin/unpin and close window(s); arrow keys, Enter and Esc work.
- **Text tooltip** for buttons without windows.
- **Attention**: the tile pulses orange and the indicator turns pink until the window gets focus.
- **Super + 1…9** activate the Nth button, **Super + Shift + 1…9** open a new window (can be turned off).
- Any panel position, panel scaling (HiDPI) and live settings.

The labels of the jump list follow the system language (Portuguese, Spanish, English).

## Not reproduced

Acrylic blur behind the flyouts (Cinnamon's `background-blur` crashes the shell here), dropping files on a button to open them, and the exact Windows easing curves (durations are approximations).

## Install (development)

```bash
git clone https://github.com/Grekto-dev/win11-like-window-list.git ~/win11-window-list
mkdir -p ~/.local/share/cinnamon/applets
ln -sfn ~/win11-window-list ~/.local/share/cinnamon/applets/win11-window-list@cinnamon
```

Then add **Win11-Like Window List** from *System Settings → Applets*. Remove or disable the *Grouped window list* on that panel to avoid two lists.

## Layout

| File | Role |
|---|---|
| `applet.js` | applet, window tracking, pinning, hotkeys, drag and drop |
| `taskButton.js` | one button: icon, indicator, progress, badge, attention flash |
| `tileArt.js` | the tile behind a button (fill + 1 px border per state) and the stacked back page of apps with several windows, drawn with Cairo |
| `dragController.js` | reordering by dragging the icon |
| `shared.js` | state shared by synchronised monitors, Super+N owner |
| `recent.js` | recent files for the jump list |
| `flyout.js` | thumbnail flyout and window peek |
| `contextMenu.js` | jump list |
| `tooltip.js`, `popup.js`, `i18n.js`, `util.js` | helpers |
| `stylesheet.css` | colours and radii |
| `docs/REFERENCE.md` | measurements taken from Windows 11 |

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
