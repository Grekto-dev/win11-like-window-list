# Performance

The applet runs inside the shell's own JavaScript thread, so whatever it does competes with every
frame the compositor draws. The goal is that it costs next to nothing while idle and only a few
milliseconds per event, so it stays smooth on slow hardware.

## How it is measured

`tests/helpers/profile.py` wraps the applet's methods inside the running shell (call count, total and
maximum time, counting only top-level entries so nested calls are not added twice) and drives real
windows through `tests/helpers/loadwin.py`:

| scenario | what happens |
|---|---|
| `idle` | 30 s with nothing going on |
| `churn` | 20 windows (10 apps) open and close, three times |
| `focus` | 80 focus changes across 20 windows |
| `title` | 20 windows rewrite their title 10 times a second (a terminal showing a command) |
| `hover` | the pointer visits every button three times |

Numbers are the applet's own JavaScript time on an i5-11400 (one core = 100 %); on an old machine
multiply by the CPU's slowness, the ratios stay.

| scenario | 1.0.4 | 1.0.5 |
|---|---|---|
| idle (30 s) | 100 ms (0.33 %) | 2.5 ms (0.01 %) |
| churn (14.6 s) | 693 ms (4.7 %) | 200 ms (1.4 %) |
| focus (9 s) | 985 ms (11.1 %) | 183 ms (2.0 %) |
| title (19 s) | 198 ms (1.0 %) | 27 ms (0.14 %) |
| hover (19 s) | 210 ms (1.1 %) | 28 ms (0.15 %) |

Other measurements on the same machine:

| | 1.0.4 | 1.0.5 |
|---|---|---|
| actors per button | 13 (11 St widgets) | 5 (no St widget) |
| adding a button to the shell | ≈ 5.3 ms | ≈ 0.3 ms |
| opening the thumbnail flyout (3 windows) | ≈ 24 ms | ≈ 13 ms |
| each `update()` of an unchanged button | ≈ 300 µs | ≈ 12 µs |

The look is unchanged: the same states were captured on both builds and compared pixel by pixel; the
only differences are four pixels at the rounded ends of the running indicator.

## What changed and why

* **No St widgets in a button.** Adding an `St.Widget` to the shell costs 0.4–1 ms because it resolves
  its style against the theme; a `Clutter.Actor` costs about 0.02 ms. A button is now one actor with
  two Cairo canvases (below the icon: tile, stacked page, attention flash; above it: running
  indicator, progress bar) and an icon texture from `St.TextureCache.load_gicon`. The notification
  badge needs text, so it is the only St widget and is created on first use. (`tileArt.js`)
* **State changes are diffed.** Every focus or window change used to re-apply every button; now each
  button returns at once unless something it shows changed, and the style classes that forced the
  theme to re-resolve a button's whole subtree are gone.
* **Signals are filtered at the source.** Tooltips, menus and other helper windows of other programs
  no longer trigger a refresh, and per-window signals are connected only for windows that can have a
  button. Title changes are followed only for windows whose card is open.
* **Animations run on the frame clock.** A `Clutter.Timeline` takes one step per drawn frame instead
  of a 16 ms timer, so a slow machine does not queue more work than it can show; the indeterminate
  progress sweep and the attention flash use it too. With animations off nothing runs at all.
* **Timers only while needed.** The notification-count poll runs only while badges are shown.
* **The thumbnail flyout is lighter and is not rebuilt for nothing.** A card has four St widgets
  instead of eight, and a refresh with the same windows keeps the cards (and a running peek).

## Options that turn work off (1.1.0)

Everything above is always on. On top of it, each optional feature has a switch (all on by default,
all applied at once). They exist for machines where even a few milliseconds per event or a
compositor busy with live thumbnails matters.

| Switch | What it stops doing |
|---|---|
| Show the window cards when hovering a button | opening the thumbnail card strip on hover (a click still opens it) |
| Show a thumbnail of each window in the cards | creating a live clone of every window; cards become rows |
| Show the app name in a tooltip | the tooltip over buttons without windows |
| Peek | hiding other windows / drawing a clone when the pointer is on a card |
| Bring a window forward when a dragged file is held over its button | listening to drags from other programs |
| Accept counts, progress and alerts that apps send to the launcher | listening to the Unity LauncherEntry D-Bus signal |
| Notification counts, progress bars, recent files | polling counts, drawing bars, reading the recent-files list |
| Four animation switches under the master one | tile and indicator fades; buttons opening / closing / moving; cards, tooltips and the jump list; the attention pulse |

Measured with `tests/helpers/profile.py --lite` against the defaults (20 windows, i5-11400; both bars
switched, three runs each, averages):

| scenario | applet JS, defaults | applet JS, options off | shell CPU, defaults → off |
|---|---|---|---|
| an app sending 50 launcher updates / s for 8 s | 250 ms | 0 ms | 29 % → 23 % |
| the pointer visits every button three times | 263 ms | 22 ms | 45 % → 43 % |
| 80 focus changes | 135 ms | 140 ms | 43 % → 43 % |

Focus changes cost the same because the cheap parts of the applet (previous section) are always on;
the switches matter when something keeps sending signals or the pointer keeps opening cards. The
shell's own CPU is a noisy figure (±2 points between runs of the same setup), so read the second
column first.

## Not done

* The jump list and the tooltip are still St menus; they are built when opened, not kept around.
* Fewer than about 30 buttons is assumed; nothing here is virtualised.
