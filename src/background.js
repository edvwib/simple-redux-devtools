'use strict';

// Background script: a service worker in Chrome, an event page in Firefox
// (manifest lists both; each browser ignores the key it doesn't use).
// The DevTools panel can't reach into iframes itself (Firefox has no
// `inspectedWindow.eval` frame option), so it asks this script, which runs the
// hook's query() in every frame of the inspected tab at once.

/**
 * What the panel sends.
 * @typedef {object} PollMessage
 * @property {'poll'} type
 * @property {number} tabId The inspected tab.
 * @property {Record<string, QueryRequest>} reqs Request per frame, keyed by the hook's `pageId`.
 * @property {QueryRequest} fallback Request for frames the panel doesn't know yet.
 */

/**
 * One frame's answer.
 * @typedef {object} FrameResult
 * @property {number} frameId 0 for the top frame.
 * @property {string | null} result JSON-encoded {@link QueryResponse}, or `null` if the hook isn't in that frame.
 */

/** @typedef {{ frames: FrameResult[] } | { error: string }} PollReply */

// Use `browser` only in Firefox: recent Chrome has one too, but it doesn't
// always behave like Firefox's (see panel.js).
const api = location.protocol === 'moz-extension:' ? globalThis.browser : globalThis.chrome;

api.runtime.onMessage.addListener(
  /**
   * @param {PollMessage} message
   * @param {{ id?: string }} sender
   * @param {(reply: PollReply) => void} sendResponse
   */
  (message, sender, sendResponse) => {
    if (sender.id !== api.runtime.id || message?.type !== 'poll') return false;
    poll(message).then(
      frames => sendResponse({ frames }),
      err => sendResponse({ error: String(err?.message ?? err) }),
    );
    return true; // replying asynchronously
  },
);

/**
 * @param {PollMessage} message
 * @returns {Promise<FrameResult[]>}
 */
async function poll({ tabId, reqs, fallback }) {
  const results = await api.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: queryFrame,
    args: [reqs, fallback],
  });
  return results.map(
    (/** @type {{ frameId: number, result?: string | null }} */ r) => ({ frameId: r.frameId, result: r.result ?? null }),
  );
}

/**
 * Runs inside each frame, so it must not use anything from this file.
 * @param {Record<string, QueryRequest>} reqs
 * @param {QueryRequest} fallback
 * @returns {string | null}
 */
function queryFrame(reqs, fallback) {
  const hook = window.__SIMPLE_REDUX_DEVTOOLS__;
  return hook ? hook.query(reqs[hook.pageId] ?? fallback) : null;
}
