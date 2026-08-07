import { describe, expect, it } from "vitest";
import { createCredentialId } from "./credential-id";

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
});
