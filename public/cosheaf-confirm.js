// Delegated confirm() for any form carrying a `data-confirm` message. The
// message lives in a data attribute (HTML-attribute context, escaped by
// hono/html) and is read via dataset and passed to confirm() as a plain
// string — never interpolated into an inline handler, which the browser would
// HTML-decode and then compile as JS. That JS-string-context decode is exactly
// how a user-controlled label/milestone name could break out and run script;
// keeping the message a data attribute closes it.
document.addEventListener("submit", (event) => {
  const form = event.target;
  const message = form instanceof HTMLFormElement ? form.dataset.confirm : null;
  if (message && !window.confirm(message)) event.preventDefault();
});
