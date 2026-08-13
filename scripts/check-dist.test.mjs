import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { findDistProblems } from "./check-dist.mjs";

const artifact = "packages/example/dist/index.js";
const bytes = (value) => Buffer.from(value);

describe("dist artifact validation", () => {
  it("accepts modified tracked artifacts when they already match a clean build", () => {
    const working = new Map([[artifact, bytes("new generated content")]]);
    const generated = new Map([[artifact, bytes("new generated content")]]);

    expect(findDistProblems(
      working,
      generated,
      new Map([[artifact, bytes("new generated content")]]),
    )).toEqual([]);
  });

  it("reports stale, extra, missing, and generated-but-untracked artifacts", () => {
    const stale = "packages/example/dist/stale.js";
    const extra = "packages/example/dist/extra.js";
    const missing = "packages/example/dist/missing.js";
    const untracked = "packages/example/dist/new.js";
    const working = new Map([
      [artifact, bytes("old content")],
      [extra, bytes("obsolete")],
    ]);
    const generated = new Map([
      [artifact, bytes("new content")],
      [stale, bytes("generated")],
      [untracked, bytes("generated")],
    ]);

    expect(findDistProblems(
      working,
      generated,
      new Map([
        [artifact, bytes("old content")],
        [stale, bytes("generated")],
        [missing, bytes("generated")],
      ]),
    )).toEqual([
      `changed by build: ${artifact}`,
      `missing before build: ${untracked}`,
      `missing before build: ${stale}`,
      `not generated: ${missing}`,
      `staged content differs: ${artifact}`,
      `stale extra file: ${extra}`,
      `untracked: ${untracked}`,
    ]);
  });
});
