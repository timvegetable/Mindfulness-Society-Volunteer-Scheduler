import { describe, expect, it } from "vitest";
import { formatUniv100Label } from "../../src/shared/domain/univ100-label";

describe("formatUniv100Label", () => {
  it("strips one parenthetical metadata group after a known course prefix", () => {
    expect(
      formatUniv100Label({
        title: "UNIV100: Professor Ada Example (Synthetic Department)",
      }),
    ).toBe("UNIV100: Professor Ada Example");
  });

  it("strips a single parenthetical code without adding a section", () => {
    expect(
      formatUniv100Label({ title: "UNIV100: Professor Ada Example (SYNX)" }),
    ).toBe("UNIV100: Professor Ada Example");
  });

  it("reads an explicitly labelled section across multiple metadata groups", () => {
    const title =
      "UNIV100: Professor Ada Example (Synthetic Department, Sec 0012) (Synthetic Center Location Marker)";
    expect(formatUniv100Label({ title })).toBe(
      "UNIV100-0012: Professor Ada Example",
    );
  });

  it.each([
    "UNIV100: Professor Ada Example (North Quad, West) (BIO 4821)",
    "UNIV100: Professor Ada Example (BIO 4821) (North Quad, West)",
  ])(
    "uses a four-digit department code with a separate descriptive suffix: %s",
    (title) => {
      expect(formatUniv100Label({ title })).toBe(
        "UNIV100-4821: Professor Ada Example",
      );
    },
  );

  it("does not infer a section from an unlabelled number in a metadata group", () => {
    const title =
      "UNIV100: Professor Ada Example (Synthetic Department, Subject Marker) (Room Code 1234)";
    expect(formatUniv100Label({ title })).toBe(
      "UNIV100: Professor Ada Example",
    );
  });

  it("keeps a title when an unlabelled number could be a section or location", () => {
    const title =
      "UNIV100: Professor Ada Example (Synthetic Department) (SYN 1234)";
    expect(formatUniv100Label({ title })).toBe(title);
  });

  it("keeps an ambiguous title when the descriptive suffix also has a number", () => {
    const title =
      "UNIV100: Professor Ada Example (North Quad 18, West) (BIO 4821)";
    expect(formatUniv100Label({ title })).toBe(title);
  });

  it("does not use a location marker from another group to classify a number", () => {
    const title = "UNIV100: Professor Ada Example (Room Code) (SYN 1234)";
    expect(formatUniv100Label({ title })).toBe(title);
  });

  it("normalizes canonical section labels without losing leading zeroes", () => {
    expect(
      formatUniv100Label({
        title: " univ 100 - 0012 : Professor Ada Example ",
      }),
    ).toBe("UNIV100-0012: Professor Ada Example");
  });

  it("normalizes a canonical label when no section is present", () => {
    expect(
      formatUniv100Label({ title: " univ 100 : Professor Ada Example " }),
    ).toBe("UNIV100: Professor Ada Example");
  });

  it("recognizes labelled legacy details even without a course prefix", () => {
    expect(
      formatUniv100Label({
        title:
          "Professor Ada Example (Department: Synthetic Studies, Room: S-001, Section: 0007)",
      }),
    ).toBe("UNIV100-0007: Professor Ada Example");
  });

  it("leaves the original title and its details available to callers", () => {
    const title =
      "UNIV100: Professor Ada Example (Synthetic Department, Sec 0123) (Synthetic Center Location Marker)";
    const session = { title };
    expect(formatUniv100Label(session)).toBe(
      "UNIV100-0123: Professor Ada Example",
    );
    expect(session.title).toBe(title);
  });

  it("keeps conflicting labelled sections in the original title", () => {
    const title =
      "UNIV100: Professor Ada Example (Synthetic Department, Sec 0012) (Sec 0013)";
    expect(formatUniv100Label({ title })).toBe(title);
  });

  it("keeps an invalid labelled section in the original title", () => {
    const title =
      "UNIV100: Professor Ada Example (Synthetic Department, Sec TBD) (Room Code 1234)";
    expect(formatUniv100Label({ title })).toBe(title);
  });

  it("keeps a course-like title when it does not identify a teacher", () => {
    const title = "UNIV100: Synthetic Course 101 (Synthetic Department)";
    expect(formatUniv100Label({ title })).toBe(title);
  });
});
