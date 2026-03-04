import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  rewrapSecret,
} from "../packages/storage/src/index.js";

describe("secret envelope", () => {
  it("round-trips a secret payload", () => {
    const envelope = encryptSecret({
      accessToken: "access-token",
      workspaceId: "main",
      scope: "provider:test",
      plainText: "sk-test",
    });

    const plain = decryptSecret({
      accessToken: "access-token",
      workspaceId: "main",
      envelope,
    });

    expect(plain).toBe("sk-test");
  });

  it("rewraps secrets to a new access token", () => {
    const original = encryptSecret({
      accessToken: "old-token",
      workspaceId: "main",
      scope: "provider:test",
      plainText: "secret-value",
    });

    const rotated = rewrapSecret({
      oldAccessToken: "old-token",
      newAccessToken: "new-token",
      workspaceId: "main",
      envelope: original,
    });

    expect(
      decryptSecret({
        accessToken: "new-token",
        workspaceId: "main",
        envelope: rotated,
      }),
    ).toBe("secret-value");
  });
});
