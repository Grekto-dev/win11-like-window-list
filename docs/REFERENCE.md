# Windows 11 taskbar buttons — measured reference

Source: Windows 11 24H2 pt-BR in the local KVM VM (`~/windows-vm`), 1440×900, 100 % scale, dark mode.
Frames were taken with `virsh screenshot` (no MCP overlay) and measured with PIL pixel scans.
Research kit: `~/taskbar-research` (`lib.py`, `qin.py`, `wmcp.py`, shots in `shots/`).

All numbers are CSS pixels at 100 % scale. Timings are approximations from ~4 fps captures
unless stated otherwise.

## Taskbar and buttons

| Item | Measurement |
|---|---|
| Taskbar height | 48 (y 852–899) |
| Button tile | 40 × 40, 4 px above and below, radius 4 |
| Button pitch | 44 (tile 40 + 4 gap) |
| App icon | 24 × 24, centred in the 40 px cell |
| Pressed icon | ≈ 20 px (scale ≈ 0.85) while the mouse button is down |
| Tile fill (white over taskbar) | hover ≈ 7 %, focused window ≈ 6.5 %, focused + hover ≈ 9.5 %, pressed ≈ 4.5 % |
| Running indicator, inactive | 6 × 3, colour ≈ white 55 %, rows 36–38 of the tile (1 px above tile bottom) |
| Running indicator, focused | 16 × 3, accent colour (`#4cc2ff` in dark mode) |
| Indicator, not running | none |
| Two or more windows | front tile shrinks to 35 px and a *back page* shows to its right. The page is a full-size 40×40 rounded tile (radius ≈ 4.5) *behind* the front tile; what shows is the part outside the front tile grown by a 2 px gap, so its inner edge follows the front tile's rounded corner (crescent: top row starts at x 35, from x 37 on at the sides, 3 px wide at mid height) and its outer corners are rounded. It has the same fill and border as the front tile and, like it, exists only on hover / focus (nothing at idle). Icon and indicator stay centred on the 40 px cell. Drawn with Cairo in `tileArt.js` (CSS cannot make this shape). |

**Tile states (measured, luminance over the bar, 40×40 tile, radius ≈ 4.5; the tile has a 1 px border):**

| State | Fill | Top row | Sides | Bottom row |
|---|---|---|---|---|
| idle | none | – | – | – |
| hover | +14 (≈ 6.5 % white) | +23 | +14 | +14 |
| pressed | +10 (≈ 4.5 %) | +10 | +10 | +10 |
| focused window | +14 | **+28** | +18 | +19 |
| focused + hover | +19.5 (≈ 8.8 %) | +23 | +19.5 | **+14** (darker than the fill) |

The applet reproduces these as white/black overlay alphas (see `LEVELS` in `tileArt.js`); a re-measurement on the Linux side gives top 28.4/23.3, mid 14/19, sides 18/19, bottom 21/15.8 for focused / focused+hover.
| Attention (flashing) | tile fill pulses orange (≈ `rgba(255,106,72,.45)` at peak) with a ≈ 2 s period; indicator turns pink `#ff99a4` |

## Behaviour (additions measured later in the same VM)

- **Aero Peek from the thumbnail.** Hovering the button opens the flyout; resting the pointer on a *card* for ~0.4 s (the "Delay before peeking" setting) fades every other window out (~120 ms) and shows only that window, in place, with the wallpaper and desktop icons visible; this also works for a minimized window (it stays minimized). The flyout stays on top. Moving to another card of the same flyout crossfades (~130 ms) with no new delay and no moment where all windows come back; leaving the cards, or clicking one (which activates the window), ends the peek (others fade back ~120 ms). Closing the flyout always ends it. Measured on frames `pkA`/`pkB` (4 fps captures), so the fade lengths are approximations.

- **Pinned and running buttons mix freely.** An unpinned running app can sit between pinned ones; a new window's app is appended at the end, a newly pinned app goes after the nearest earlier pinned one.
- **Drag to reorder.** Starts after the usual few pixels of movement. The tile and indicator vanish; the icon alone follows the pointer along the bar only (it never leaves it), slightly enlarged (~1.2x, approximation). Neighbours slide aside (~250 ms, ease-out) when the icon reaches their tile. On release the icon settles into its slot (~200 ms). Esc during the drag does nothing (the drag continues and drops on release). Releasing outside the bar still drops into the slot shown.
- **New button.** The group recentres as the slot opens (~180 ms), then the icon rises into place (~160 ms). **Closing:** the icon drops and fades (~130 ms) and the slot collapses (~200 ms).
- **Progress.** While an app reports progress the bar replaces the running indicator: a 1 px track as wide as the icon with a 3 px accent fill. Indeterminate progress sweeps a segment left to right on a ~1.1 s loop. Error/paused states change the fill colour (not reproduced: Linux has no equivalent state).
- **Badge.** Windows' overlay icon / notification count is a ~16 px accent circle at the icon's top-right corner, bold number in black (Linux counterpart: notification count of the app and the Unity LauncherEntry `count`).
- **Flyout / jump list motion.** Both slide up from under the bar, clipped by it: flyout ≈ 250 ms, jump list ≈ 150–200 ms, strong ease-out; closing is a quick fade (~50 ms).
- **Dragging a file from another window over a button.** Not reproducible in the reference VM: with the folder or `.txt` file held (and wiggled) over the Terminal, Explorer (2 windows) and Notepad (2 windows) buttons for 4+ s (frames `ddA`–`ddE`), Windows 11 24H2 neither raised the window nor opened the thumbnails. The applet therefore uses its own, adjustable timing (setting *Delay before bringing a window forward while dragging an item over it*, default 400 ms): over a one-window button the window comes forward; over a multi-window button the flyout opens and holding the item on one of its cards raises that window, so a file can be dragged from one window of an app to another window of the same app.

## Behaviour

- Click, not running: launches the app. Icon pops up a few px (launch feedback), indicator appears when the window maps.
- Click, one window: not focused → activate (restores if minimised); focused → minimise.
- Click, two or more windows: opens the thumbnail flyout and keeps it open (sticky) until a click elsewhere, Esc, or a window is chosen. Focus does not change.
- Middle click: new window of the app (also Shift + click).
- Right click: jump list (see below).
- Hover: thumbnail flyout after ≈ 0.4 s; closes ≈ 0.3 s after the pointer leaves both button and flyout. Moving to another running button while a flyout is open switches immediately. Not-running pinned buttons show a text tooltip after ≈ 0.7 s.
- Hovering a flyout card shows a live peek of that window (Aero Peek) and a close ✕ on the card.
- Middle click on a card closes the window.
- Dragging a button reorders; pinned buttons stay left of unpinned running ones.
- Attention request: the button flashes until the window is focused.
- New buttons appear at the right end of the running ones; the whole group stays centred.

## Thumbnail flyout

| Item | Measurement |
|---|---|
| Position | centred on the button, bottom edge 13 px above the taskbar |
| Card | 216 px wide, 8 px padding; header (icon 16, title 13 px, ✕ 24×24 on hover) then preview |
| Preview | 200 px wide, height from the window aspect (1139×600 → 105) |
| Cards | abut each other, no gap; two windows → 431 px |
| Flyout | radius 8, opaque dark (≈ `rgb(43,46,53)`), 1 px border ≈ white 5 % |
| Card hover | white ≈ 6 % over the flyout |

## Jump list (right click)

| Item | Measurement |
|---|---|
| Position | centred on the button, bottom 14 px above the taskbar, width ≈ 294 |
| Row pitch | 32 (28 px pill + 2 px margins), radius 4, pill text 14 px |
| Header ("Tarefas") | 32 px, 12 px text, white ≈ 65 %, 16 px left inset |
| Item | icon 16 at x +16, text at x +44 |
| Separator | 9 px block, 1 px line |
| Content | `.desktop` Actions under "Tarefas", separator, app row (opens a new window), "Fixar/Desafixar da barra de tarefas", "Fechar janela" (running only; "Fechar todas as janelas" with several windows) |

## Tooltip

Text only, padding 8 px horizontal, ≈ 30 px high, bottom 13 px above the taskbar, centred on the button, radius 4.

## Not reproduced

- Acrylic blur behind flyouts and menus: Cinnamon's `background-blur` CSS crashes the shell on this machine (SIGABRT in `st_paint_background_blur_effect`), so the applet does not use it. The user's `win11-frosted-panel` extension is the place for blur.
- Dropping a file on a button to open it with that app (Cinnamon cannot receive external drops on panel actors; only the hover-to-raise part is done).
- Progress error/paused colours, taskbar thumbnail toolbar buttons, Windows' exact easing curves (durations above are approximations from ~4 fps captures and 30 fps frame logs).
