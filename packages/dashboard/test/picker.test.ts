import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { pickFolder } from "../lib/picker.ts";

afterEach(() => {
  delete process.env.LA_FOLDER_PICKER;
  delete process.env.LA_FOLDER_PICKER_PATH;
});

describe("pickFolder", () => {
  test("stub mode never opens a dialog", async () => {
    process.env.LA_FOLDER_PICKER = "stub";
    process.env.LA_FOLDER_PICKER_PATH = "/Users/someone/code";
    expect(await pickFolder()).toEqual({ path: "/Users/someone/code", cancelled: false });
  });

  test("stub mode falls back to the home folder", async () => {
    process.env.LA_FOLDER_PICKER = "stub";
    expect(await pickFolder()).toEqual({ path: homedir().replace(/\/+$/, ""), cancelled: false });
  });

  test("the trailing slash `POSIX path of` adds is stripped", async () => {
    process.env.LA_FOLDER_PICKER = "stub";
    process.env.LA_FOLDER_PICKER_PATH = "/Users/someone/code/";
    expect((await pickFolder()).path).toBe("/Users/someone/code");
  });
});
