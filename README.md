# Win11-Like Window List

A window list applet for the **Cinnamon** desktop that looks and behaves like the window buttons of the **Windows 11 taskbar**. Companion of [Win11-Like Cinnamon Menu](https://github.com/Grekto-dev/win11-like-cinnamon-menu).

Internal identifier: `win11-window-list@cinnamon`. Geometry, colours and behaviours were measured from a real Windows 11 24H2 installation; the numbers are in [docs/REFERENCE.md](docs/REFERENCE.md).

## What it reproduces

- **Buttons**: 40×40 tiles with 4 px radius, 24 px icons centred in the tile, 4 px gap. Hover, focused, focused + hover and pressed fills, and the icon shrinking while pressed.
- **Running indicator**: 6×3 grey pill for a running app, 16×3 accent pill for the focused window, none for a pinned app that is not running.
- **Several windows of one app**: the tile narrows and a second tile peeks out on its right.
- **Pinned apps**: stay on the left in their saved order; running apps that are not pinned follow. Drag to reorder (pinned buttons never cross unpinned ones). On first run the pins of Cinnamon's *Grouped window list* are imported.
- **Click behaviour**: not running → launch (icon hops); one window → focus, or minimise if it already has focus; several windows → opens the thumbnail flyout, which stays open until you click elsewhere or press Esc. Middle click or Shift + click opens a new window.
- **Thumbnail flyout**: opens after 0.4 s of hover, follows the pointer from button to button, shows live previews with title and close button, peeks at the window under the pointer, middle click on a card closes that window. Falls back to a compact list when the cards do not fit the screen.
- **Jump list** (right click): the app's desktop actions under *Tasks*, the app itself, pin/unpin and close window(s); arrow keys, Enter and Esc work.
- **Text tooltip** for buttons without windows.
- **Attention**: the tile pulses orange and the indicator turns pink until the window gets focus.
- **Super + 1…9** activate the Nth button, **Super + Shift + 1…9** open a new window (can be turned off).
- Any panel position, panel scaling (HiDPI) and live settings.

The labels of the jump list follow the system language (Portuguese, Spanish, English).

## Not reproduced

Acrylic blur behind the flyouts, recent files in jump lists, taskbar progress bars and badges, and the exact Windows easing curves (durations are approximations).

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
| `taskButton.js` | one button: tile, icon, indicator, attention flash |
| `flyout.js` | thumbnail flyout and window peek |
| `contextMenu.js` | jump list |
| `tooltip.js`, `popup.js`, `i18n.js`, `util.js` | helpers |
| `stylesheet.css` | colours and radii |
| `docs/REFERENCE.md` | measurements taken from Windows 11 |

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
