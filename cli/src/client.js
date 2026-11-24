(() => {
  "use strict";

  function inferBaseContext() {
    const scriptEl = typeof document !== "undefined" ? document.currentScript : null;
    const rawSrc = scriptEl && typeof scriptEl.src === "string" ? scriptEl.src : "";
    const url = rawSrc
      ? new URL(rawSrc, window.location.href)
      : new URL(window.location.href);

    const match = url.pathname.match(/^(\/bp(?:-dev)?\/[^/]+)(?:\/bp\.js)?$/);
    const basePath = match
      ? match[1]
      : url.pathname.replace(/\/bp\.js$/, "").replace(/\/+$/, "");
    const mode = basePath.startsWith("/bp-dev/") ? "dev" : "prod";
    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProtocol}//${url.host}${basePath}/ws`;

    return { basePath, mode, wsUrl };
  }

  const { mode, wsUrl } = inferBaseContext();

  let ws = null;
  let hasOpenedOnce = false;
  let reconnectDelayMs = 500;
  let reconnectTimer = null;
  let nextReqId = 1;

  const outbox = [];
  const pending = new Map();
  const eventListeners = new Map();
  const watches = new Map();

  function safeInvoke(fn, ...args) {
    try {
      fn(...args);
    } catch (err) {
      console.error("[bp] listener error:", err);
    }
  }

  function flushOutbox() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (outbox.length > 0 && ws.readyState === WebSocket.OPEN) {
      const item = outbox.shift();
      const entry = pending.get(item.id);
      if (entry) {
        entry.sent = true;
      }
      ws.send(item.payload);
    }
  }

  function sendFrame(frame, { expectReply = true } = {}) {
    const id = expectReply ? nextReqId++ : undefined;
    const message = id !== undefined ? { ...frame, id } : frame;
    const payload = JSON.stringify(message);

    if (!expectReply) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      } else {
        outbox.push({ id: null, op: frame.op, query: frame.query, payload });
      }
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, op: frame.op, sent: false });
      if (ws && ws.readyState === WebSocket.OPEN) {
        pending.get(id).sent = true;
        ws.send(payload);
      } else {
        outbox.push({ id, op: frame.op, query: frame.query, payload });
      }
    });
  }

  function sendWatchSubscribe(query, entry) {
    sendFrame({ op: "watch", query })
      .then((res) => {
        if (watches.get(query) !== entry) return;
        const rows = Array.isArray(res && res.rows) ? res.rows : [];
        entry.lastRows = rows;
        for (const cb of [...entry.callbacks]) {
          if (entry.callbacks.has(cb)) {
            safeInvoke(cb, rows);
          }
        }
      })
      .catch((err) => {
        if (watches.get(query) === entry) {
          console.error(`[bp.watch] "${query}" failed:`, err && err.message ? err.message : err);
        }
      });
  }

  function handleMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.id !== undefined && pending.has(msg.id)) {
      const req = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) {
        req.resolve(msg);
      } else {
        req.reject(new Error(msg.error || "Blueprint request failed."));
      }
      return;
    }

    if (msg.op === "reload") {
      window.location.reload();
      return;
    }

    if (msg.op === "event" && typeof msg.event === "string") {
      const set = eventListeners.get(msg.event);
      if (set && set.size > 0) {
        for (const cb of [...set]) {
          if (set.has(cb)) {
            safeInvoke(cb, msg.data, msg);
          }
        }
      }
      return;
    }

    if (msg.op === "change" && typeof msg.query === "string") {
      const entry = watches.get(msg.query);
      if (entry) {
        const rows = Array.isArray(msg.rows) ? msg.rows : [];
        entry.lastRows = rows;
        for (const cb of [...entry.callbacks]) {
          if (entry.callbacks.has(cb)) {
            safeInvoke(cb, rows);
          }
        }
      }
      return;
    }

    if (msg.op === "error" && msg.message) {
      console.error("[bp]", msg.message);
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.addEventListener("open", () => {
      if (ws !== socket) return;
      const isReconnect = hasOpenedOnce;
      hasOpenedOnce = true;
      reconnectDelayMs = 500;

      flushOutbox();

      if (isReconnect) {
        for (const [query, entry] of watches.entries()) {
          const alreadyQueued = outbox.some((item) => item.op === "watch" && item.query === query);
          if (!alreadyQueued && entry.callbacks.size > 0) {
            sendWatchSubscribe(query, entry);
          }
        }
      }
    });

    socket.addEventListener("message", (event) => {
      if (ws !== socket) return;
      if (typeof event.data === "string") {
        handleMessage(event.data);
      }
    });

    socket.addEventListener("close", () => {
      if (ws !== socket) return;
      ws = null;
      for (const [id, req] of pending.entries()) {
        if (req.sent) {
          pending.delete(id);
          req.reject(new Error("WebSocket disconnected."));
        }
      }
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      // close event handles reconnect
    });
  }

  connect();

  const bp = {
    mode,

    emit(event, data) {
      if (typeof event !== "string" || event.trim().length === 0) {
        return Promise.reject(new Error('bp.emit(event, data) requires a non-empty "event" string.'));
      }
      return sendFrame({
        op: "emit",
        event: event.trim(),
        data: data === undefined ? null : data,
      }).then(() => undefined);
    },

    on(event, cb) {
      if (typeof event !== "string" || event.trim().length === 0) {
        throw new Error('bp.on(event, cb) requires a non-empty "event" string.');
      }
      if (typeof cb !== "function") {
        throw new Error("bp.on(event, cb) requires a callback function.");
      }
      const key = event.trim();
      let set = eventListeners.get(key);
      if (!set) {
        set = new Set();
        eventListeners.set(key, set);
      }
      set.add(cb);

      return () => {
        const cur = eventListeners.get(key);
        if (!cur) return;
        cur.delete(cb);
        if (cur.size === 0) {
          eventListeners.delete(key);
        }
      };
    },

    watch(query, cb) {
      if (typeof query !== "string" || query.trim().length === 0) {
        throw new Error("bp.watch(query, cb) requires a non-empty table name or SELECT query.");
      }
      if (typeof cb !== "function") {
        throw new Error("bp.watch(query, cb) requires a callback function.");
      }

      let entry = watches.get(query);
      if (entry) {
        entry.callbacks.add(cb);
        if (entry.lastRows !== undefined) {
          const snapshot = entry.lastRows;
          Promise.resolve().then(() => {
            if (watches.get(query) === entry && entry.callbacks.has(cb)) {
              safeInvoke(cb, snapshot);
            }
          });
        }
      } else {
        entry = { callbacks: new Set([cb]), lastRows: undefined };
        watches.set(query, entry);
        sendWatchSubscribe(query, entry);
      }

      return () => {
        const cur = watches.get(query);
        if (!cur) return;
        cur.callbacks.delete(cb);
        if (cur.callbacks.size === 0) {
          watches.delete(query);
          void sendFrame({ op: "unwatch", query }, { expectReply: false });
        }
      };
    },

    sql(sql, params) {
      if (typeof sql !== "string" || sql.trim().length === 0) {
        return Promise.reject(new Error("bp.sql(sql, params) requires a non-empty SQL query string."));
      }
      return sendFrame({
        op: "sql",
        sql,
        params: params === undefined ? null : params,
      }).then((res) => (Array.isArray(res && res.rows) ? res.rows : []));
    },
  };

  window.bp = bp;
})();
