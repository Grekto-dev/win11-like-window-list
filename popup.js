// Shared helpers for the chrome popups (tooltip, thumbnail flyout, jump list).
const { St } = imports.gi;
const Main = imports.ui.main;

const MARGIN = 8; // minimum distance from the monitor edge

function monitorRect(actor) {
    const mon = Main.layoutManager.findMonitorForActor(actor) || Main.layoutManager.primaryMonitor;
    return { x: mon.x, y: mon.y, width: mon.width, height: mon.height };
}

// Position of a popup of size (w, h) next to `anchor`, on the side facing away
// from the panel, centred on the anchor and clamped to its monitor.
// `applet` supplies the panel orientation and the panel's own geometry.
function placeNear(applet, anchor, w, h, gap) {
    const mon = monitorRect(anchor);
    const [ax, ay] = anchor.get_transformed_position();
    const [aw, ah] = anchor.get_transformed_size();
    // Anchor to the panel itself (the applet actor can be taller than the bar).
    const bar = applet.panel ? applet.panel.actor : applet.actor;
    const [px, py] = bar.get_transformed_position();
    const [pw, ph] = bar.get_transformed_size();
    let x;
    let y;

    switch (applet.orientation) {
        case St.Side.TOP:
            x = ax + aw / 2 - w / 2;
            y = py + ph + gap;
            break;
        case St.Side.LEFT:
            x = px + pw + gap;
            y = ay + ah / 2 - h / 2;
            break;
        case St.Side.RIGHT:
            x = px - gap - w;
            y = ay + ah / 2 - h / 2;
            break;
        default: // BOTTOM
            x = ax + aw / 2 - w / 2;
            y = py - gap - h;
    }

    x = Math.max(mon.x + MARGIN, Math.min(x, mon.x + mon.width - w - MARGIN));
    y = Math.max(mon.y + MARGIN, Math.min(y, mon.y + mon.height - h - MARGIN));
    return [Math.round(x), Math.round(y)];
}

// Direction the popup slides in from (pixels, scaled by the caller).
function slideOffset(applet, distance) {
    switch (applet.orientation) {
        case St.Side.TOP: return [0, -distance];
        case St.Side.LEFT: return [-distance, 0];
        case St.Side.RIGHT: return [distance, 0];
        default: return [0, distance];
    }
}

function preferredSize(actor) {
    const [, w] = actor.get_preferred_width(-1);
    const [, h] = actor.get_preferred_height(w);
    return [Math.ceil(w), Math.ceil(h)];
}

// Slides `actor` (already placed at its final position) out from under the panel, clipped by the
// panel edge, like the Windows 11 flyouts. `onDone` runs when finished (or at once without animation).
function revealFromPanel(applet, actor, duration, mode, onDone) {
    const finish = () => {
        actor.remove_clip();
        actor.translation_x = 0;
        actor.translation_y = 0;
        actor.opacity = 255;
        if (onDone) onDone();
    };
    if (!applet.animate || duration <= 0 || !applet.panel) {
        finish();
        return;
    }
    const [px, py] = applet.panel.actor.get_transformed_position();
    const [pw, ph] = applet.panel.actor.get_transformed_size();
    const [x, y] = actor.get_position();
    const [w, h] = preferredSize(actor);
    const side = applet.orientation;
    let from;
    let prop;
    let clip;
    switch (side) {
        case St.Side.TOP:
            prop = 'translation_y';
            from = (py + ph) - (y + h);
            clip = () => {
                const c = Math.max(0, (py + ph) - (y + actor.translation_y));
                actor.set_clip(0, c, w, Math.max(0, h - c));
            };
            break;
        case St.Side.LEFT:
            prop = 'translation_x';
            from = (px + pw) - (x + w);
            clip = () => {
                const c = Math.max(0, (px + pw) - (x + actor.translation_x));
                actor.set_clip(c, 0, Math.max(0, w - c), h);
            };
            break;
        case St.Side.RIGHT:
            prop = 'translation_x';
            from = px - x;
            clip = () => {
                const v = Math.max(0, px - (x + actor.translation_x));
                actor.set_clip(0, 0, v, h);
            };
            break;
        default:
            prop = 'translation_y';
            from = py - y;
            clip = () => {
                const v = Math.max(0, py - (y + actor.translation_y));
                actor.set_clip(0, 0, w, v);
            };
    }
    actor.remove_all_transitions();
    actor[prop] = from;
    actor.opacity = 255;
    clip();
    const target = { duration: duration, mode: mode, onUpdate: clip, onComplete: finish };
    target[prop] = 0;
    actor.ease(target);
}

module.exports = { placeNear, slideOffset, preferredSize, monitorRect, revealFromPanel };
