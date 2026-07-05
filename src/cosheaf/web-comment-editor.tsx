type Runtime = typeof import("./web-comment-editor-runtime");

let runtimePromise: Promise<Runtime> | null = null;

function loadRuntime(): Promise<Runtime> {
  runtimePromise ??= import("./web-comment-editor-runtime");
  return runtimePromise;
}

function enhance(container: HTMLElement): void {
  if (container.dataset.mounted || container.dataset.loading) return;
  container.dataset.loading = "1";
  void loadRuntime().then((runtime) => {
    delete container.dataset.loading;
    runtime.enhance(container);
  }).catch(() => {
    delete container.dataset.loading;
  });
}

function prepare(container: HTMLElement): void {
  if (container.dataset.lazyReady || container.dataset.mounted) return;
  container.dataset.lazyReady = "1";
  const trigger = (): void => enhance(container);
  container.addEventListener("focusin", trigger, { once: true });
  container.addEventListener("pointerdown", trigger, { once: true });
  const textarea = container.querySelector("textarea");
  if (textarea?.autofocus || document.activeElement === textarea) trigger();
}

function prepareIn(scope: ParentNode): void {
  for (const container of scope.querySelectorAll<HTMLElement>("[data-coflat-compose]")) prepare(container);
}

prepareIn(document);

new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.matches("[data-coflat-compose]")) prepare(node);
      prepareIn(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });
