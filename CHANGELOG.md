## 1.1.0

New settings to turn off the parts of the applet that cost the most, for slow machines. Every one is
**on by default** (nothing changes unless you switch it off) and applies at once, with no reload.

*Hover and cards*
- **Show the window cards when hovering a button**: off → hovering shows only the app name; a click on a
  button with several windows still opens the cards. Turning it off closes cards opened by hover.
- **Show a thumbnail of each window in the cards**: off → compact rows (icon and title), no live
  thumbnails. Applies to cards that are open.
- **Show the app name in a tooltip** when hovering a button without cards.

*Peek, dragging, launcher*
- **Bring a window forward when a dragged file is held over its button**: off → the applet stops
  listening to drags from other programs.
- **Accept counts, progress and alerts that apps send to the launcher**: off → the applet stops
  listening to that D-Bus signal (some apps, such as browsers, send it many times a second during a
  download). Window progress and system notification counts are not affected.
- The existing peek, badges, progress bars and recent files switches stay as they were.

*Animations* (the master switch stays; four finer ones sit under it)
- **Fade button highlights and indicators**
- **Animate buttons opening, closing and moving**
- **Animate the cards, tooltips and the jump list**
- **Pulse buttons that ask for attention**: off → they stay lit.

The settings page *Hover and animations* is now split into *Hover cards*, *Peek*, *Dragging a file over
a button* and *Animations* (with the Portuguese translation of every new text).

Measured on the test machine with 20 windows (`tests/helpers/profile.py --lite`): an app sending 50
progress updates a second cost 250 ms of applet time per 8 s and the shell 29 % of a core; with the
launcher option off, 0 ms and 23 %. Visiting every button three times cost 263 ms of applet time (shell
45 %); with the cards, tooltips and peek off, 22 ms (shell 43 %). Focus changes cost the same either way
(the applet is already cheap there). See `docs/PERFORMANCE.md`.

Tests: `lite` section (each option proved at once through the settings file, and the whole applet still
working with everything off), `tests/helpers/profile.py --lite`.

## 1.0.5

Performance release: same features and the same look, a fraction of the work. See `docs/PERFORMANCE.md`
for the method and the numbers.

- A button is built from plain Clutter actors and two Cairo canvases instead of eleven St widgets
  (5 actors, none of them St): adding a button to the shell takes ≈ 0.3 ms instead of ≈ 5.3 ms.
- The applet's JavaScript time dropped to 2.5 ms for 30 s of idling (was 100 ms) and by 3.5–7x in the
  busy scenarios (window churn, focus changes, title spam, hovering).
- Buttons only update when something they show changed; helper windows of other programs (tooltips,
  menus) no longer cause refreshes; title changes are followed only for windows on show.
- Animations (tile fade, indicator, attention flash, indeterminate progress) run on the compositor's
  frame clock instead of timers; with animations off no timer or transition runs.
- The notification-count poll runs only while badges are enabled.
- The thumbnail flyout opens in about half the time and is not rebuilt when its windows did not change.
- Fix: with animations off, an attention flash no longer spins in a loop.
- Tests: `tests/helpers/profile.py` (the profiler), `loadwin.py`, `shots.py` (captures every visual state
  to compare two builds).

## 1.0.4

- **Language is now one setting for the whole applet.** Before, each bar had its own copy: changing it in the settings of one monitor left the other bar (and its jump list) in the old language. A change on any bar is applied to all of them at once.
- **Every text follows the applet's language, not the system's:** app names and the actions of the jump list (e.g. *Home / Computer / Trash* or *Pasta pessoal / Computador / Lixeira*) are read from the `.desktop` file in the chosen language, and the applet's right-click menu (*About / Configure / Remove*) is relabelled. Previously these stayed in the system language.
- Tests: `languageall` (several bars, desktop-file names, right-click menu) and `progress` (taskbar progress bar and indeterminate sweep) sections; `tests/helpers/reload.sh`.

## 1.0.3

- **Every setting now applies the moment it is changed**, including the language: the jump list switches at once and, if the settings window is open, it closes and reopens by itself in the new language (opening *Configure* twice just raises the existing window).
- Switching the peek style or turning peek off while a peek is showing takes effect on the running peek; turning *show progress* off hides bars already on screen.
- Fix: changing any setting used to rebuild the whole bar (Cinnamon reports the pinned list as changed on every write). Now it refreshes only when the pins really differ.
- Fix: the Portuguese catalogue is kept while another bar still uses Portuguese.
- Tests: `liveapply` (every option has an immediate effect) and `languagelive` (including the open settings window, read through AT-SPI) sections.

## 1.0.2

- **Fix: a pinned Flatpak app (e.g. Google Chrome) no longer disappears when its last window closes.** Cinnamon files Flatpak apps under an id with a suffix (`com.google.Chrome.desktop:flatpak`) that the plain lookup missed, so the pin was dropped as soon as the app stopped running.
- **Fix: a closing button no longer jumps to the start of the list for an instant.** The re-ordering after a close moved every live button behind the one still playing its closing animation; now it keeps its slot until it disappears.
- Tests: the live suite now drives one fixed bar when several exist, no longer depends on Chrome or Nemo windows being open, restores pins through the applet (they are shared between synchronised bars) and has a `closing` section.

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
