/*!
 * pinprompt v0.3.1
 * Dev-only overlay: pick an element, leave a note, copy "location - note" lines for a coding agent.
 * Single file, no dependencies. See SPEC.md.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__PINPROMPT__) return;

  // Captured synchronously: currentScript is null once the script has finished running.
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || "/__dev/pinprompt.js";

  // ---------------------------------------------------------------- constants

  var VERSION = "0.3.1";
  var STORAGE_KEY = "pinprompt:v1";
  var HOST_ID = "pinprompt-host";
  var TEXT_MAX = 30;
  var PIN_SIZE = 20;
  var EDITOR_WIDTH = 280;
  var SOURCE_TIMEOUT_MS = 2000;
  var GRAB_WAIT_TRIES = 40; // wait up to 10s for React Grab to load
  var GRAB_WAIT_MS = 250;
  var TOAST_MS = 1500;
  var PATH_POLL_MS = 300;
  var BLOCKED_EVENTS = [
    "pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "contextmenu",
  ];

  // ---------------------------------------------------------------- state

  var docEl = document.documentElement;
  var items = loadItems();
  var pickMode = false;
  var listOpen = false;
  var hoverEl = null;
  var editor = null; // { node, input, el, item } while the popover is open
  var lastPath = location.pathname;
  var rafId = 0;
  var toastTimer = 0;
  var savedCursor = null; // { value, priority } of documentElement's inline cursor
  var elCache = new Map(); // item id -> element
  var pinEls = new Map(); // item id -> pin button
  var projectRoot = ""; // absolute project root, no trailing slash; "" while unknown

  // ---------------------------------------------------------------- small helpers

  function h(tag, props) {
    var el = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v == null || v === false) return;
      if (k === "class") el.className = v;
      else if (k.indexOf("on") === 0) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      if (arguments[i] != null) el.append(arguments[i]);
    }
    return el;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(n, max));
  }

  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, "\\$&");
  }

  function randomId() {
    if (window.crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  /** Collapse whitespace, trim, and cut to TEXT_MAX chars (+ "…"). Idempotent. */
  function clip(s) {
    var t = String(s == null ? "" : s).slice(0, 500).replace(/\s+/g, " ").trim();
    return t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) + "…" : t;
  }

  function onThisPage(item) {
    return item.path === location.pathname;
  }

  // ---------------------------------------------------------------- storage

  function normalizeItem(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.selector !== "string") return null;
    var s = raw.source;
    var source = s && typeof s === "object" && s.filePath
      ? {
          filePath: String(s.filePath),
          line: Number(s.line) || 0,
          column: Number(s.column) || 0,
          component: s.component ? String(s.component) : "",
        }
      : null;
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : randomId(),
      createdAt: Number(raw.createdAt) || Date.now(),
      path: typeof raw.path === "string" ? raw.path : "/",
      selector: raw.selector,
      tag: typeof raw.tag === "string" ? raw.tag : "",
      text: typeof raw.text === "string" ? raw.text : "",
      memo: typeof raw.memo === "string" ? raw.memo : "",
      source: source,
    };
  }

  function loadItems() {
    try {
      var parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeItem).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function saveItems() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch (e) {
      // Storage unavailable: keep notes in memory only.
    }
  }

  // ---------------------------------------------------------------- selector / element info

  /** Nearest element (self or ancestor) whose id is unique in the document. */
  function findIdAnchor(el) {
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id && document.querySelectorAll("#" + cssEscape(n.id)).length === 1) return n;
    }
    return null;
  }

  function nthOfType(el) {
    var n = 1;
    for (var s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.localName === el.localName) n++;
    }
    return n;
  }

  function buildSelector(el) {
    var anchor = findIdAnchor(el);
    var stop = anchor || document.body;
    var parts = [];
    for (var n = el; n && n !== stop && n !== docEl; n = n.parentElement) {
      parts.unshift(n.localName + ":nth-of-type(" + nthOfType(n) + ")");
    }
    var head = anchor ? "#" + cssEscape(anchor.id) : "body";
    return [head].concat(parts).join(" > ");
  }

  function describeElement(el) {
    var raw = typeof el.innerText === "string" ? el.innerText : el.textContent;
    return { tag: el.localName.toLowerCase(), text: clip(raw) };
  }

  function queryOrNull(selector) {
    try {
      return document.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  /** Cached element for an item; re-queried by selector when detached. */
  function findElement(item) {
    var el = elCache.get(item.id);
    if (!el || !el.isConnected) {
      el = queryOrNull(item.selector);
      if (el) elCache.set(item.id, el);
      else elCache.delete(item.id);
    }
    return el || null;
  }

  // ---------------------------------------------------------------- React Grab source

  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { resolve(null); }, ms);
      promise.then(
        function (v) { clearTimeout(timer); resolve(v); },
        function () { clearTimeout(timer); resolve(null); }
      );
    });
  }

  async function resolveSource(el) {
    try {
      var grab = window.__REACT_GRAB__;
      if (!grab || typeof grab.getSource !== "function") return null;
      var res = await withTimeout(Promise.resolve(grab.getSource(el)), SOURCE_TIMEOUT_MS);
      if (!res || !res.filePath) return null;
      return {
        filePath: String(res.filePath),
        line: Number(res.lineNumber) || 0,
        column: Number(res.columnNumber) || 0,
        component: res.componentName ? String(res.componentName) : "",
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * React Grab is only our source resolver. Its own toolbar copies an element right away,
   * which looks like a second, note-less launcher, so hide it. React Grab may load after us.
   */
  function hideReactGrabToolbar() {
    var tries = 0;
    (function attempt() {
      var grab = window.__REACT_GRAB__;
      if (grab && typeof grab.registerPlugin === "function") {
        try {
          grab.registerPlugin({ name: "pinprompt", theme: { toolbar: { enabled: false } } });
        } catch (e) {
          // Older React Grab without plugin themes: leave its toolbar alone.
        }
        return;
      }
      if (++tries < GRAB_WAIT_TRIES) setTimeout(attempt, GRAB_WAIT_MS);
    })();
  }

  // ---------------------------------------------------------------- copy format

  /** Display-time path cleanup: strip scheme/bundler prefixes, then the project root, then "./". */
  function relativize(path) {
    var p = String(path == null ? "" : path);
    if (p.indexOf("file://") === 0) p = p.slice(7);
    if (p.indexOf("webpack-internal:///") === 0) p = p.slice(20);
    for (var again = true; again; ) {
      again = false;
      ["(app-pages-browser)/", "(rsc)/", "(ssr)/"].forEach(function (prefix) {
        if (p.indexOf(prefix) === 0) {
          p = p.slice(prefix.length);
          again = true;
        }
      });
    }
    if (projectRoot && p.indexOf(projectRoot + "/") === 0) p = p.slice(projectRoot.length + 1);
    if (p.indexOf("./") === 0) p = p.slice(2);
    return p;
  }

  function setRoot(value) {
    if (typeof value !== "string") return false;
    var r = value.replace(/\/+$/, "");
    if (!r) return false;
    projectRoot = r;
    return true;
  }

  /** Project root: window.__PINPROMPT_CONFIG__.root, else pinprompt.config.json next to this script. */
  function loadRoot() {
    var cfg = window.__PINPROMPT_CONFIG__;
    if (cfg && setRoot(cfg.root)) return;
    try {
      var url = new URL("pinprompt.config.json", SCRIPT_SRC);
      fetch(url, { cache: "no-store" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (data && setRoot(data.root)) renderAll(); // saved notes now show relative paths
        })
        .catch(function () {});
    } catch (e) {
      // Bad URL or no fetch: stay with absolute paths.
    }
  }

  function locationOf(item) {
    var s = item.source;
    return s ? relativize(s.filePath) + ":" + s.line + ":" + s.column : item.path + " " + item.selector;
  }

  function toText() {
    return items
      .map(function (it, i) {
        var text = clip(it.text);
        var label = text ? it.tag + ' "' + text + '"' : it.tag;
        var memo = String(it.memo).replace(/\r?\n/g, " / ");
        return i + 1 + ". " + locationOf(it) + " (" + label + ") — " + memo;
      })
      .join("\n");
  }

  // ---------------------------------------------------------------- UI skeleton

  var CSS_TEXT = [
    ".root{font:13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:#18181b}",
    ".root *{box-sizing:border-box}",
    "[hidden]{display:none!important}",
    "button{font:inherit;color:inherit;margin:0}",

    ".dock{position:fixed;left:64px;bottom:16px;z-index:2147483002;display:flex;align-items:center;gap:8px}",
    ".bar{display:flex;gap:2px;padding:3px;background:#fff;border:1px solid #d4d4d8;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12)}",
    ".btn{height:28px;min-width:28px;padding:0 10px;background:transparent;border:1px solid transparent;border-radius:6px;cursor:pointer;white-space:nowrap}",
    ".btn:hover{background:#f4f4f5}",
    ".btn[aria-pressed=true]{background:#ff5a1f;color:#fff}",
    ".btn[aria-expanded=true]{background:#f4f4f5}",
    ".btn:disabled{opacity:.4;cursor:not-allowed;background:transparent}",
    ".btn.primary{background:#ff5a1f;color:#fff}",
    ".btn.primary:hover{background:#e84d14}",
    ".btn.bordered{border-color:#d4d4d8;background:#fff}",
    ".btn.danger{color:#b91c1c;margin-right:auto}",
    ".toast{padding:6px 10px;background:#18181b;color:#fff;border-radius:8px;white-space:nowrap}",

    ".panel{position:fixed;left:64px;bottom:60px;z-index:2147483002;width:320px;max-width:calc(100vw - 80px);max-height:50vh;display:flex;flex-direction:column;background:#fff;border:1px solid #d4d4d8;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.14)}",
    ".list{flex:1;min-height:0;overflow:auto}",
    ".empty{padding:16px;color:#71717a;text-align:center}",
    ".item{display:flex;gap:8px;padding:8px 10px;border-bottom:1px solid #e4e4e7}",
    ".item.off{color:#a1a1aa}",
    ".num{flex:none;width:20px;height:20px;border-radius:50%;background:#ff5a1f;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}",
    ".item.off .num{background:#d4d4d8}",
    ".body{flex:1;min-width:0}",
    ".loc{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}",
    ".path{font-size:11px;color:#71717a}",
    ".memo{margin-top:2px;white-space:pre-wrap;word-break:break-word}",
    ".item.off .path{color:#a1a1aa}",
    ".item .btn{height:24px;padding:0 8px;align-self:flex-start;font-size:12px}",
    ".foot{padding:6px;display:flex;justify-content:flex-end;border-top:1px solid #e4e4e7}",

    ".pin{position:fixed;left:0;top:0;z-index:2147483000;width:" + PIN_SIZE + "px;height:" + PIN_SIZE + "px;padding:0;display:flex;align-items:center;justify-content:center;background:#ff5a1f;color:#fff;border:1px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.35);font-size:11px;font-weight:700;line-height:1;cursor:pointer}",
    ".pin.far{opacity:.45}",
    ".tip{position:fixed;left:0;top:0;z-index:2147483004;max-width:240px;padding:6px 8px;background:#18181b;color:#fff;border-radius:6px;white-space:pre-wrap;word-break:break-word;pointer-events:none}",

    ".hl{position:fixed;z-index:2147483001;border:2px solid #ff5a1f;background:rgba(255,90,31,.12);pointer-events:none}",
    ".hl-label{position:fixed;z-index:2147483001;max-width:320px;padding:2px 6px;background:#ff5a1f;color:#fff;border-radius:4px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}",

    ".editor{position:fixed;z-index:2147483003;width:" + EDITOR_WIDTH + "px;padding:10px;background:#fff;border:1px solid #d4d4d8;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.18)}",
    ".meta{margin-bottom:6px;font-size:12px;color:#71717a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".editor textarea{display:block;width:100%;min-height:64px;padding:6px 8px;resize:vertical;font:inherit;color:inherit;background:#fff;border:1px solid #d4d4d8;border-radius:6px;outline:none}",
    ".editor textarea:focus{border-color:#ff5a1f}",
    ".row{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}",
    ".copybox{position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0}",
  ].join("\n");

  var host = document.getElementById(HOST_ID);
  if (host) host.remove(); // stale host from an earlier load that lost its global
  host = h("div", { id: HOST_ID });
  host.style.cssText = "all: initial";
  var shadow = host.attachShadow({ mode: "open" });
  var root = h("div", { class: "root" });
  shadow.append(h("style", null, CSS_TEXT), root);

  var pinLayer = h("div");
  var hl = h("div", { class: "hl", hidden: true });
  var hlLabel = h("div", { class: "hl-label", hidden: true });
  var tip = h("div", { class: "tip", hidden: true });

  var btnToggle = h("button", {
    class: "btn", type: "button", "data-pinprompt": "toggle-list", "aria-expanded": "false",
    onclick: toggleList,
  });
  var btnAdd = h("button", {
    class: "btn", type: "button", "data-pinprompt": "add", "aria-pressed": "false", "aria-label": "Add note",
    onclick: togglePick,
  }, "+");
  var btnCopy = h("button", {
    class: "btn", type: "button", "data-pinprompt": "copy",
    onclick: function () { copyAll(); },
  }, "Copy");
  var dock = h("div", { class: "dock" }, h("div", { class: "bar" }, btnToggle, btnAdd, btnCopy));
  var panel = null;

  root.append(pinLayer, hl, hlLabel, dock, tip);

  // ---------------------------------------------------------------- rendering

  function renderAll() {
    renderLauncher();
    syncPins();
    renderPanel();
    ensureLoop();
  }

  function commit() {
    saveItems();
    renderAll();
  }

  function renderLauncher() {
    btnToggle.textContent = "Notes " + items.length;
    btnToggle.setAttribute("aria-expanded", String(listOpen));
    btnCopy.disabled = items.length === 0;
    btnAdd.setAttribute("aria-pressed", String(pickMode));
  }

  function renderPanel() {
    if (!listOpen) {
      if (panel) panel.remove();
      panel = null;
      return;
    }
    if (!panel) {
      panel = h("div", { class: "panel" });
      root.append(panel);
    }
    var prevScroll = panel.firstChild ? panel.firstChild.scrollTop : 0;
    var list = h("div", { class: "list" });
    if (items.length === 0) list.append(h("div", { class: "empty" }, "No notes yet"));
    items.forEach(function (it, i) { list.append(renderItem(it, i)); });
    var clearBtn = h("button", {
      class: "btn bordered", type: "button", "data-pinprompt": "clear", disabled: items.length === 0,
      onclick: confirmClear,
    }, "Clear all");
    panel.replaceChildren(list, h("div", { class: "foot" }, clearBtn));
    list.scrollTop = prevScroll;
  }

  function renderItem(it, i) {
    return h("div", { class: "item" + (onThisPage(it) ? "" : " off"), "data-pinprompt": "item" },
      h("span", { class: "num" }, String(i + 1)),
      h("div", { class: "body" },
        h("div", { class: "loc" }, locationOf(it)),
        h("div", { class: "path" }, it.path),
        h("div", { class: "memo" }, it.memo)
      ),
      h("button", {
        class: "btn", type: "button", "data-pinprompt": "item-delete",
        onclick: function () { removeItem(it.id); },
      }, "Delete")
    );
  }

  function confirmClear() {
    if (window.confirm("Delete all notes?")) clearAll();
  }

  function toggleList() {
    listOpen = !listOpen;
    renderLauncher();
    renderPanel();
  }

  function showToast(message) {
    var old = dock.querySelector(".toast");
    if (old) old.remove();
    dock.append(h("div", { class: "toast", "data-pinprompt": "toast", role: "status" }, message));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      var t = dock.querySelector(".toast");
      if (t) t.remove();
    }, TOAST_MS);
  }

  // ---------------------------------------------------------------- pins

  function syncPins() {
    var visible = new Map();
    items.forEach(function (it, i) {
      if (onThisPage(it)) visible.set(it.id, i + 1);
    });
    pinEls.forEach(function (pin, id) {
      if (visible.has(id)) return;
      pin.remove();
      pinEls.delete(id);
      elCache.delete(id);
    });
    visible.forEach(function (n, id) {
      var pin = pinEls.get(id);
      if (!pin) {
        pin = createPin(id);
        pinEls.set(id, pin);
        pinLayer.append(pin);
      }
      var label = String(n);
      if (pin.textContent !== label) pin.textContent = label;
      pin.setAttribute("data-index", label);
      pin.setAttribute("aria-label", "Note " + label);
    });
    hideTip();
    updatePins();
  }

  function createPin(id) {
    function itemOf() {
      return items.find(function (it) { return it.id === id; });
    }
    var pin = h("button", {
      class: "pin", type: "button", hidden: true, "data-pinprompt": "pin",
      onclick: function () {
        var it = itemOf();
        if (it) openEditor({ item: it, el: findElement(it) });
      },
      onmouseenter: function () { var it = itemOf(); if (it) showTip(pin, it.memo); },
      onmouseleave: hideTip,
      onfocus: function () { var it = itemOf(); if (it) showTip(pin, it.memo); },
      onblur: hideTip,
    });
    return pin;
  }

  function updatePins() {
    var vw = docEl.clientWidth;
    var vh = docEl.clientHeight;
    // Read every rect first, then write, so the page lays out once per frame instead of once per pin.
    var reads = [];
    pinEls.forEach(function (pin, id) {
      var item = items.find(function (it) { return it.id === id; });
      var el = item && findElement(item);
      reads.push({ pin: pin, r: el ? el.getBoundingClientRect() : null });
    });
    reads.forEach(function (entry) {
      var pin = entry.pin;
      var r = entry.r;
      if (!r || (r.width === 0 && r.height === 0)) {
        pin.hidden = true;
        return;
      }
      var offscreen = r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw;
      var x = clamp(r.right - PIN_SIZE / 2, 0, Math.max(0, vw - PIN_SIZE));
      var y = clamp(r.top - PIN_SIZE / 2, 0, Math.max(0, vh - PIN_SIZE));
      pin.hidden = false;
      pin.classList.toggle("far", offscreen);
      pin.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
    });
  }

  /** The rAF loop only runs while the current page has at least one note. */
  function ensureLoop() {
    var needed = items.some(onThisPage);
    if (needed && !rafId) rafId = requestAnimationFrame(tick);
    else if (!needed && rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function tick() {
    rafId = 0;
    if (!items.some(onThisPage)) return;
    updatePins();
    rafId = requestAnimationFrame(tick);
  }

  function showTip(pin, text) {
    tip.textContent = text;
    tip.hidden = false;
    var r = pin.getBoundingClientRect();
    var vw = docEl.clientWidth;
    var vh = docEl.clientHeight;
    var left = clamp(r.left, 8, Math.max(8, vw - tip.offsetWidth - 8));
    var top = r.bottom + 6;
    if (top + tip.offsetHeight > vh - 8) top = Math.max(8, r.top - tip.offsetHeight - 6);
    tip.style.transform = "translate(" + Math.round(left) + "px," + Math.round(top) + "px)";
  }

  function hideTip() {
    tip.hidden = true;
  }

  // ---------------------------------------------------------------- pick mode

  function isPickable(el) {
    return !!el && el.nodeType === 1 && el !== host && !host.contains(el) &&
      el !== docEl && el !== document.body;
  }

  function pickableAt(x, y) {
    var el = document.elementFromPoint(x, y);
    return isPickable(el) ? el : null;
  }

  function startPick() {
    if (pickMode) return;
    closeEditor();
    pickMode = true;
    BLOCKED_EVENTS.forEach(function (t) { window.addEventListener(t, onBlockedEvent, true); });
    window.addEventListener("mousemove", onPickMove, true);
    savedCursor = {
      value: docEl.style.getPropertyValue("cursor"),
      priority: docEl.style.getPropertyPriority("cursor"),
    };
    docEl.style.setProperty("cursor", "crosshair", "important");
    renderLauncher();
  }

  function stopPick() {
    if (!pickMode) return;
    pickMode = false;
    BLOCKED_EVENTS.forEach(function (t) { window.removeEventListener(t, onBlockedEvent, true); });
    window.removeEventListener("mousemove", onPickMove, true);
    if (savedCursor && savedCursor.value) {
      docEl.style.setProperty("cursor", savedCursor.value, savedCursor.priority);
    } else {
      docEl.style.removeProperty("cursor");
    }
    savedCursor = null;
    hoverEl = null;
    renderHighlight();
    renderLauncher();
  }

  function togglePick() {
    if (pickMode) stopPick();
    else startPick();
  }

  function onBlockedEvent(e) {
    if (e.composedPath().indexOf(host) !== -1) return; // our own UI keeps working
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== "click") return;
    // A keyboard-triggered click has no real coordinates; fall back to its target.
    var synthetic = e.detail === 0 && e.clientX === 0 && e.clientY === 0;
    var el = (!synthetic && pickableAt(e.clientX, e.clientY)) || (isPickable(e.target) ? e.target : null);
    if (el) openEditor({ el: el });
  }

  function onPickMove(e) {
    hoverEl = e.composedPath().indexOf(host) !== -1 ? null : pickableAt(e.clientX, e.clientY);
    renderHighlight();
  }

  function renderHighlight() {
    if (!hoverEl || !hoverEl.isConnected) {
      hl.hidden = true;
      hlLabel.hidden = true;
      return;
    }
    var r = hoverEl.getBoundingClientRect();
    var info = describeElement(hoverEl);
    hl.hidden = false;
    hl.style.left = r.left + "px";
    hl.style.top = r.top + "px";
    hl.style.width = r.width + "px";
    hl.style.height = r.height + "px";
    hlLabel.textContent = info.text ? info.tag + ' "' + info.text + '"' : info.tag;
    hlLabel.hidden = false;
    var labelTop = r.top >= 26 ? r.top - 24 : r.bottom + 4;
    hlLabel.style.left = clamp(r.left, 0, Math.max(0, docEl.clientWidth - 80)) + "px";
    hlLabel.style.top = labelTop + "px";
  }

  // ---------------------------------------------------------------- editor popover

  /** target: { el } for a new note, { item, el } to edit an existing one. */
  function openEditor(target) {
    stopPick();
    closeEditor();
    var item = target.item || null;
    var info = item ? { tag: item.tag, text: item.text } : describeElement(target.el);

    var input = h("textarea", {
      "data-pinprompt": "editor-input", placeholder: "What should change?", rows: "3",
    });
    input.value = item ? item.memo : "";

    var buttons = [];
    if (item) {
      buttons.push(h("button", {
        class: "btn danger", type: "button", "data-pinprompt": "editor-delete",
        onclick: function () { var id = item.id; closeEditor(); removeItem(id); },
      }, "Delete"));
    }
    buttons.push(
      h("button", {
        class: "btn bordered", type: "button", "data-pinprompt": "editor-cancel", onclick: closeEditor,
      }, "Cancel"),
      h("button", {
        class: "btn primary", type: "button", "data-pinprompt": "editor-save", onclick: saveEditor,
      }, "Save")
    );

    var node = h("div", { class: "editor", onkeydown: onEditorKeyDown },
      h("div", { class: "meta" }, info.text ? info.tag + ' "' + info.text + '"' : info.tag),
      input,
      h.apply(null, ["div", { class: "row" }].concat(buttons))
    );
    root.append(node);
    editor = { node: node, input: input, el: target.el || null, item: item };
    positionEditor();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    // Some apps move focus on click; make sure the textarea wins.
    requestAnimationFrame(function () {
      if (editor && editor.input === input && shadow.activeElement !== input) input.focus();
    });
  }

  function closeEditor() {
    if (!editor) return;
    editor.node.remove();
    editor = null;
  }

  function onEditorKeyDown(e) {
    e.stopPropagation(); // keep typing away from the app's shortcuts
    var composing = e.isComposing === true || e.keyCode === 229;
    if (e.key === "Escape") {
      if (composing) return;
      e.preventDefault();
      closeEditor();
    } else if (e.key === "Enter" && !e.shiftKey && e.target === editor.input) {
      if (composing) return; // IME (e.g. Korean): Enter commits the composition, not the note
      e.preventDefault();
      saveEditor();
    }
  }

  function positionEditor() {
    if (!editor) return;
    var node = editor.node;
    var el = editor.item ? findElement(editor.item) : editor.el;
    var vw = docEl.clientWidth;
    var vh = docEl.clientHeight;
    var height = node.offsetHeight;
    var left = 16;
    var top = Math.max(8, (vh - height) / 2);
    if (el && el.isConnected) {
      var r = el.getBoundingClientRect();
      left = clamp(r.left, 8, Math.max(8, vw - EDITOR_WIDTH - 8));
      top = r.bottom + 8;
      if (top + height > vh - 8) top = r.top - height - 8; // not enough room below: go above
      top = clamp(top, 8, Math.max(8, vh - height - 8));
    }
    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";
  }

  function saveEditor() {
    if (!editor) return;
    var memo = editor.input.value.trim();
    if (!memo) {
      editor.input.focus();
      return;
    }
    var current = editor;
    closeEditor();
    if (current.item) updateMemo(current.item.id, memo);
    else addItem(current.el, memo).catch(function () {});
  }

  // ---------------------------------------------------------------- item mutations

  async function addItem(el, memo) {
    // Capture everything DOM-dependent before awaiting.
    var info = describeElement(el);
    var item = {
      id: randomId(),
      createdAt: Date.now(),
      path: location.pathname,
      selector: buildSelector(el),
      tag: info.tag,
      text: info.text,
      memo: memo,
      source: null,
    };
    item.source = await resolveSource(el);
    elCache.set(item.id, el);
    items.push(item);
    commit();
  }

  function updateMemo(id, memo) {
    var item = items.find(function (it) { return it.id === id; });
    if (!item) return;
    item.memo = memo;
    commit();
  }

  function removeItem(id) {
    items = items.filter(function (it) { return it.id !== id; });
    elCache.delete(id);
    commit();
  }

  function clearAll() {
    items = [];
    elCache.clear();
    closeEditor();
    commit();
  }

  // ---------------------------------------------------------------- copy

  function fallbackCopy(text) {
    var box = h("textarea", { class: "copybox", "aria-hidden": "true", tabindex: "-1" });
    box.value = text;
    root.append(box);
    var prev = document.activeElement;
    var ok = false;
    try {
      box.select();
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    box.remove();
    try {
      if (prev && typeof prev.focus === "function") prev.focus();
    } catch (e) {
      // ignore
    }
    return ok;
  }

  async function copyAll() {
    var text = toText();
    if (!text) return false;
    var ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      ok = fallbackCopy(text);
    }
    if (ok) showToast("Copied " + items.length + (items.length === 1 ? " note" : " notes"));
    return ok;
  }

  // ---------------------------------------------------------------- global listeners

  function onKeyDown(e) {
    if (e.key === "Escape" && pickMode) {
      stopPick();
      return;
    }
    var isShortcut = e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyP";
    if (!isShortcut) return;
    if (editor && e.composedPath().indexOf(editor.node) !== -1) return; // typing in the editor
    e.preventDefault();
    togglePick();
  }

  function onLayoutChange() {
    if (pickMode) renderHighlight();
    if (editor) positionEditor();
  }

  function checkPath() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    closeEditor(); // its target belongs to the previous page
    renderAll();
  }

  function onStorage(e) {
    if (e.key !== null && e.key !== STORAGE_KEY) return;
    items = loadItems();
    if (editor && editor.item && !items.some(function (it) { return it.id === editor.item.id; })) {
      closeEditor();
    }
    renderAll();
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onLayoutChange, { capture: true, passive: true });
  window.addEventListener("resize", onLayoutChange);
  window.addEventListener("popstate", checkPath);
  window.addEventListener("storage", onStorage);
  setInterval(checkPath, PATH_POLL_MS);

  // ---------------------------------------------------------------- boot

  docEl.appendChild(host);
  renderAll();
  loadRoot();
  hideReactGrabToolbar();

  window.__PINPROMPT__ = {
    version: VERSION,
    startPick: startPick,
    stopPick: stopPick,
    list: function () {
      return items.map(function (it) {
        return Object.assign({}, it, { source: it.source ? Object.assign({}, it.source) : null });
      });
    },
    toText: toText,
    copyAll: copyAll,
    clear: clearAll,
    relativize: relativize,
  };
})();
