'use strict';

// Runs in the hidden devtools page: registers the panel and tells it when it
// is shown or hidden so it only polls the page while visible.

/**
 * The bits of a WebExtension event this file uses.
 * @template {(...args: any[]) => void} Listener
 * @typedef {{ addListener(listener: Listener): void }} ExtensionEvent
 */

/**
 * What `devtools.panels.create()` gives back.
 * @typedef {object} ExtensionPanel
 * @property {ExtensionEvent<(win: Window) => void>} onShown Passes the panel's window.
 * @property {ExtensionEvent<() => void>} onHidden
 */

/** Title, icon and page for `devtools.panels.create()`. @type {[title: string, icon: string, page: string]} */
const PANEL = ['Redux/Zustand', '/icons/icon-32.png', '/src/panel.html'];

/** The panel's window, once it has been shown. @type {Window | null} */
let panelWindow = null;

/** @param {ExtensionPanel} panel */
function onPanel(panel) {
  panel.onShown.addListener(win => {
    panelWindow = win;
    win.srdSetVisible?.(true);
  });
  panel.onHidden.addListener(() => panelWindow?.srdSetVisible?.(false));
}

// Firefox's `browser` API returns promises, Chrome's `chrome` API takes
// callbacks. Recent Chrome also has `browser`, so check the URL scheme instead.
if (location.protocol === 'moz-extension:') browser.devtools.panels.create(...PANEL).then(onPanel);
else chrome.devtools.panels.create(...PANEL, onPanel);
