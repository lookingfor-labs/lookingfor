import { describe, expect, it } from "vitest";
import { databaseRecordTab } from "./MvpApp";

describe("databaseRecordTab", () => {
  it("separates direct saves from AI and query records", () => {
    expect(databaseRecordTab("capture")).toBe("saved");
    expect(databaseRecordTab("conversation")).toBe("conversation");
    expect(databaseRecordTab("local_search")).toBe("conversation");
  });
});
