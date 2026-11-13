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
    const [px, py] = applet.actor.get_transformed_position();
    const [pw, ph] = applet.actor.get_transformed_size();
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

module.exports = { placeNear, slideOffset, preferredSize, monitorRect };
