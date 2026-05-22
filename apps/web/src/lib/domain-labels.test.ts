import { describe, expect, it } from "vitest";
import { domainLabel, knownDomains } from "./domain-labels";

describe("domainLabel", () => {
  it("returns the curated label for known keys", () => {
    expect(domainLabel("architecture")).toBe("Architecture");
    expect(domainLabel("cloud_infrastructure")).toBe("Cloud & Infrastructure");
    expect(domainLabel("devops_cicd")).toBe("DevOps & CI/CD");
    expect(domainLabel("storage_persistence")).toBe("Storage & Persistence");
  });

  it("beautifies unknown snake_case keys into Title Case", () => {
    expect(domainLabel("foo_bar_baz")).toBe("Foo Bar Baz");
    expect(domainLabel("something_new")).toBe("Something New");
  });

  it("handles single-word unknown keys", () => {
    expect(domainLabel("mystery")).toBe("Mystery");
    expect(domainLabel("YELLING")).toBe("Yelling");
  });

  it("returns an empty string for an empty input", () => {
    expect(domainLabel("")).toBe("");
  });

  it("knownDomains covers every curated key and is stable", () => {
    const keys = knownDomains();
    expect(keys).toContain("architecture");
    expect(keys).toContain("cloud_infrastructure");
    expect(keys).toContain("nfrs");
    // No duplicates.
    expect(new Set(keys).size).toBe(keys.length);
    // Every returned key round-trips through domainLabel to a non-empty label.
    for (const k of keys) {
      expect(domainLabel(k).length).toBeGreaterThan(0);
    }
  });
});
