import { describe, expect, it } from "vitest";
import { VERSION } from "@loose-ends/core";

describe("core", () => {
  it("exposes a version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
