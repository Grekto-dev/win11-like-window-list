// State shared by all instances of the applet that have "synchronise monitors" on:
// pinned apps and the button order. Module state lives once per shell process.
const listeners = new Set();
const state = { ready: false, pinned: [], order: [] };

// An instance joins with its own saved pins. The first one seeds the shared state; later ones ADD
// what they had pinned (and any buttons they ordered) so turning the option on never drops pins that
// only one of the bars knew about.
function join(listener, seedPinned, seedOrder) {
    listeners.add(listener);
    if (!state.ready) {
        state.pinned = seedPinned.slice();
        state.order = seedOrder.slice();
        state.ready = true;
    } else {
        const newPins = seedPinned.filter(id => !state.pinned.includes(id));
        const newOrder = seedOrder.filter(id => !state.order.includes(id));
        if (newPins.length || newOrder.length) {
            state.pinned = state.pinned.concat(newPins);
            state.order = state.order.concat(newOrder);
            listeners.forEach(l => {
                if (l !== listener) l.onSharedChanged();
            });
        }
    }
    return { pinned: state.pinned.slice(), order: state.order.slice() };
}

function leave(listener) {
    listeners.delete(listener);
    if (listeners.size === 0) {
        state.ready = false;
        state.pinned = [];
        state.order = [];
    }
}

function snapshot() {
    return { pinned: state.pinned.slice(), order: state.order.slice() };
}

// `source` is told nothing; every other instance gets onSharedChanged().
function publish(source, pinned, order) {
    state.pinned = pinned.slice();
    state.order = order.slice();
    listeners.forEach(l => {
        if (l !== source) l.onSharedChanged();
    });
}

function count() {
    return listeners.size;
}

// ---- Super+N hotkeys: exactly one instance answers them (the one on the primary monitor, else the
// lowest instance id), so several bars never bind the same keys twice.
const hotkeyUsers = new Set();

function _balanceHotkeys() {
    let owner = null;
    hotkeyUsers.forEach(i => {
        if (i.isOnPrimary()) {
            if (!owner || !owner.isOnPrimary() || i.instanceId < owner.instanceId) owner = i;
        } else if (!owner || (!owner.isOnPrimary() && i.instanceId < owner.instanceId)) {
            owner = i;
        }
    });
    hotkeyUsers.forEach(i => i.setHotkeyOwner(i === owner));
}

function hotkeyRegister(inst) {
    hotkeyUsers.add(inst);
    _balanceHotkeys();
}

function hotkeyUnregister(inst) {
    hotkeyUsers.delete(inst);
    _balanceHotkeys();
}

module.exports = { join, leave, snapshot, publish, count, hotkeyRegister, hotkeyUnregister };
