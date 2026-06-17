(function () {
  const inputs = document.querySelectorAll("input[data-user-autocomplete]");
  if (!inputs.length) return;

  const timers = new WeakMap();
  const controllers = new WeakMap();

  function updateOptions(input, users) {
    const listId = input.getAttribute("list");
    const list = listId ? document.getElementById(listId) : null;
    if (!(list instanceof HTMLDataListElement)) return;
    list.replaceChildren(...users.map((login) => {
      const option = document.createElement("option");
      option.value = login;
      return option;
    }));
  }

  async function fetchUsers(input) {
    const endpoint = input.dataset.userAutocomplete;
    const q = input.value.trim();
    if (!endpoint || q.length < 1) {
      updateOptions(input, []);
      return;
    }

    const previous = controllers.get(input);
    if (previous) previous.abort();
    const controller = new AbortController();
    controllers.set(input, controller);

    try {
      const url = new URL(endpoint, window.location.origin);
      url.searchParams.set("q", q);
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) return;
      const body = await res.json();
      updateOptions(input, Array.isArray(body.users) ? body.users : []);
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }

  for (const input of inputs) {
    input.addEventListener("input", () => {
      const existing = timers.get(input);
      if (existing) window.clearTimeout(existing);
      timers.set(input, window.setTimeout(() => fetchUsers(input), 150));
    });
  }
})();
