// ============================================================================
// IN-PROCESS CACHES
//
// Short-lived copies of data that many players read and few writes change.
// Each one replaces a database round-trip on a hot path:
//
//   authUsers    the logged-in user, read by middleware/auth.js on EVERY API
//                request and by the socket handshake. Only _id, username, role,
//                isBanned and isActive are kept — never balance.
//   lobby        the open waiting rooms. Every player on the Lobby screen asks
//                for the same list every few seconds.
//   chatHistory  the last 100 chat messages. Same for everyone; reloaded on
//                every chat open, reconnect and return to the tab.
//   settings     public settings read by the chat screen (chat mode,
//                announcement).
//
// Every cache is cleared at the moment its data changes (see the
// invalidate calls next to each write), so the TTL is only a backstop for
// writes that happen somewhere we did not hook.
//
// ⚠️ NEVER CACHE MONEY. Wallet balance, transactions and live game state are
// read fresh on purpose — a stale balance is a double-spend, and a stale game
// state defeats the client watchdog that exists to repair desyncs.
//
// ⚠️ SINGLE INSTANCE ONLY — the same assumption diceSocket.js and the Socket.IO
// presence checks already make. Invalidation is a local Map delete; a second
// Railway instance would never hear about it. If the backend is ever scaled
// out, move these to Redis together with the Socket.IO adapter.
// ============================================================================

function createTtlCache({ ttlMs, maxEntries = 1000 }) {
  const entries  = new Map(); // key -> { value, expiresAt }
  const inflight = new Map(); // key -> promise of a load that is still running

  // Bumped by every invalidation. A load that started BEFORE an invalidation
  // must not store its (now stale) result after it.
  let generation = 0;

  function get(key) {
    const e = entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  function set(key, value) {
    entries.delete(key); // re-insert so this key becomes the newest
    if (entries.size >= maxEntries) {
      // Map iterates in insertion order, so the first key is the oldest.
      entries.delete(entries.keys().next().value);
    }
    entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  // Return the cached value, or run loader() ONCE and share its result with
  // every caller that asks while it is still running. Without the sharing, 50
  // players polling the lobby in the same second after an expiry would still
  // send 50 identical queries.
  //
  // null/undefined results are returned but never stored, so "not found" is
  // always re-checked.
  function wrap(key, loader) {
    const hit = get(key);
    if (hit !== undefined) return Promise.resolve(hit);

    const running = inflight.get(key);
    if (running) return running;

    const startGen = generation;
    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (value !== undefined && value !== null && generation === startGen) set(key, value);
        return value;
      })
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });

    inflight.set(key, promise);
    return promise;
  }

  function del(key) {
    generation++;
    entries.delete(key);
    inflight.delete(key);
  }

  function clear() {
    generation++;
    entries.clear();
    inflight.clear();
  }

  return { get, set, wrap, delete: del, clear };
}

const authUsers   = createTtlCache({ ttlMs: 30 * 1000, maxEntries: 5000 });
const lobby       = createTtlCache({ ttlMs: 3 * 1000,  maxEntries: 1 });
const chatHistory = createTtlCache({ ttlMs: 10 * 1000, maxEntries: 1 });
const settings    = createTtlCache({ ttlMs: 60 * 1000, maxEntries: 20 });

module.exports = { createTtlCache, authUsers, lobby, chatHistory, settings };
