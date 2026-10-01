// Runs inside each guest page loaded in a <webview>. Injects a page-world
// script that blocks autoplay on <video>/<audio> elements, however they're
// created (document.createElement, innerHTML, cloning, attribute changes,
// or elements already present when this script runs).
const script = document.createElement('script')
script.textContent = `
  (function() {
    function disableAutoplay(el) {
      if (!el || el.__autoplayBlocked) return;
      el.__autoplayBlocked = true;
      el.autoplay = false;
      try { el.removeAttribute('autoplay'); } catch (_) {}
      try { el.pause(); } catch (_) {}
      Object.defineProperty(el, 'autoplay', {
        get: function() { return false; },
        set: function() { /* ignore attempts to re-enable */ },
        configurable: true
      });
    }

    function scan(root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('video, audio').forEach(disableAutoplay);
    }

    // Catch elements created via document.createElement.
    const originalCreateElement = document.createElement;
    document.createElement = function(tag) {
      const element = originalCreateElement.call(document, tag);
      if (typeof tag === 'string' && (tag.toLowerCase() === 'video' || tag.toLowerCase() === 'audio')) {
        disableAutoplay(element);
      }
      return element;
    };

    // Catch elements set via setAttribute('autoplay', ...) directly.
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
      if (name && name.toLowerCase() === 'autoplay' && (this.tagName === 'VIDEO' || this.tagName === 'AUDIO')) {
        return;
      }
      return originalSetAttribute.call(this, name, value);
    };

    // Catch elements already in the DOM, plus anything added later via
    // innerHTML, cloning, or other means the two overrides above miss.
    scan(document.documentElement);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') disableAutoplay(node);
          scan(node);
        });
      }
    });

    function start() {
      scan(document.documentElement);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    if (document.documentElement) {
      start();
    } else {
      document.addEventListener('DOMContentLoaded', start);
    }
  })();
`
;(document.head || document.documentElement).appendChild(script)
