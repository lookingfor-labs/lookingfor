import { describe, expect, it } from "vitest";
import { createCredentialId, findCredentialReferences } from "./credential-id";

describe("createCredentialId", () => {
  it("creates a UUID when the browser only exposes getRandomValues", () => {
    const source = {
      getRandomValues(array: Uint8Array): Uint8Array {
        array.set(Array.from({ length: 16 }, (_, index) => index));
        return array;
      }
    };

    expect(createCredentialId(source)).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("finds complete Credential References and ignores malformed markers", () => {
    const credentialId = "00e5dcad-aad5-4fe2-a520-3ca35e0d03a8";
    const text = `有效 [CREDENTIAL:${credentialId}]，无效 [CREDENTIAL:not-a-uuid]`;

    expect(findCredentialReferences(text)).toEqual([{
      credentialId,
      ref: `[CREDENTIAL:${credentialId}]`,
      start: 3,
      end: 52
    }]);
  });
});
