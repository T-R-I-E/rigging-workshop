import { NULL_HEX } from './hash.js';
const nullHex = NULL_HEX;
export function emptyState() {
    return {
        twist: new Map(),
        hitch: new Map(),
        rig: new Map(),
        'prev->ids': new Map(),
        'tether->ids': new Map(),
        'fast-ids': new Set(),
        'rigging-ids': new Set(),
        'incomplete-ids': new Set(),
        'end-ids': new Set(),
        'lead->hitch': new Map(),
        'meet->hitch': new Map(),
    };
}
export function createDb() {
    return { state: emptyState() };
}
// ── Index maintenance ──────────────────────────────────
function updateSetIndex(st, indexKey, id, pred, merged) {
    const set = st[indexKey];
    if (pred(merged))
        set.add(id);
    else
        set.delete(id);
}
function updateReverseIndex(st, indexKey, oldVal, newVal, entityId) {
    const idx = st[indexKey];
    if (oldVal && oldVal !== newVal) {
        const s = idx.get(oldVal);
        if (s)
            s.delete(entityId);
    }
    if (newVal) {
        let s = idx.get(newVal);
        if (!s) {
            s = new Set();
            idx.set(newVal, s);
        }
        s.add(entityId);
    }
}
function updateTwistIndexes(st, old, merged) {
    const id = merged['twist/id'];
    updateReverseIndex(st, 'prev->ids', old?.['twist/prev'], merged['twist/prev'], id);
    updateReverseIndex(st, 'tether->ids', old?.['twist/tether'], merged['twist/tether'], id);
    updateSetIndex(st, 'fast-ids', id, (e) => e['twist/fast'], merged);
    updateSetIndex(st, 'rigging-ids', id, (e) => !!e['twist/rigging'], merged);
    updateSetIndex(st, 'incomplete-ids', id, (e) => !!(e['twist/missing-atoms'] && e['twist/missing-atoms'].size > 0), merged);
    // end-ids
    if (!old && !(st['prev->ids'].get(id)?.size)) {
        st['end-ids'].add(id);
    }
    if (merged['twist/prev'] && (!old || !old['twist/prev'])) {
        st['end-ids'].delete(merged['twist/prev']);
    }
}
function updateHitchIndexes(st, _old, merged) {
    if (merged['hitch/lead'])
        st['lead->hitch'].set(merged['hitch/lead'], merged['hitch/id']);
    if (merged['hitch/meet'])
        st['meet->hitch'].set(merged['hitch/meet'], merged['hitch/id']);
}
// ── Upsert ─────────────────────────────────────────────
function upsertTwist(st, entity) {
    const id = entity['twist/id'];
    const old = st.twist.get(id);
    const merged = old ? { ...old, ...entity } : entity;
    st.twist.set(id, merged);
    updateTwistIndexes(st, old, merged);
}
function upsertHitch(st, entity) {
    const id = entity['hitch/id'];
    const old = st.hitch.get(id);
    const merged = old ? { ...old, ...entity } : entity;
    st.hitch.set(id, merged);
    updateHitchIndexes(st, old, merged);
}
function upsertRig(st, entity) {
    st.rig.set(entity['rig/id'], entity);
}
export function transact(conn, entities) {
    const st = conn.state;
    for (const entity of entities) {
        if (entity['node/type'] === 'twist')
            upsertTwist(st, entity);
        else if (entity['node/type'] === 'hitch')
            upsertHitch(st, entity);
        else if (entity['node/type'] === 'rig')
            upsertRig(st, entity);
    }
}
// ── Twist queries ──────────────────────────────────────
export function getTwist(conn, id) {
    return conn.state.twist.get(id);
}
export function allTwists(conn) {
    return [...conn.state.twist.values()];
}
export function nextTwistIds(conn, id) {
    return conn.state['prev->ids'].get(id);
}
export function endTwists(conn) {
    const st = conn.state;
    return [...st['end-ids']].map(id => st.twist.get(id)).filter(Boolean);
}
export function fastTwists(conn) {
    const st = conn.state;
    return [...st['fast-ids']].map(id => st.twist.get(id)).filter(Boolean);
}
export function incompleteTwists(conn) {
    const st = conn.state;
    return [...st['incomplete-ids']].map(id => st.twist.get(id)).filter(Boolean);
}
export function anyIncomplete(conn) {
    return conn.state['incomplete-ids'].size > 0;
}
export function twistsWithRigging(conn) {
    const st = conn.state;
    return [...st['rigging-ids']].map(id => st.twist.get(id)).filter(Boolean);
}
export function twistsByTether(conn, tetherId) {
    const st = conn.state;
    const ids = st['tether->ids'].get(tetherId);
    if (!ids)
        return [];
    return [...ids].map(id => st.twist.get(id)).filter(Boolean);
}
// ── Hitch queries ──────────────────────────────────────
export function getHitch(conn, id) {
    return conn.state.hitch.get(id);
}
export function allHitches(conn) {
    return [...conn.state.hitch.values()];
}
export function hitchForLead(conn, leadId) {
    const st = conn.state;
    const hid = st['lead->hitch'].get(leadId);
    return hid ? st.hitch.get(hid) : undefined;
}
export function hitchForMeet(conn, meetId) {
    const st = conn.state;
    const hid = st['meet->hitch'].get(meetId);
    return hid ? st.hitch.get(hid) : undefined;
}
// ── Rig queries ────────────────────────────────────────
export function getRig(conn, id) {
    return conn.state.rig.get(id);
}
export function allRigs(conn) {
    return [...conn.state.rig.values()];
}
