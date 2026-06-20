(function () {
  const inputs = document.querySelectorAll("input[data-user-autocomplete]");
  if (!inputs.length) return;

  const timers = new WeakMap();
  const controllers = new WeakMap();
  const state = new WeakMap();
  const selecting = new WeakSet();
  let activeInput = null;

  function inputState(input) {
    let value = state.get(input);
    if (value) return value;
    const listbox = document.createElement("div");
    listbox.className = "user-autocomplete-listbox";
    listbox.id = `user-autocomplete-${Math.random().toString(36).slice(2)}`;
    listbox.role = "listbox";
    listbox.hidden = true;
    document.body.append(listbox);
    value = { listbox, users: [], activeIndex: -1 };
    state.set(input, value);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", listbox.id);
    return value;
  }

  function updateDatalist(input, users) {
    const listId = input.getAttribute("list");
    const list = listId ? document.getElementById(listId) : null;
    if (!(list instanceof HTMLDataListElement)) return;
    list.replaceChildren(...users.map((login) => {
      const option = document.createElement("option");
      option.value = login;
      return option;
    }));
  }

  function positionListbox(input) {
    const value = inputState(input);
    if (value.listbox.hidden) return;
    const rect = input.getBoundingClientRect();
    const maxHeight = Math.max(120, Math.min(260, window.innerHeight - rect.bottom - 8));
    value.listbox.style.left = `${Math.max(8, rect.left)}px`;
    value.listbox.style.top = `${rect.bottom + 4}px`;
    value.listbox.style.width = `${Math.max(rect.width, 180)}px`;
    value.listbox.style.maxHeight = `${maxHeight}px`;
  }

  function hideListbox(input) {
    const value = inputState(input);
    value.listbox.hidden = true;
    value.listbox.replaceChildren();
    value.activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function setActive(input, index) {
    const value = inputState(input);
    const options = [...value.listbox.querySelectorAll("[role='option']")];
    value.activeIndex = options.length ? (index + options.length) % options.length : -1;
    for (const [optionIndex, option] of options.entries()) {
      const selected = optionIndex === value.activeIndex;
      option.classList.toggle("active", selected);
      option.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) input.setAttribute("aria-activedescendant", option.id);
    }
  }

  function chooseUser(input, login) {
    selecting.add(input);
    input.value = login;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    hideListbox(input);
    input.focus();
  }

  function renderListbox(input, users) {
    const value = inputState(input);
    value.users = users;
    value.activeIndex = users.length ? 0 : -1;
    updateDatalist(input, users);

    if (document.activeElement !== input || input.value.trim().length < 1) {
      hideListbox(input);
      return;
    }

    if (!users.length) {
      const empty = document.createElement("div");
      empty.className = "user-autocomplete-empty";
      empty.textContent = "No users found";
      value.listbox.replaceChildren(empty);
    } else {
      value.listbox.replaceChildren(...users.map((login, index) => {
        const option = document.createElement("button");
        option.id = `${value.listbox.id}-${index}`;
        option.type = "button";
        option.role = "option";
        option.className = "user-autocomplete-option";
        option.textContent = login;
        option.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          chooseUser(input, login);
        });
        return option;
      }));
    }

    value.listbox.hidden = false;
    input.setAttribute("aria-expanded", "true");
    positionListbox(input);
    setActive(input, value.activeIndex);
  }

  async function fetchUsers(input) {
    const endpoint = input.dataset.userAutocomplete;
    const q = input.value.trim();
    if (!endpoint || q.length < 1) {
      renderListbox(input, []);
      hideListbox(input);
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
      if (!res.ok) {
        hideListbox(input);
        return;
      }
      const body = await res.json();
      renderListbox(input, Array.isArray(body.users) ? body.users : []);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      hideListbox(input);
    }
  }

  function scheduleFetch(input) {
    const existing = timers.get(input);
    if (existing) window.clearTimeout(existing);
    timers.set(input, window.setTimeout(() => fetchUsers(input), 150));
  }

  for (const input of inputs) {
    inputState(input);
    input.addEventListener("focus", () => {
      activeInput = input;
      if (input.value.trim()) scheduleFetch(input);
    });
    input.addEventListener("input", () => {
      if (selecting.has(input)) {
        selecting.delete(input);
        return;
      }
      activeInput = input;
      scheduleFetch(input);
    });
    input.addEventListener("keydown", (event) => {
      const value = inputState(input);
      if (value.listbox.hidden) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive(input, value.activeIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive(input, value.activeIndex - 1);
      } else if (event.key === "Enter" && value.activeIndex >= 0) {
        event.preventDefault();
        chooseUser(input, value.users[value.activeIndex]);
      } else if (event.key === "Escape") {
        hideListbox(input);
      }
    });
    input.addEventListener("blur", () => {
      window.setTimeout(() => hideListbox(input), 120);
    });
  }

  document.addEventListener("pointerdown", (event) => {
    for (const input of inputs) {
      const value = inputState(input);
      if (event.target === input || value.listbox.contains(event.target)) continue;
      hideListbox(input);
    }
  });
  window.addEventListener("resize", () => {
    if (activeInput) positionListbox(activeInput);
  });
  document.addEventListener("scroll", () => {
    if (activeInput) positionListbox(activeInput);
  }, true);
})();
