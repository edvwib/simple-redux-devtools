// Simple Redux DevTools — page hook.
//
// Injected into the page's own JavaScript world (manifest `"world": "MAIN"`) at
// document_start, before any page script runs. It poses as the Redux DevTools
// extension (`__REDUX_DEVTOOLS_EXTENSION__` / `__REDUX_DEVTOOLS_EXTENSION_COMPOSE__`),
// which is what Redux Toolkit, plain Redux enhancers and zustand's `devtools`
// middleware look for. It is strictly read-only: it never dispatches, never
// sets state and ignores time-travel requests.
//
// It runs in every frame, iframes included, each with its own records. The
// DevTools panel reads them by having the background script call `query()` in
// every frame of the tab (src/background.js). Data never crosses between
// frames inside the page, so an embedding page can't read an iframe's stores.

// ------------------------------------------------- types shared with panel.js

/**
 * A value made JSON-safe by `serialize()`. JSON primitives pass through as
 * they are; anything else becomes an object tagged with `$`.
 * @typedef {string | number | boolean | null | SerializedLeaf | SerializedContainer} SerializedValue
 */

/**
 * A non-JSON value with no children, shown as text.
 * @typedef {object} SerializedLeaf
 * @property {LeafKind} $
 * @property {string} [v] Display text, e.g. the function name, ISO date or `NaN`.
 *   Absent for `undef`, `circular` and `trunc`.
 */

/**
 * - `undef`: `undefined`
 * - `num`: `NaN` or `±Infinity`
 * - `fn`: a function, `v` is its name
 * - `node`: a DOM node, `v` is its node name
 * - `opaque`: typed arrays, promises, weak collections
 * - `circular`: a reference back to one of its own ancestors
 * - `trunc`: beyond the depth or size limit
 * @typedef {'undef' | 'num' | 'bigint' | 'symbol' | 'fn' | 'date' | 'regexp' | 'error' | 'node' | 'opaque' | 'circular' | 'trunc'} LeafKind
 */

/** @typedef {SerializedObject | SerializedArray | SerializedSet | SerializedMap} SerializedContainer */

/**
 * @typedef {object} SerializedObject
 * @property {'object'} $
 * @property {Record<string, SerializedValue>} v Own enumerable properties.
 * @property {string} [c] Constructor name, for anything but a plain object.
 */

/**
 * @typedef {object} SerializedArray
 * @property {'array'} $
 * @property {SerializedValue[]} v Up to `MAX_ITEMS` items.
 * @property {number} n Real length.
 */

/**
 * @typedef {object} SerializedSet
 * @property {'set'} $
 * @property {SerializedValue[]} v Up to `MAX_ITEMS` values.
 * @property {number} n Real size.
 */

/**
 * @typedef {object} SerializedMap
 * @property {'map'} $
 * @property {Array<[SerializedValue, SerializedValue]>} v Up to `MAX_ITEMS` key/value pairs.
 * @property {number} n Real size.
 */

/**
 * How a store was found.
 * - `redux`: the Redux DevTools store enhancer (Redux Toolkit, `createStore`)
 * - `connect`: the Redux DevTools `connect()` API (zustand `devtools` middleware)
 * - `react-redux`: a `<Provider store>` found in the React tree
 * - `manual`: `__SIMPLE_REDUX_DEVTOOLS__.register()`
 * @typedef {'redux' | 'connect' | 'react-redux' | 'manual'} StoreKind
 */

/**
 * @typedef {object} StoreInfo
 * @property {number} id Unique within the page load, starting at 1.
 * @property {string} name
 * @property {StoreKind} kind
 */

/**
 * One history entry, without its state.
 * @typedef {object} EntryInfo
 * @property {number} seq Increases by one per entry, per store.
 * @property {string} type The action type, or `@@INIT` / `(state changed)`.
 * @property {number} time Epoch milliseconds.
 */

/**
 * One difference between two states. Only `to` means added, only `from`
 * means removed, both means changed.
 * @typedef {object} Change
 * @property {string[]} path Keys from the state root; empty for the root itself.
 * @property {SerializedValue} [from]
 * @property {SerializedValue} [to]
 */

/**
 * Everything about one history entry.
 * @typedef {object} Detail
 * @property {number} seq
 * @property {string} type
 * @property {number} time
 * @property {SerializedValue} action
 * @property {SerializedValue} state The state after the action.
 * @property {Change[] | null} diff Against the previous entry; `null` when there is none.
 * @property {boolean} diffTruncated Whether `diff` stopped at `MAX_CHANGES`.
 * @property {StatePath[]} pins The pins requested, in order.
 * @property {PinnedValue[]} pinned The value at each of `pins`, in the same order.
 */

/**
 * @typedef {object} PinnedValue
 * @property {boolean} found Whether the path exists in this state.
 * @property {SerializedValue} [value] Present when `found`.
 */

/**
 * A path into the state: object keys and array indexes. Paths never go into
 * Maps or Sets, whose entries have no stable key to pin.
 * @typedef {string[]} StatePath
 */

/**
 * What the panel asks `query()` for.
 * @typedef {object} QueryRequest
 * @property {number | null} [version] Last version the panel saw. If nothing changed since, the answer is
 *   a {@link QueryUnchanged}.
 * @property {number | null} [store] Id of the store whose history to return.
 * @property {number} [after] Only return history entries with a higher `seq`.
 * @property {number} [detail] `seq` to return the full {@link Detail} for, or `-1` for the latest.
 * @property {number | null} [have] `seq` of the detail the panel already shows, which is not sent again.
 * @property {boolean} [scan] Look for react-redux stores in the React tree first.
 * @property {StatePath[]} [pins] Paths to also send the values of, as the detail's `pinned`.
 */

/** @typedef {QueryUnchanged | QueryResult} QueryResponse */

/**
 * @typedef {object} QueryUnchanged
 * @property {string} pageId Random per page load; a new one means the page was reloaded.
 * @property {number} version
 * @property {true} unchanged
 */

/**
 * @typedef {object} QueryResult
 * @property {string} pageId
 * @property {number} version
 * @property {string} url The frame's address, to tell frames apart.
 * @property {StoreInfo[]} stores
 * @property {number | null} store The store `entries` and `detail` belong to.
 * @property {number} firstSeq `seq` of the oldest entry still kept; older ones were dropped.
 * @property {EntryInfo[]} entries Entries newer than the request's `after`.
 * @property {Detail} [detail] Present only when the panel doesn't already have it.
 */

/**
 * `window.__SIMPLE_REDUX_DEVTOOLS__`, one per frame.
 * @typedef {object} SimpleReduxDevtools
 * @property {string} pageId Random per page load (see {@link QueryUnchanged}).
 * @property {(req?: QueryRequest) => string} query Returns a JSON-encoded {@link QueryResponse}.
 * @property {(store: ObservableStore, name?: string) => void} register Follows any store with
 *   `getState()` and `subscribe()`, such as a plain zustand store.
 */

// --------------------------------------------------------- types for the hook

/**
 * Anything with a `type`, as far as we're concerned.
 * @typedef {{ type?: unknown }} Action
 */

/**
 * The common ground of Redux and zustand stores (zustand's `create()` hook
 * carries these too).
 * @typedef {object} ObservableStore
 * @property {() => unknown} getState
 * @property {(listener: () => void) => () => void} subscribe
 */

/**
 * @typedef {ObservableStore & { dispatch: (action: Action) => unknown }} ReduxStore
 */

/** @typedef {(...args: any[]) => ReduxStore} StoreCreator Redux's `createStore`. */
/** @typedef {(createStore: StoreCreator) => StoreCreator} StoreEnhancer */

/**
 * The options apps pass to the Redux DevTools. We only use these two; the
 * rest are forwarded to the real extension if present.
 * @typedef {{ name?: string, maxAge?: number, [option: string]: unknown }} DevToolsOptions
 */

/**
 * What `__REDUX_DEVTOOLS_EXTENSION__.connect()` returns.
 * @typedef {object} DevToolsConnection
 * @property {(state: unknown, ...rest: unknown[]) => void} init
 * @property {(action: Action | string | null, state: unknown, ...rest: unknown[]) => void} send
 * @property {(listener: (message: unknown) => void) => (() => void) | undefined} subscribe
 * @property {() => void} unsubscribe
 * @property {(message: string) => void} error
 */

/**
 * `window.__REDUX_DEVTOOLS_EXTENSION__`: callable as a store enhancer
 * factory, plus methods.
 * @typedef {((options?: DevToolsOptions) => StoreEnhancer) & {
 *   connect: (options?: DevToolsOptions) => DevToolsConnection,
 *   [method: string]: any,
 * }} ReduxDevToolsExtension
 */

/**
 * A recorded store.
 * @typedef {object} StoreRecord
 * @property {number} id
 * @property {string} name
 * @property {StoreKind} kind
 * @property {number} maxAge History entries to keep.
 * @property {HistoryEntry[]} entries Oldest first.
 * @property {number} seq Last `seq` handed out.
 */

/**
 * @typedef {object} HistoryEntry
 * @property {number} seq
 * @property {Action} action
 * @property {unknown} state The state after `action`. Kept by reference; Redux and zustand state is immutable.
 * @property {number} time Epoch milliseconds.
 */

/**
 * The few React fiber fields the react-redux scan reads.
 * @typedef {object} Fiber
 * @property {Fiber | null} [child]
 * @property {Fiber | null} [sibling]
 * @property {any} [memoizedProps]
 * @property {{ current?: Fiber }} [stateNode] For the root fiber, the FiberRoot holding the current tree.
 */

(() => {
  'use strict';

  if (window.__SIMPLE_REDUX_DEVTOOLS__) return;

  const DEFAULT_MAX_AGE = 100; // history entries kept per store
  const MAX_DEPTH = 50;
  const MAX_NODES = 50000; // per serialized value
  const MAX_ITEMS = 1000; // per array / map / set
  const MAX_CHANGES = 200; // per diff
  const SCAN_FIBER_BUDGET = 200000;

  const pageId = Math.random().toString(36).slice(2);
  /** @type {StoreRecord[]} */
  const stores = [];
  /** `getState` functions of stores already recorded, to avoid recording one twice. */
  const knownGetState = new WeakSet();
  let version = 0; // bumped on every change so the panel can skip idle polls

  // ---------------------------------------------------------------- registry

  /**
   * @param {string | undefined | null} name
   * @param {StoreKind} kind
   * @param {number} [maxAge]
   * @returns {StoreRecord}
   */
  function addStore(name, kind, maxAge) {
    const id = stores.length + 1;
    const rec = {
      id,
      name: name ? String(name) : `Store ${id}`,
      kind,
      maxAge: maxAge > 0 ? maxAge : DEFAULT_MAX_AGE,
      entries: [],
      seq: 0,
    };
    stores.push(rec);
    version++;
    return rec;
  }

  /**
   * @param {StoreRecord} rec
   * @param {Action} action
   * @param {unknown} state
   */
  function record(rec, action, state) {
    rec.entries.push({ seq: ++rec.seq, action, state, time: Date.now() });
    if (rec.entries.length > rec.maxAge) rec.entries.splice(0, rec.entries.length - rec.maxAge);
    version++;
  }

  /** @type {(action: Action | string) => Action} */
  const toAction = action => (typeof action === 'string' ? { type: action } : action);

  /**
   * @param {Action} action
   * @returns {string}
   */
  function actionType(action) {
    const type = action?.type;
    return type === undefined ? '(no type)' : String(type);
  }

  /** @type {(s: any) => s is ObservableStore & { dispatch?: unknown }} */
  const isStore = s =>
    s != null &&
    (typeof s === 'object' || typeof s === 'function') &&
    typeof s.getState === 'function' &&
    typeof s.subscribe === 'function';

  // Follows a store we did not create (react-redux Provider, manual register).
  // Without owning dispatch we cannot see actions, only state changes.
  /**
   * @param {ObservableStore} store
   * @param {string | undefined} name
   * @param {StoreKind} kind
   */
  function watch(store, name, kind) {
    if (knownGetState.has(store.getState)) return;
    knownGetState.add(store.getState);
    const rec = addStore(name, kind);
    let last = store.getState();
    record(rec, { type: '@@INIT' }, last);
    store.subscribe(() => {
      const state = store.getState();
      if (state !== last) record(rec, { type: '(state changed)' }, (last = state));
    });
  }

  // ------------------------------------------------- Redux DevTools stand-in

  // The real Redux DevTools extension, if it is installed too. We forward to it
  // so both keep working.
  /** @type {ReduxDevToolsExtension | null} */
  let upstream =
    typeof window.__REDUX_DEVTOOLS_EXTENSION__ === 'function' ? window.__REDUX_DEVTOOLS_EXTENSION__ : null;

  // Store enhancer: `createStore(reducer, preloaded, __REDUX_DEVTOOLS_EXTENSION__())`.
  /**
   * @param {DevToolsOptions} [options]
   * @returns {StoreEnhancer}
   */
  function enhancer(options = {}) {
    return createStore =>
      (...args) => {
        const create = upstream ? upstream(options)(createStore) : createStore;
        const store = create(...args);
        const rec = addStore(options.name, 'redux', options.maxAge);
        knownGetState.add(store.getState);
        record(rec, { type: '@@INIT' }, store.getState());
        /** @param {Action} action */
        const dispatch = action => {
          const result = store.dispatch(action);
          record(rec, action, store.getState());
          return result;
        };
        return { ...store, dispatch };
      };
  }

  // `__REDUX_DEVTOOLS_EXTENSION_COMPOSE__(options)(...enhancers)` or
  // `__REDUX_DEVTOOLS_EXTENSION_COMPOSE__(...enhancers)`. Ours goes innermost,
  // so it sees the plain actions that reach the reducer after middleware.
  /**
   * @param {...(StoreEnhancer | DevToolsOptions)} funcs
   * @returns {StoreEnhancer | ((...fns: StoreEnhancer[]) => StoreEnhancer)}
   */
  function compose(...funcs) {
    if (funcs.length === 0) return enhancer();
    if (funcs.length === 1 && typeof funcs[0] === 'object') {
      const options = funcs[0];
      return (...fns) => composeWith(options, fns);
    }
    return composeWith({}, /** @type {StoreEnhancer[]} */ (funcs));
  }

  /**
   * @param {DevToolsOptions} options
   * @param {StoreEnhancer[]} funcs
   * @returns {StoreEnhancer}
   */
  function composeWith(options, funcs) {
    return createStore => funcs.reduceRight((composed, f) => f(composed), enhancer(options)(createStore));
  }

  // `__REDUX_DEVTOOLS_EXTENSION__.connect(options)`, used by zustand's
  // `devtools` middleware and other non-Redux libraries.
  /**
   * @param {DevToolsOptions} [options]
   * @returns {DevToolsConnection}
   */
  function connect(options = {}) {
    const up = upstream?.connect?.(options);
    /** @type {StoreRecord | null} */
    let rec = null;
    // Created on first use, so a connection that never reports doesn't show up.
    const ensure = () => (rec ??= addStore(options.name, 'connect', options.maxAge));
    return {
      init(state, ...rest) {
        up?.init?.(state, ...rest);
        record(ensure(), { type: '@@INIT' }, state);
      },
      send(action, state, ...rest) {
        up?.send?.(action, state, ...rest);
        if (action != null) record(ensure(), toAction(action), state);
      },
      // Time-travel / dispatch messages from the devtools. We never send any.
      subscribe(listener) {
        return up?.subscribe?.(listener) ?? (() => {});
      },
      unsubscribe() {
        up?.unsubscribe?.();
      },
      error(message) {
        up?.error?.(message);
      },
    };
  }

  /** @type {ReduxDevToolsExtension} */
  const extension = options => enhancer(options);
  extension.connect = connect;
  for (const method of ['disconnect', 'send', 'listen', 'open', 'notifyErrors']) {
    extension[method] = (/** @type {unknown[]} */ ...args) => upstream?.[method]?.(...args);
  }

  /**
   * Defines a global with a getter, so later assignments go to `set` instead
   * of replacing it.
   * @param {string} name
   * @param {unknown} value
   * @param {(value: any) => void} set
   */
  function define(name, value, set) {
    try {
      Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => value, set });
    } catch {
      // Someone made it non-configurable; nothing we can do.
    }
  }
  // If the real Redux DevTools assigns itself after us, keep ours in place and
  // forward to it instead of being replaced.
  define('__REDUX_DEVTOOLS_EXTENSION__', extension, v => {
    if (v !== extension) upstream = v;
  });
  define('__REDUX_DEVTOOLS_EXTENSION_COMPOSE__', compose, () => {});

  // ------------------------------------------------------- react-redux scan

  // Finds stores passed to react-redux's <Provider store={...}> by walking the
  // React fiber tree. Catches apps that don't wire up devtools at all.
  function scanReact() {
    /** @type {Fiber[]} */
    const roots = [];
    for (const el of document.querySelectorAll('*')) {
      /** @type {Record<string, any>} */
      const props = el;
      for (const key of Object.keys(el)) {
        if (key.startsWith('__reactContainer$')) roots.push(props[key]); // React 18+
        else if (key === '_reactRootContainer') roots.push(props[key]?._internalRoot?.current ?? props[key]?.current);
      }
    }
    let budget = SCAN_FIBER_BUDGET;
    for (const root of roots) {
      const stack = [root?.stateNode?.current ?? root];
      while (stack.length && budget-- > 0) {
        const fiber = stack.pop();
        if (!fiber) continue;
        const store = fiber.memoizedProps?.store;
        if (isStore(store) && typeof store.dispatch === 'function') watch(store, 'Provider store', 'react-redux');
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
    }
  }

  // ------------------------------------------------------------ serializing

  // Turns any value into JSON the panel can render. Primitives stay as they
  // are; everything else becomes `{ $: kind, ... }`.
  /**
   * @param {unknown} value
   * @returns {SerializedValue}
   */
  function serialize(value) {
    let nodes = 0;
    /** Objects on the path from the root to the current value, to spot cycles. */
    const ancestors = new Set();

    /**
     * @param {any} v
     * @param {number} depth
     * @returns {SerializedValue}
     */
    const walk = (v, depth) => {
      switch (typeof v) {
        case 'string':
        case 'boolean':
          return v;
        case 'number':
          return Number.isFinite(v) ? v : { $: 'num', v: String(v) };
        case 'undefined':
          return { $: 'undef' };
        case 'bigint':
          return { $: 'bigint', v: String(v) };
        case 'symbol':
          return { $: 'symbol', v: String(v) };
        case 'function':
          return { $: 'fn', v: v.name || '' };
      }
      if (v === null) return null;
      if (ancestors.has(v)) return { $: 'circular' };
      if (depth > MAX_DEPTH || ++nodes > MAX_NODES) return { $: 'trunc' };
      try {
        if (v instanceof Date) return { $: 'date', v: isNaN(+v) ? 'Invalid Date' : v.toISOString() };
        if (v instanceof RegExp) return { $: 'regexp', v: String(v) };
        if (v instanceof Error) return { $: 'error', v: `${v.name}: ${v.message}` };
        if (typeof Node === 'function' && v instanceof Node) return { $: 'node', v: v.nodeName.toLowerCase() };
        if (ArrayBuffer.isView(v)) return { $: 'opaque', v: `${v.constructor.name}(${/** @type {any} */ (v).length ?? v.byteLength})` };
        if (v instanceof Promise) return { $: 'opaque', v: 'Promise' };
        if (v instanceof WeakMap || v instanceof WeakSet) return { $: 'opaque', v: v.constructor.name };

        ancestors.add(v);
        /** @type {<T, R>(list: T[], fn: (item: T) => R) => R[]} */
        const items = (list, fn) => list.slice(0, MAX_ITEMS).map(fn);
        if (Array.isArray(v)) return { $: 'array', v: items(v, x => walk(x, depth + 1)), n: v.length };
        if (v instanceof Map) {
          return { $: 'map', v: items([...v], ([k, x]) => [walk(k, depth + 1), walk(x, depth + 1)]), n: v.size };
        }
        if (v instanceof Set) return { $: 'set', v: items([...v], x => walk(x, depth + 1)), n: v.size };

        const proto = Object.getPrototypeOf(v);
        /** @type {Record<string, SerializedValue>} */
        const out = {};
        for (const key of Object.keys(v)) {
          try {
            out[key] = walk(v[key], depth + 1);
          } catch (err) {
            out[key] = { $: 'error', v: `Unreadable: ${err}` };
          }
        }
        /** @type {SerializedObject} */
        const node = { $: 'object', v: out };
        if (proto !== Object.prototype && proto !== null) node.c = proto?.constructor?.name || 'Object';
        return node;
      } catch (err) {
        return { $: 'error', v: `Unreadable: ${err}` };
      } finally {
        ancestors.delete(v);
      }
    };

    return walk(value, 0);
  }

  // ------------------------------------------------------------------- diff

  /**
   * Arrays and plain objects: the containers `diff()` looks inside.
   * @type {(v: unknown) => v is Record<string, unknown>}
   */
  const isPlain = v => {
    if (v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) return true;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  };

  // Redux and zustand state is immutable, so unchanged subtrees keep their
  // identity and can be skipped without looking inside.
  /**
   * Appends the differences between `prev` and `next` to `out`.
   * @param {unknown} prev
   * @param {unknown} next
   * @param {string[]} path Where `prev` and `next` sit in the state.
   * @param {Change[]} out
   */
  function diff(prev, next, path, out) {
    if (Object.is(prev, next) || out.length >= MAX_CHANGES) return;
    if (isPlain(prev) && isPlain(next) && Array.isArray(prev) === Array.isArray(next) && path.length < MAX_DEPTH) {
      const has = Object.prototype.hasOwnProperty;
      for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        if (out.length >= MAX_CHANGES) return;
        if (!has.call(next, key)) out.push({ path: [...path, key], from: serialize(prev[key]) });
        else if (!has.call(prev, key)) out.push({ path: [...path, key], to: serialize(next[key]) });
        else diff(prev[key], next[key], [...path, key], out);
      }
      return;
    }
    out.push({ path, from: serialize(prev), to: serialize(next) });
  }

  // ------------------------------------------------------------- panel API

  /**
   * Follows `path` into `value` through objects and arrays. Maps and Sets
   * count as not found.
   * @param {unknown} value
   * @param {StatePath} path
   * @returns {{ found: boolean, value?: unknown }}
   */
  function resolvePath(value, path) {
    let v = /** @type {any} */ (value);
    try {
      for (const key of path) {
        if (v instanceof Map || v instanceof Set) {
          return { found: false };
        } else if (v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, key)) {
          v = v[key];
        } else {
          return { found: false };
        }
      }
    } catch {
      return { found: false }; // a throwing getter
    }
    return { found: true, value: v };
  }

  /**
   * @param {StoreRecord} rec
   * @param {HistoryEntry} entry
   * @param {StatePath[]} [pins]
   * @returns {Detail}
   */
  function detailFor(rec, entry, pins = []) {
    const index = rec.entries.indexOf(entry);
    const prev = index > 0 ? rec.entries[index - 1] : null;
    /** @type {Change[] | null} */
    let changes = null;
    if (prev) diff(prev.state, entry.state, [], (changes = []));
    return {
      seq: entry.seq,
      type: actionType(entry.action),
      time: entry.time,
      action: serialize(entry.action),
      state: serialize(entry.state),
      diff: changes,
      diffTruncated: changes?.length >= MAX_CHANGES,
      pins,
      pinned: pins.map(path => {
        const { found, value } = resolvePath(entry.state, path);
        return found ? { found, value: serialize(value) } : { found };
      }),
    };
  }

  /**
   * Called by the panel, via the background script's `executeScript`. Returns
   * a string so the reply is cheap to pass along and parse once.
   * @param {QueryRequest} [req]
   * @returns {string} A JSON-encoded {@link QueryResponse}.
   */
  function query(req = {}) {
    if (req.scan) {
      try {
        scanReact();
      } catch {
        // A weird page shouldn't break the panel.
      }
    }
    const rec = stores.find(s => s.id === req.store);
    const entries = rec?.entries ?? [];

    /** @type {Detail | undefined} */
    let detail;
    const target = req.detail === -1 ? entries.at(-1) : entries.find(e => e.seq === req.detail);
    if (rec && target && target.seq !== req.have) detail = detailFor(rec, target, req.pins);

    if (req.version === version && !detail) {
      return JSON.stringify(/** @type {QueryUnchanged} */ ({ pageId, version, unchanged: true }));
    }

    return JSON.stringify(
      /** @type {QueryResult} */ ({
        pageId,
        version,
        url: location.href,
        stores: stores.map(s => ({ id: s.id, name: s.name, kind: s.kind })),
        store: rec?.id ?? null,
        firstSeq: entries[0]?.seq ?? 0,
        entries: entries
          .filter(e => e.seq > (req.after ?? 0))
          .map(e => ({ seq: e.seq, type: actionType(e.action), time: e.time })),
        detail,
      }),
    );
  }

  /**
   * @param {ObservableStore} store
   * @param {string} [name]
   */
  function register(store, name) {
    if (!isStore(store)) throw new TypeError('register() needs an object with getState() and subscribe()');
    watch(store, name, 'manual');
  }

  Object.defineProperty(window, '__SIMPLE_REDUX_DEVTOOLS__', {
    value: Object.freeze(/** @type {SimpleReduxDevtools} */ ({ pageId, query, register })),
  });
})();
