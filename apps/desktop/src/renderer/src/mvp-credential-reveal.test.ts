import { describe, expect, it } from "vitest";
import { splitCredentialReferences } from "./MvpApp";

describe("MVP Credential reveal", () => {
  it("turns a valid Credential reference in an Agent answer into one explicit reveal target", () => {
    expect(splitCredentialReferences(
      "已找到 [CREDENTIAL:c22f0625-62a6-4743-8e0d-d41dea186351]，本次仅为查询。"
    )).toEqual([
      { type: "text", value: "已找到 " },
      {
        type: "credential",
        credentialId: "c22f0625-62a6-4743-8e0d-d41dea186351",
        value: "[CREDENTIAL:c22f0625-62a6-4743-8e0d-d41dea186351]"
      },
      { type: "text", value: "，本次仅为查询。" }
    ]);
  });
});
