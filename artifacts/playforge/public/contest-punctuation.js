(() => {
  const ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'content'];
  const SKIP_TEXT_IN = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

  function replaceEmDashes(value) {
    return value
      .replace(/\s+—\s+/g, ': ')
      .replace(/—/g, '-');
  }

  function normalizeTextNode(node) {
    if (!node.parentElement || SKIP_TEXT_IN.has(node.parentElement.tagName)) return;
    const next = replaceEmDashes(node.nodeValue || '');
    if (next !== node.nodeValue) node.nodeValue = next;
  }

  function normalizeElement(element) {
    for (const attribute of ATTRIBUTES) {
      if (!element.hasAttribute(attribute)) continue;
      const current = element.getAttribute(attribute) || '';
      const next = replaceEmDashes(current);
      if (next !== current) element.setAttribute(attribute, next);
    }
  }

  function normalizeTree(root) {
    if (root.nodeType === Node.TEXT_NODE) {
      normalizeTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;

    if (root.nodeType === Node.ELEMENT_NODE) normalizeElement(root);
    const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
    elements.forEach(normalizeElement);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) normalizeTextNode(textNode);
  }

  function start() {
    normalizeTree(document);
    new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') normalizeTextNode(mutation.target);
        if (mutation.type === 'attributes') normalizeElement(mutation.target);
        mutation.addedNodes.forEach(normalizeTree);
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRIBUTES,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();