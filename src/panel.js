'use strict';

// The DevTools panel. Polls the hook (src/hook.js) in every frame of the
// inspected page, through the background script (src/background.js), and
// renders what it recorded. Read-only.
//
// The types exchanged with the hook (QueryRequest, QueryResponse, Detail,
// SerializedValue, …) are documented at the top of hook.js, the ones exchanged
// with the background script (FrameResult, PollReply) in background.js.

/**
 * @typedef {object} PanelState
 * @property {Map<number, FrameInfo>} frames Frames with the hook, by `frameId` (0 is the top frame).
 * @property {PanelStore[]} stores Stores of all frames, top frame first.
 * @property {string | null} storeKey The selected store's `key`.
 * @property {number | null} version Version of the selected store's frame when its history was last
 *   fetched; `null` asks for all of it again.
 * @property {EntryInfo[]} entries History of the selected store, oldest first.
 * @property {number | null} selected `seq` the user picked; `null` follows the latest (Live).
 * @property {Detail | null} detail What the inspector shows.
 * @property {StatePath[]} pins Paths pinned in the State tab; their values show above the full state.
 * @property {Tab} tab
 * @property {string} filter Text the action list is filtered by.
 * @property {OpenPaths} open
 * @property {string | null} empty Key of the empty-state message showing, if any.
 * @property {number} lastScan When the page was last scanned for react-redux stores.
 * @property {boolean} forceScan Scan on the next query regardless.
 * @property {boolean} visible Whether the panel is shown; it doesn't poll while hidden.
 * @property {boolean} busy A query is in flight.
 * @property {boolean} again Query again as soon as the current one finishes.
 * @property {boolean} sortKeys View option: show object keys in alphabetical order.
 * @property {boolean} hideFunctions View option: leave out functions, such as zustand actions.
 * @property {boolean} raw View option: show values as plain JavaScript-style text instead of trees.
 */

/**
 * A frame the hook answers in.
 * @typedef {object} FrameInfo
 * @property {string} pageId The hook's page load id; changes when the frame navigates.
 * @property {number} version The frame's version when its store list was last fetched.
 * @property {string} url
 * @property {StoreInfo[]} stores
 */

/**
 * A store plus the frame it lives in. `key` is `pageId:id`, unique across
 * frames and reloads.
 * @typedef {StoreInfo & { key: string, frameId: number, pageId: string }} PanelStore
 */

/** @typedef {'state' | 'action' | 'diff'} Tab */

/**
 * A setting in the tab bar, remembered across sessions.
 * @typedef {'sortKeys' | 'hideFunctions' | 'raw'} ViewOption
 */

/**
 * Expanded tree paths, kept across updates: per tab, and for the pinned
 * values. A path is each key from the root prefixed with `\u0000`; `''` is
 * the root.
 * @typedef {{ state: Set<string>, action: Set<string>, pins: Set<string> }} OpenPaths
 */

/**
 * A child row in the tree view.
 * @typedef {object} TreeChild
 * @property {string} id Path segment: the key, or the index for arrays, sets and maps.
 * @property {string} label What is shown as the key.
 * @property {SerializedValue} value
 */

/** @typedef {'nohook' | 'nostores' | 'error'} EmptyKind */

/** @typedef {Node | string | false | null | undefined} Child Falsy children are skipped by `createElement()`. */

/**
 * Remembered action list sizes, in pixels: `width` side by side, `height`
 * when stacked.
 * @typedef {{ width?: number, height?: number }} LogSizes
 */

// Use `browser` only in Firefox. Recent Chrome has a `browser` global too, but
// it doesn't always behave like Firefox's (its `inspectedWindow.eval` promise,
// for one, resolves to a different shape).
const isFirefox = location.protocol === 'moz-extension:';
/** The WebExtension API: `browser` in Firefox, `chrome` elsewhere. */
const api = isFirefox ? globalThis.browser : globalThis.chrome;

const POLL_MS = 500;
const AUTO_SCAN_MS = 3000; // how often to look for react-redux stores mounted since
const OPTION_KEY_PREFIX = 'simple-redux-devtools.'; // + the ViewOption name, in localStorage

/** Alphabetical, ignoring case, with numbers in numeric order (`item2` before `item10`). */
const KEY_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Badge label and tooltip per store kind. @type {Record<StoreKind, [label: string, title: string]>} */
const KINDS = {
  redux: ['Redux', 'Created with the Redux DevTools enhancer (e.g. Redux Toolkit configureStore)'],
  connect: ['devtools.connect', 'Reported through the Redux DevTools connect API (e.g. zustand devtools middleware)'],
  'react-redux': ['Provider', 'Found in a react-redux <Provider>; only state changes are visible, not actions'],
  manual: ['registered', 'Registered with __SIMPLE_REDUX_DEVTOOLS__.register(); only state changes are visible'],
};

/** @type {(id: string) => HTMLElement} An element from panel.html, which is always there. */
const byId = id => document.getElementById(id);

/** @type {PanelState} */
const S = {
  frames: new Map(),
  stores: [],
  storeKey: null,
  version: null,
  entries: [],
  selected: null,
  detail: null,
  pins: [],
  tab: 'state',
  filter: '',
  open: createOpenPaths(),
  empty: null,
  lastScan: 0,
  forceScan: true,
  visible: true,
  busy: false,
  again: false,
  sortKeys: loadOption('sortKeys'),
  hideFunctions: loadOption('hideFunctions'),
  raw: loadOption('raw'),
};

/** @returns {OpenPaths} Only the roots expanded. */
function createOpenPaths() {
  return { state: new Set(['']), action: new Set(['']), pins: new Set() };
}

/** @returns {PanelStore | null} */
function currentStore() {
  return S.stores.find(s => s.key === S.storeKey) ?? null;
}

// --------------------------------------------------------------- polling

/**
 * Has the background script run the hook's query() in every frame.
 * @param {Record<string, QueryRequest>} reqs Request per frame, by `pageId`.
 * @param {QueryRequest} fallback Request for frames not seen before.
 * @returns {Promise<FrameResult[]>}
 */
async function queryFrames(reqs, fallback) {
  /** @type {PollReply | undefined} */
  const reply = await api.runtime.sendMessage({
    type: 'poll',
    tabId: api.devtools.inspectedWindow.tabId,
    reqs,
    fallback,
  });
  if (!reply) throw new Error('No reply from the background script');
  if ('error' in reply) throw new Error(reply.error);
  return reply.frames;
}

/** Queries all frames once and applies the answers. Skipped while hidden or busy. */
async function poll() {
  if (S.busy || !S.visible) return;
  S.busy = true;
  try {
    const now = Date.now();
    const scan = S.forceScan || now - S.lastScan > AUTO_SCAN_MS;
    if (scan) {
      S.forceScan = false;
      S.lastScan = now;
    }
    // The selected store's frame is asked for its history; the others only
    // for changes to their store lists.
    const store = currentStore();
    /** @type {Record<string, QueryRequest>} */
    const reqs = {};
    for (const frame of S.frames.values()) {
      reqs[frame.pageId] =
        frame.pageId === store?.pageId
          ? {
              version: S.version,
              store: store.id,
              after: S.entries.at(-1)?.seq ?? 0,
              detail: S.selected ?? -1,
              // A detail taken with a different pin doesn't count.
              have: pathsKey(S.detail?.pins) === pathsKey(S.pins) ? (S.detail?.seq ?? null) : null,
              pins: S.pins,
              scan,
            }
          : { version: frame.version, store: null, scan };
    }
    applyFrameResults(await queryFrames(reqs, { version: null, store: null, scan }));
  } catch (err) {
    showEmpty('error', err);
  } finally {
    S.busy = false;
    if (S.again) {
      S.again = false;
      poll();
    }
  }
}

/** Queries as soon as possible, after the query in flight if there is one. */
function requestPoll() {
  if (S.busy) S.again = true;
  else poll();
}

/** @param {FrameResult[]} results */
function applyFrameResults(results) {
  const store = currentStore();
  const answered = new Set();
  let framesChanged = false;

  for (const { frameId, result } of results) {
    if (result == null) continue; // no hook in this frame
    answered.add(frameId);
    const res = /** @type {QueryResponse} */ (JSON.parse(result));
    if ('unchanged' in res) continue;

    const known = S.frames.get(frameId);
    if (!known || known.pageId !== res.pageId || known.url !== res.url || !sameStores(known.stores, res.stores)) {
      framesChanged = true;
    }
    S.frames.set(frameId, { pageId: res.pageId, version: res.version, url: res.url, stores: res.stores });
    // Ignore history for a store the user switched away from mid-request.
    if (store && res.pageId === store.pageId && res.store === store.id) applyHistory(res);
  }

  // Frames that went away or lost the hook (navigated, removed).
  for (const frameId of S.frames.keys()) {
    if (!answered.has(frameId)) {
      S.frames.delete(frameId);
      framesChanged = true;
    }
  }
  if (framesChanged) {
    S.stores = [...S.frames]
      .sort(([a], [b]) => a - b)
      .flatMap(([frameId, f]) => f.stores.map(s => ({ ...s, key: `${f.pageId}:${s.id}`, frameId, pageId: f.pageId })));
    renderStores();
  }

  if (!answered.size) return showEmpty('nohook');
  if (!S.stores.length) return showEmpty('nostores');
  hideEmpty();
  if (!currentStore()) {
    // After a reload, stay on the store with the same name in the same frame.
    const same = store && S.stores.find(s => s.frameId === store.frameId && s.name === store.name);
    selectStore((same ?? S.stores[0]).key);
  }
}

/** @param {QueryResult} res The answer from the selected store's frame. */
function applyHistory(res) {
  S.version = res.version;
  if (res.entries.length || S.entries[0]?.seq < res.firstSeq) {
    S.entries = S.entries.filter(e => e.seq >= res.firstSeq).concat(res.entries);
    renderActions();
  }
  if (res.detail) {
    S.detail = res.detail;
    renderDetail();
  }
}

/**
 * @param {StoreInfo[]} a
 * @param {StoreInfo[]} b
 */
function sameStores(a, b) {
  return a.length === b.length && a.every((s, i) => s.id === b[i].id && s.name === b[i].name);
}

// ----------------------------------------------------------- user actions

/** @param {string} key */
function selectStore(key) {
  Object.assign(S, {
    storeKey: key,
    version: null,
    entries: [],
    selected: null,
    detail: null,
    pins: [],
    open: createOpenPaths(),
  });
  renderStores();
  renderActions();
  renderDetail();
  requestPoll();
}

/**
 * Pins `path`, or unpins it if it's pinned. Pinned values are shown above the
 * full state for every action.
 * @param {StatePath} path
 */
function togglePin(path) {
  const key = pathKey(path);
  if (isPinned(path)) {
    S.pins = S.pins.filter(p => pathKey(p) !== key);
    renderDetail();
  } else {
    S.pins = [...S.pins, path];
    S.open.pins.add(key);
    renderDetail();
    byId('view').scrollTop = 0; // show the new pin
  }
  requestPoll();
}

/** @param {StatePath} path */
function isPinned(path) {
  const key = pathKey(path);
  return S.pins.some(p => pathKey(p) === key);
}

/**
 * The tree view's path string for a state path (see {@link OpenPaths}).
 * @param {StatePath | null | undefined} path
 * @returns {string} `''` for the root or no path.
 */
function pathKey(path) {
  return (path ?? []).map(key => `\u0000${key}`).join('');
}

/**
 * @param {StatePath[] | undefined} paths
 * @returns {string} Equal for the same paths in the same order.
 */
function pathsKey(paths) {
  return (paths ?? []).map(pathKey).join('\u0001');
}

/** Pins the inspector to one entry, leaving Live. @param {number} seq */
function selectEntry(seq) {
  S.selected = seq;
  renderActions();
  requestPoll();
}

function goLive() {
  S.selected = null;
  renderActions();
  requestPoll();
  const log = byId('log');
  log.scrollTop = log.scrollHeight;
}

/** @param {Tab} tab */
function selectTab(tab) {
  S.tab = tab;
  renderDetail();
}

// ------------------------------------------------------------- rendering

/**
 * Creates an element. `class` sets the class name, `on…` props add event
 * listeners, other props become attributes (skipped when null or false).
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...(Child | Child[])} children
 * @returns {HTMLElement}
 */
function createElement(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter(/** @returns {c is Node | string} */ c => c != null && c !== false));
  return el;
}

function renderStores() {
  const select = /** @type {HTMLSelectElement} */ (byId('store'));
  /** @param {PanelStore} s */
  const option = s => createElement('option', { value: s.key }, s.name);
  // Group by frame as soon as any store lives in an iframe.
  if (S.stores.some(s => s.frameId !== 0)) {
    /** @type {Map<number, PanelStore[]>} */
    const byFrame = new Map();
    for (const s of S.stores) byFrame.set(s.frameId, [...(byFrame.get(s.frameId) ?? []), s]);
    select.replaceChildren(
      ...[...byFrame].map(([frameId, list]) =>
        createElement('optgroup', { label: frameLabel(frameId) }, list.map(option)),
      ),
    );
  } else {
    select.replaceChildren(...S.stores.map(option));
  }
  select.value = S.storeKey ?? '';

  const store = currentStore();
  const [label, title] = KINDS[store?.kind] ?? ['', ''];
  byId('kind').textContent = label;
  byId('kind').title = title;
  const inFrame = store && store.frameId !== 0;
  byId('frame').textContent = inFrame ? frameLabel(store.frameId) : '';
  byId('frame').title = inFrame ? (S.frames.get(store.frameId)?.url ?? '') : '';
}

/**
 * @param {number} frameId
 * @returns {string} e.g. `Top frame` or `iframe: example.com/widget`.
 */
function frameLabel(frameId) {
  if (frameId === 0) return 'Top frame';
  const url = S.frames.get(frameId)?.url ?? '';
  try {
    const { protocol, host, pathname } = new URL(url);
    return `iframe: ${protocol === 'http:' || protocol === 'https:' ? host + pathname : url}`;
  } catch {
    return `iframe: ${url}`;
  }
}

function renderActions() {
  const list = byId('actions');
  const log = byId('log');
  const focusedSeq = /** @type {HTMLElement | null} */ (document.activeElement)?.dataset?.seq;
  const filter = S.filter.toLowerCase();
  const current = S.selected ?? S.entries.at(-1)?.seq;
  // When not following live, keep the entry at the top of the view in place,
  // even as old entries drop off the start of the history.
  const anchor = S.selected === null ? null : firstVisibleEntry(log);

  const items = S.entries
    .filter(e => !filter || e.type.toLowerCase().includes(filter))
    .map(e =>
      createElement(
        'li',
        null,
        createElement(
          'button',
          {
            class: `entry${e.seq === current ? ' current' : ''}${/^(@@INIT|\(state changed\))$/.test(e.type) ? ' synthetic' : ''}`,
            'data-seq': e.seq,
            title: e.type,
            onclick: () => selectEntry(e.seq),
          },
          createElement('span', { class: 'type' }, e.type),
          createElement('span', { class: 'time' }, formatTime(e.time)),
        ),
      ),
    );
  if (!items.length && S.entries.length)
    items.push(createElement('li', { class: 'log-note' }, 'No actions match the filter.'));
  list.replaceChildren(...items);

  if (focusedSeq) {
    /** @type {HTMLElement | null} */ (list.querySelector(`[data-seq="${focusedSeq}"]`))?.focus({
      preventScroll: true,
    });
  }
  if (S.selected === null) log.scrollTop = log.scrollHeight;
  else if (anchor) {
    const el = list.querySelector(`[data-seq="${anchor.seq}"]`);
    if (el) log.scrollTop += el.getBoundingClientRect().top - anchor.top;
  }

  byId('live').setAttribute('aria-pressed', String(S.selected === null));
  byId('status').textContent = S.entries.length ? `${S.entries.length} recorded` : '';
}

/**
 * The first action list entry at least partly in view.
 * @param {HTMLElement} log
 * @returns {{ seq: string, top: number } | null} Its `seq` and viewport position.
 */
function firstVisibleEntry(log) {
  const top = log.getBoundingClientRect().top;
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (log.querySelectorAll('.entry'))) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom > top) return { seq: el.dataset.seq, top: rect.top };
  }
  return null;
}

function renderDetail() {
  for (const tab of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[role="tab"]'))) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === S.tab));
  }
  syncTabBar();
  const view = byId('view');
  const heading = byId('heading');
  const d = S.detail;
  const scroll = view.scrollTop;

  if (!d) {
    heading.replaceChildren();
    view.replaceChildren(createElement('div', { class: 'note' }, S.storeKey ? 'Waiting for data…' : ''));
    return;
  }

  const label = { state: 'State after', action: 'Action', diff: 'Changes made by' }[S.tab];
  heading.replaceChildren(label, ' ', createElement('code', null, d.type), ` · #${d.seq} · ${formatTime(d.time)}`);

  if (S.tab === 'state') view.replaceChildren(createStateView(d));
  else if (S.tab === 'action') {
    view.replaceChildren(S.raw ? createRaw(d.action) : createTree(d.action, null, '', S.open.action));
  } else view.replaceChildren(createDiffView(d));
  view.scrollTop = scroll;
}

/**
 * The State tab: pinned values first, then the full state.
 * @param {Detail} d
 * @returns {HTMLElement}
 */
function createStateView(d) {
  /** @type {(node: SerializedValue, path: string, open: Set<string>) => HTMLElement} */
  const show = (node, path, open) => (S.raw ? createRaw(node) : createTree(node, null, path, open, togglePin));
  // Pinned values and the full state are each a .selectable region for Cmd/Ctrl+A.
  const full = createElement('div', { class: 'selectable', tabindex: '-1' }, show(d.state, '', S.open.state));
  if (!S.pins.length) return full;

  // Values this detail has; a pin added since shows as loading until the next poll.
  const fetched = new Map(d.pins.map((path, i) => [pathKey(path), d.pinned[i]]));
  return createElement(
    'div',
    null,
    createElement(
      'div',
      { class: 'pinned' },
      S.pins.map(path => {
        const pinned = fetched.get(pathKey(path));
        const label = formatPath(path);
        return createElement(
          'div',
          { class: 'pinned-item' },
          createElement(
            'div',
            { class: 'pinned-head' },
            createElement('code', { title: label }, label),
            createElement(
              'button',
              { class: 'unpin', title: 'Unpin', 'aria-label': `Unpin ${label}`, onclick: () => togglePin(path) },
              '×',
            ),
          ),
          createElement(
            'div',
            { class: 'pinned-body selectable', tabindex: '-1' },
            !pinned
              ? createElement('div', { class: 'note' }, 'Loading…')
              : !pinned.found
                ? createElement('div', { class: 'note' }, 'Doesn’t exist in the state after this action.')
                : show(/** @type {SerializedValue} */ (pinned.value), pathKey(path), S.open.pins),
          ),
        );
      }),
    ),
    createElement('div', { class: 'section-label' }, 'Full state'),
    full,
  );
}

// Serialized values: JSON primitives as-is, everything else `{ $: kind, ... }`
// (see serialize() in hook.js).

/** Display text per leaf kind. @type {Record<LeafKind, (v: string | undefined) => string>} */
const LEAF_TEXT = {
  undef: () => 'undefined',
  num: v => v,
  bigint: v => `${v}n`,
  symbol: v => v,
  fn: v => `ƒ ${v || 'anonymous'}()`,
  date: v => v,
  regexp: v => v,
  error: v => v,
  node: v => `<${v}>`,
  opaque: v => v,
  circular: () => '[Circular]',
  trunc: () => '… (too deep or too large)',
};

/**
 * @param {SerializedValue} node
 * @returns {TreeChild[] | null} `null` for leaves.
 */
function getChildren(node) {
  if (node === null || typeof node !== 'object') return null;
  /** @type {TreeChild[]} */
  let children;
  switch (node.$) {
    case 'object': {
      const entries = Object.entries(node.v);
      // Only object keys: the order of arrays, Maps and Sets is part of the data.
      if (S.sortKeys) entries.sort(([a], [b]) => KEY_ORDER.compare(a, b));
      children = entries.map(([key, value]) => ({ id: key, label: key, value }));
      break;
    }
    case 'array':
    case 'set':
      children = node.v.map((value, i) => ({ id: String(i), label: String(i), value }));
      break;
    case 'map':
      children = node.v.map(([key, value], i) => ({ id: String(i), label: previewText(key, 30), value }));
      break;
    default:
      return null;
  }
  // Filtered after numbering, so array indexes and tree paths stay the real ones.
  return S.hideFunctions ? children.filter(child => !isFunction(child.value)) : children;
}

/** @param {SerializedValue} node */
function isFunction(node) {
  return node !== null && typeof node === 'object' && node.$ === 'fn';
}

/**
 * Items left out because of the hook's `MAX_ITEMS` limit.
 * @param {SerializedContainer} node
 * @returns {number}
 */
function omittedCount(node) {
  return node.$ === 'object' ? 0 : node.n - node.v.length;
}

/**
 * The value part of a tree row, without children.
 * @param {SerializedValue} node
 * @returns {HTMLElement}
 */
function createLeafValue(node) {
  if (node === null) return createElement('span', { class: 'lit' }, 'null');
  switch (typeof node) {
    case 'string':
      return createElement('span', { class: 'str' }, JSON.stringify(node));
    case 'number':
      return createElement('span', { class: 'num' }, String(node));
    case 'boolean':
      return createElement('span', { class: 'lit' }, String(node));
  }
  const children = getChildren(node);
  if (children)
    return createElement('span', { class: 'preview' }, summaryText(/** @type {SerializedContainer} */ (node)));
  const special = /** @type {SerializedLeaf} */ (node);
  const cls = special.$ === 'num' || special.$ === 'bigint' ? 'num' : 'special';
  return createElement('span', { class: cls }, (LEAF_TEXT[special.$] ?? String)(special.v));
}

// One-line preview, e.g. `{id: 1, title: "Milk", …}`.
/**
 * @param {SerializedValue} node
 * @param {number} [budget] Rough maximum length.
 * @returns {string}
 */
function previewText(node, budget = 80) {
  if (node === null || typeof node !== 'object') return typeof node === 'string' ? JSON.stringify(node) : String(node);
  const children = getChildren(node);
  if (!children) return (LEAF_TEXT[node.$] ?? String)(/** @type {SerializedLeaf} */ (node).v);
  node = /** @type {SerializedContainer} */ (node);
  if (budget < 12) return node.$ === 'object' ? '{…}' : `${containerName(node)}(${node.n})`;
  const keyed = node.$ === 'object' || node.$ === 'map';
  const [open, close] = keyed ? ['{', '}'] : ['[', ']'];
  let text = '';
  for (const child of children) {
    const sep = node.$ === 'map' ? ' => ' : ': ';
    const part = (keyed ? child.label + sep : '') + previewText(child.value, 20);
    if (text.length + part.length > budget) {
      text += (text ? ', ' : '') + '…';
      return open + text + close;
    }
    text += (text ? ', ' : '') + part;
  }
  if (omittedCount(node) > 0) text += ', …';
  return open + text + close;
}

/**
 * @param {SerializedContainer} node
 * @returns {string | undefined} `undefined` for objects.
 */
function containerName(node) {
  return { array: 'Array', set: 'Set', map: 'Map' }[node.$];
}

/**
 * The text next to a collapsible node, e.g. `Array(3) [1, 2, 3]`.
 * @param {SerializedContainer} node
 * @returns {string}
 */
function summaryText(node) {
  if (node.$ === 'object') return (node.c ? node.c + ' ' : '') + previewText(node);
  return `${containerName(node)}(${node.n}) ${previewText(node)}`;
}

/**
 * Renders a value as an expandable tree. Children are only built when their
 * node is first opened.
 * @param {SerializedValue} node
 * @param {string | null} label Key shown before the value; `null` for the root.
 * @param {string} path This node's path (see {@link OpenPaths}).
 * @param {Set<string>} open Paths to expand; updated as the user toggles nodes.
 * @param {(path: StatePath) => void} [onPin] Adds a pin toggle to every row except the root and
 *   anything inside a Map or Set.
 * @returns {HTMLElement}
 */
function createTree(node, label, path, open, onPin) {
  const key = label == null ? null : createElement('span', { class: 'key' }, label);
  const statePath = path.split('\u0000').slice(1);
  const pinned = onPin && label != null && isPinned(statePath);
  const pin =
    onPin && label != null
      ? createElement('button', {
          class: pinned ? 'pin active' : 'pin',
          title: pinned ? 'Unpin' : 'Pin: keep this value in view while switching actions',
          'aria-label': `${pinned ? 'Unpin' : 'Pin'} ${label}`,
          'aria-pressed': String(pinned),
          onclick: (/** @type {MouseEvent} */ e) => {
            e.preventDefault(); // don't toggle the surrounding <details>
            e.stopPropagation();
            onPin(statePath);
          },
        })
      : null;
  const children = getChildren(node);
  if (!children || children.length === 0)
    return createElement('div', { class: 'row' }, key, createLeafValue(node), pin);

  const container = /** @type {SerializedContainer} */ (node);
  const details = /** @type {HTMLDetailsElement} */ (
    createElement(
      'details',
      null,
      createElement(
        'summary',
        { class: 'row' },
        key,
        createElement('span', { class: 'preview' }, summaryText(container)),
        pin,
      ),
    )
  );
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    const box = createElement('div', { class: 'children' });
    // Map and Set entries have no stable key, so nothing inside them can be pinned.
    const childPin = container.$ === 'map' || container.$ === 'set' ? undefined : onPin;
    for (const child of children)
      box.append(createTree(child.value, child.label, `${path}\u0000${child.id}`, open, childPin));
    const more = omittedCount(container);
    if (more > 0) box.append(createElement('div', { class: 'row more' }, `… ${more} more not shown`));
    details.append(box);
  };
  if (open.has(path)) {
    details.open = true;
    build();
  }
  details.addEventListener('toggle', () => {
    if (details.open) {
      open.add(path);
      build();
    } else open.delete(path);
  });
  return details;
}

/**
 * @param {string[]} path
 * @returns {string} e.g. `todos[0].title`.
 */
function formatPath(path) {
  if (!path.length) return '(root)';
  return path
    .map((key, i) => {
      if (/^[A-Za-z_$][\w$]*$/.test(key)) return (i ? '.' : '') + key;
      if (/^\d+$/.test(key)) return `[${key}]`;
      return `[${JSON.stringify(key)}]`;
    })
    .join('');
}

/**
 * @param {Detail} d
 * @returns {HTMLElement}
 */
function createDiffView(d) {
  if (d.diff == null) return createElement('div', { class: 'note' }, 'No earlier state recorded to compare with.');
  if (!d.diff.length) return createElement('div', { class: 'note' }, 'This action did not change the state.');
  /** @param {SerializedValue} node */
  const value = node => createTree(node, null, '', new Set());
  return createElement(
    'div',
    null,
    d.diff.map(c => {
      const op = 'from' in c && 'to' in c ? 'changed' : 'to' in c ? 'added' : 'removed';
      return createElement(
        'div',
        { class: 'change' },
        createElement('div', { class: 'path' }, formatPath(c.path), createElement('span', { class: 'op' }, op)),
        'from' in c &&
          createElement('div', { class: 'from' }, createElement('span', { class: 'sign' }, '−'), value(c.from)),
        'to' in c && createElement('div', { class: 'to' }, createElement('span', { class: 'sign' }, '+'), value(c.to)),
      );
    }),
    d.diffTruncated && createElement('div', { class: 'note' }, 'Only the first changes are shown.'),
  );
}

/**
 * @param {number} ms Epoch milliseconds.
 * @returns {string} Local `HH:MM:SS.mmm`.
 */
function formatTime(ms) {
  const d = new Date(ms);
  /** @type {(n: number, w?: number) => string} */
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// ------------------------------------------------------------ empty states

/**
 * Replaces the panel with a message.
 * @param {EmptyKind} kind
 * @param {Error} [err] For `error`.
 */
function showEmpty(kind, err) {
  // After an error or a missing hook, ask every frame for everything again.
  if (kind !== 'nostores') {
    S.version = null;
    S.frames.clear();
  }
  byId('main').hidden = true;
  const box = byId('empty');
  box.hidden = false;
  const key = kind === 'error' ? `error:${err?.message}` : kind;
  if (S.empty === key) return;
  S.empty = key;

  /** @param {string} text */
  const code = text => createElement('code', null, text);
  const content = {
    nohook: [
      createElement('h2', null, 'Not connected to this page'),
      createElement(
        'p',
        null,
        'The page was loaded before the extension was installed or enabled. Reload it to start recording.',
      ),
      createElement('button', { onclick: () => api.devtools.inspectedWindow.reload({}) }, 'Reload page'),
    ],
    nostores: [
      createElement('h2', null, 'No stores found yet'),
      createElement('p', null, 'A store shows up here when the page:'),
      createElement(
        'ul',
        null,
        createElement(
          'li',
          null,
          'creates a Redux store with Redux Toolkit ',
          code('configureStore'),
          ' (devTools on by default), or with ',
          code('window.__REDUX_DEVTOOLS_EXTENSION__'),
          ' as an enhancer',
        ),
        createElement(
          'li',
          null,
          'creates a zustand store wrapped in the ',
          code('devtools'),
          ' middleware (enabled in development by default)',
        ),
        createElement(
          'li',
          null,
          'renders a react-redux ',
          code('<Provider store={…}>'),
          ' (found by scanning the React tree)',
        ),
      ),
      createElement(
        'p',
        null,
        'Any other store with ',
        code('getState()'),
        ' and ',
        code('subscribe()'),
        ', such as a plain zustand store, can be registered by hand:',
      ),
      createElement('pre', null, "window.__SIMPLE_REDUX_DEVTOOLS__?.register(useCartStore, 'cart')"),
      createElement(
        'p',
        { class: 'muted' },
        'The page is checked again every few seconds. If you just installed or enabled the extension, reload the page: stores created before that are not recorded.',
      ),
    ],
    error: [
      createElement('h2', null, "Can't read this page"),
      createElement('p', { class: 'muted' }, err?.message ?? String(err)),
    ],
  }[kind];
  box.replaceChildren(createElement('div', null, content));
}

function hideEmpty() {
  if (S.empty === null) return;
  S.empty = null;
  byId('main').hidden = false;
  byId('empty').hidden = true;
}

// ------------------------------------------------------------ copy as JSON

/**
 * Turns a serialized value back into plain JSON data for copying. Special
 * values become their display text.
 * @param {SerializedValue} node
 * @returns {unknown}
 */
function toPlainValue(node) {
  if (node === null || typeof node !== 'object') return node;
  switch (node.$) {
    case 'object':
      return Object.fromEntries(Object.entries(node.v).map(([k, v]) => [k, toPlainValue(v)]));
    case 'array':
    case 'set':
      return node.v.map(toPlainValue);
    case 'map':
      return node.v.map(([k, v]) => [toPlainValue(k), toPlainValue(v)]);
    case 'undef':
      return undefined;
    default:
      return (LEAF_TEXT[node.$] ?? String)(node.v);
  }
}

/** @param {string} text */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // DevTools panels often aren't allowed to use the async clipboard API.
    const area = /** @type {HTMLTextAreaElement} */ (createElement('textarea'));
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/**
 * A value as plain, JavaScript-style text, e.g. `{ id: 1, tags: Set(2) {…} }`
 * spread over indented lines. Unlike JSON it keeps what JSON can't express:
 * `undefined`, functions, Maps and Sets, class names.
 * @param {SerializedValue} node
 * @param {string} [indent] Indentation of the line the value starts on.
 * @returns {string}
 */
function formatRaw(node, indent = '') {
  if (node === null) return 'null';
  if (typeof node === 'string') return JSON.stringify(node);
  if (typeof node !== 'object') return String(node);

  const inner = `${indent}  `;
  /** @type {(open: string, lines: string[], close: string) => string} */
  const block = (open, lines, close) =>
    lines.length ? `${open}\n${lines.map(line => inner + line).join(',\n')}\n${indent}${close}` : open + close;
  /** @param {SerializedArray | SerializedSet | SerializedMap} container */
  const more = container => (omittedCount(container) > 0 ? [`… ${omittedCount(container)} more`] : []);

  switch (node.$) {
    case 'object':
      return block(
        node.c ? `${node.c} {` : '{',
        Object.entries(node.v).map(([key, value]) => `${rawKey(key)}: ${formatRaw(value, inner)}`),
        '}',
      );
    case 'array':
      return block('[', [...node.v.map(value => formatRaw(value, inner)), ...more(node)], ']');
    case 'set':
      return block(`Set(${node.n}) {`, [...node.v.map(value => formatRaw(value, inner)), ...more(node)], '}');
    case 'map':
      return block(
        `Map(${node.n}) {`,
        [...node.v.map(([key, value]) => `${formatRaw(key, inner)} => ${formatRaw(value, inner)}`), ...more(node)],
        '}',
      );
    default:
      return (LEAF_TEXT[node.$] ?? String)(node.v);
  }
}

/**
 * An object key as JavaScript would write it: bare when it can be.
 * @param {string} key
 */
function rawKey(key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) || /^(0|[1-9]\d*)$/.test(key) ? key : JSON.stringify(key);
}

/**
 * @param {SerializedValue} node
 * @returns {HTMLElement}
 */
function createRaw(node) {
  return createElement('pre', { class: 'raw' }, formatRaw(node));
}

/**
 * Copies the State or Action tab without functions: as raw text in Raw mode,
 * as JSON otherwise. The Diff tab has nothing to copy.
 */
async function copyCurrent() {
  const d = S.detail;
  if (!d || S.tab === 'diff') return;
  const node = withoutFunctions(S.tab === 'state' ? d.state : d.action);
  await copyText(S.raw ? formatRaw(node) : (JSON.stringify(toPlainValue(node), null, 2) ?? 'undefined'));
  byId('copy').textContent = 'Copied';
  setTimeout(syncTabBar, 1000);
}

/**
 * Fits the tab bar to the current tab: State and Action have Raw and copy in
 * the format shown; Diff has neither.
 */
function syncTabBar() {
  const onDiff = S.tab === 'diff';
  const raw = S.raw && !onDiff;
  const rawButton = byId('raw');
  rawButton.hidden = onDiff;
  rawButton.setAttribute('aria-pressed', String(S.raw));
  // The raw view is the data as it is: neither sorted nor filtered.
  for (const [inputId] of VIEW_OPTIONS) /** @type {HTMLInputElement} */ (byId(inputId)).disabled = raw;

  const copy = /** @type {HTMLButtonElement} */ (byId('copy'));
  copy.hidden = onDiff;
  copy.textContent = raw ? 'Copy raw' : 'Copy JSON';
  copy.title = `Copy the current tab as ${raw ? 'raw text' : 'JSON'}, without functions`;
  copy.disabled = !S.detail;
}

/**
 * A copy of `node` with every function left out, for copying. Lengths of
 * arrays, Sets and Maps are reduced to match, so nothing counts as omitted.
 * @param {SerializedValue} node
 * @returns {SerializedValue}
 */
function withoutFunctions(node) {
  if (node === null || typeof node !== 'object') return node;
  switch (node.$) {
    case 'object': {
      const entries = Object.entries(node.v).filter(([, value]) => !isFunction(value));
      return { ...node, v: Object.fromEntries(entries.map(([key, value]) => [key, withoutFunctions(value)])) };
    }
    case 'array':
    case 'set': {
      const items = node.v.filter(value => !isFunction(value)).map(withoutFunctions);
      return { ...node, v: items, n: node.n - (node.v.length - items.length) };
    }
    case 'map': {
      const items = node.v
        .filter(([, value]) => !isFunction(value))
        .map(([key, value]) => /** @type {[SerializedValue, SerializedValue]} */ ([key, withoutFunctions(value)]));
      return { ...node, v: items, n: node.n - (node.v.length - items.length) };
    }
    default:
      return node;
  }
}

// ----------------------------------------------------------------- wiring

byId('store').addEventListener('change', e => selectStore(/** @type {HTMLSelectElement} */ (e.target).value));
byId('live').addEventListener('click', goLive);
byId('rescan').addEventListener('click', () => {
  S.forceScan = true;
  requestPoll();
});
byId('filter').addEventListener('input', e => {
  S.filter = /** @type {HTMLInputElement} */ (e.target).value;
  renderActions();
});
byId('copy').addEventListener('click', copyCurrent);

/**
 * @param {ViewOption} name
 * @returns {boolean} Off unless saved as on.
 */
function loadOption(name) {
  try {
    return localStorage.getItem(OPTION_KEY_PREFIX + name) === 'true';
  } catch {
    return false;
  }
}

/**
 * @param {ViewOption} name
 * @param {boolean} value
 */
function saveOption(name, value) {
  try {
    localStorage.setItem(OPTION_KEY_PREFIX + name, String(value));
  } catch {
    // Storage unavailable; the setting just won't be remembered.
  }
}

/** @type {Array<[inputId: string, option: ViewOption]>} */
const VIEW_OPTIONS = [
  ['sort-keys', 'sortKeys'],
  ['hide-functions', 'hideFunctions'],
];
for (const [inputId, name] of VIEW_OPTIONS) {
  const input = /** @type {HTMLInputElement} */ (byId(inputId));
  input.checked = S[name];
  input.addEventListener('change', () => {
    S[name] = input.checked;
    saveOption(name, input.checked);
    renderDetail();
  });
}

byId('raw').addEventListener('click', () => {
  S.raw = !S.raw;
  saveOption('raw', S.raw);
  renderDetail(); // also updates the tab bar
});
for (const tab of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[role="tab"]'))) {
  tab.addEventListener('click', () => selectTab(/** @type {Tab} */ (tab.dataset.tab)));
}

// The splitter resizes the action list: its width side by side, its height
// when the panel is narrow and the list sits on top. Sizes are remembered.
const STACKED = matchMedia('(max-width: 560px)');
const LOG_SIZE_KEY = 'simple-redux-devtools.logSize';

/** @returns {LogSizes} */
function loadLogSizes() {
  try {
    return JSON.parse(localStorage.getItem(LOG_SIZE_KEY)) ?? {};
  } catch {
    return {};
  }
}

const logSizes = loadLogSizes();

/**
 * Sizes the action list along the current layout's axis.
 * @param {number | null} px `null` resets to the CSS default.
 * @param {boolean} [save] Remember it; off while dragging.
 */
function setLogSize(px, save = true) {
  const prop = STACKED.matches ? 'height' : 'width';
  const main = byId('main');
  if (px == null) {
    delete logSizes[prop];
    main.style.removeProperty(`--log-${prop}`);
  } else {
    // The CSS min/max on .log keep it in bounds; this keeps the stored value sane.
    const total = STACKED.matches ? main.clientHeight : main.clientWidth;
    logSizes[prop] = Math.round(Math.max(60, Math.min(px, total || px)));
    main.style.setProperty(`--log-${prop}`, `${logSizes[prop]}px`);
  }
  if (!save) return;
  try {
    localStorage.setItem(LOG_SIZE_KEY, JSON.stringify(logSizes));
  } catch {
    // Storage unavailable; the size just won't be remembered.
  }
}

for (const prop of ['width', 'height']) {
  if (logSizes[prop]) byId('main').style.setProperty(`--log-${prop}`, `${logSizes[prop]}px`);
}

const splitter = byId('splitter');
const syncSplitterOrientation = () =>
  splitter.setAttribute('aria-orientation', STACKED.matches ? 'horizontal' : 'vertical');
syncSplitterOrientation();
STACKED.addEventListener('change', syncSplitterOrientation);

splitter.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  document.body.classList.add('resizing');
  const start = byId('log').getBoundingClientRect();
  const move = ev => setLogSize(STACKED.matches ? ev.clientY - start.top : ev.clientX - start.left, false);
  const end = () => {
    splitter.removeEventListener('pointermove', move);
    splitter.removeEventListener('pointerup', end);
    splitter.removeEventListener('pointercancel', end);
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
    const rect = byId('log').getBoundingClientRect();
    setLogSize(STACKED.matches ? rect.height : rect.width);
  };
  splitter.addEventListener('pointermove', move);
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
});

splitter.addEventListener('dblclick', () => setLogSize(null));

splitter.addEventListener('keydown', e => {
  const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const rect = byId('log').getBoundingClientRect();
  setLogSize((STACKED.matches ? rect.height : rect.width) + step * (e.shiftKey ? 64 : 16));
});

// Cmd/Ctrl+A inside a .selectable region (a pinned value, the full state)
// selects only that region instead of the whole panel.
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() !== 'a' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
  const region = selectableRegion();
  if (!region) return;
  e.preventDefault();
  const range = document.createRange();
  range.selectNodeContents(region);
  const selection = getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
});

/**
 * The region the user is in: the one holding focus (clicking inside gives it
 * focus), or else the one holding the current selection or text cursor.
 * @returns {Element | null} `null` in text fields, so they keep their own select-all.
 */
function selectableRegion() {
  const active = document.activeElement;
  if (active?.closest('input, textarea, select')) return null;
  const focused = active?.closest('.selectable');
  if (focused) return focused;
  const anchor = getSelection()?.anchorNode;
  const element = anchor instanceof Element ? anchor : anchor?.parentElement;
  return element?.closest('.selectable') ?? null;
}

// Arrow keys step through the action list.
byId('actions').addEventListener('keydown', e => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const buttons = [.../** @type {NodeListOf<HTMLElement>} */ (byId('actions').querySelectorAll('.entry'))];
  const index = buttons.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  const next = buttons[index + (e.key === 'ArrowUp' ? -1 : 1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
  selectEntry(Number(next.dataset.seq));
});

/** @param {string} name DevTools theme: `default`/`light` or `dark`. */
function applyTheme(name) {
  document.documentElement.dataset.theme = name === 'dark' ? 'dark' : 'light';
}
applyTheme(api.devtools.panels.themeName);
api.devtools.panels.onThemeChanged?.addListener(applyTheme);

// Called by devtools.js when the panel is shown or hidden.
/** @param {boolean} visible */
window.srdSetVisible = visible => {
  S.visible = visible;
  if (visible) requestPoll();
};

renderActions();
renderDetail();
poll();
setInterval(poll, POLL_MS);
