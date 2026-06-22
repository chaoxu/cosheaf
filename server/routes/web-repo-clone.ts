import { html, type Html } from "./web-html.js";

// Git clone affordance. SSH goes straight to Forgejo's restricted git-over-SSH
// endpoint; Cosheaf only helps users add keys from account settings.
export function clonePanel(cloneUrl: string): Html {
  return html`<section class="repo-clone" data-testid="repo-clone">
    <div class="repo-clone-label">
      <strong>Clone</strong>
      <span>SSH</span>
    </div>
    <div class="repo-clone-row">
      <input class="clone-url" readonly value="${cloneUrl}" aria-label="SSH clone URL" onclick="this.select()">
      <button class="button" type="button" onclick="navigator.clipboard?.writeText(this.previousElementSibling.value)">Copy</button>
      <a class="button" href="/account/settings">SSH keys</a>
    </div>
  </section>`;
}

export function sshCloneUrl(forgejoUrl: string, owner: string, repo: string, forgejoSshUrl?: string): string {
  if (forgejoSshUrl) return forgejoSshUrl;
  const host = new URL(forgejoUrl).hostname;
  return `git@${host}:${owner}/${repo}.git`;
}
