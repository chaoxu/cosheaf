import { describe, expect, it, vi } from "vitest";
import type { Config } from "./db.js";
import { seedWorkspace } from "./seed.js";

const workspaceMocks = vi.hoisted(() => ({
  provisionWorkspace: vi.fn(),
  ensureWorkspaceFile: vi.fn(),
  lockedReindexWorkspaceFromForgejo: vi.fn(),
}));

vi.mock("./workspace-provisioning.js", () => ({
  provisionWorkspace: workspaceMocks.provisionWorkspace,
  ensureWorkspaceFile: workspaceMocks.ensureWorkspaceFile,
  lockedReindexWorkspaceFromForgejo: workspaceMocks.lockedReindexWorkspaceFromForgejo,
}));

const config: Config = {
  mode: "hosted",
  host: "127.0.0.1",
  accessToken: null,
  dataDir: "/tmp/cosheaf-test",
  port: 3030,
  forgejoUrl: "http://forgejo.test",
  forgejoToken: "token",
  forgejoAdminToken: "admin-token",
  webhookSecret: "secret",
  webhookUrl: "http://cosheaf.test/webhook",
  publicOrigin: null,
  registrationOpen: false,
  trustedProxyHops: 0,
  coverifyCmd: "coverify",
  coverifyApiUrl: "http://cosheaf.test/api/v1",
  coverifyBotToken: "",
  coverifyBotLogin: "coverify",
  reconcileIntervalMs: 0,
};

describe("seedWorkspace", () => {
  it("asks provisioning to roll back a newly created repo on local failure", async () => {
    workspaceMocks.provisionWorkspace.mockResolvedValueOnce({
      workspace: {
        owner: "chao",
        repo: "notes",
        slug: "chao/notes",
        defaultMdFormat: "coflat",
      },
      createdRepo: true,
      repoExisted: false,
    });
    workspaceMocks.ensureWorkspaceFile.mockResolvedValue(false);
    workspaceMocks.lockedReindexWorkspaceFromForgejo.mockResolvedValue(0);

    await seedWorkspace({
      options: {
        user: "chao",
        password: "secret",
        owner: "chao",
        repo: "notes",
        workspaceName: "Notes",
        defaultMdFormat: "coflat",
        profile: "basic",
      },
      db: {} as never,
      forgejo: {} as never,
      config,
    });

    expect(workspaceMocks.provisionWorkspace).toHaveBeenCalledWith(
      {},
      {},
      config,
      expect.objectContaining({ rollbackCreatedRepoOnLocalFailure: true }),
    );
  });
});
