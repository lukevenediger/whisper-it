import { describe, it, expect } from "vitest";
import request from "supertest";
import AdmZip from "adm-zip";
import { app } from "../../src/app";

async function postZip(body: any) {
  const res = await request(app)
    .post("/api/zip")
    .set("Content-Type", "application/json")
    .send(body)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
  return res;
}

describe("POST /api/zip", () => {
  it("400s when files array missing", async () => {
    const res = await request(app).post("/api/zip").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/files/i);
  });

  it("returns a zip with the expected entries", async () => {
    const res = await postZip({
      zipName: "batch.zip",
      files: [
        { name: "a.txt", text: "alpha" },
        { name: "b.txt", text: "beta" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/zip");
    expect(res.headers["content-disposition"]).toContain("batch.zip");

    const zip = new AdmZip(res.body as Buffer);
    const entries = zip
      .getEntries()
      .map((e) => ({ name: e.entryName, text: e.getData().toString("utf8") }));
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: "a.txt", text: "alpha" },
        { name: "b.txt", text: "beta" },
      ]),
    );
  });

  it("dedupes identical filenames within a zip", async () => {
    const res = await postZip({
      zipName: "dups.zip",
      files: [
        { name: "same.txt", text: "first" },
        { name: "same.txt", text: "second" },
        { name: "same.txt", text: "third" },
      ],
    });
    const zip = new AdmZip(res.body as Buffer);
    const names = zip
      .getEntries()
      .map((e) => e.entryName)
      .sort();
    expect(names).toEqual(["same (1).txt", "same (2).txt", "same.txt"]);
  });

  it("sanitizes path separators and control chars", async () => {
    const res = await postZip({
      zipName: "safe.zip",
      files: [{ name: "../etc/\x00passwd", text: "x" }],
    });
    const zip = new AdmZip(res.body as Buffer);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names[0]).not.toContain("/");
    expect(names[0]).not.toContain("\\");
    expect(names[0]).not.toContain("\x00");
  });

  it("ignores malformed entries silently", async () => {
    const res = await postZip({
      files: [{ name: "ok.txt", text: "ok" }, { name: 42, text: "bad" } as any, null],
    });
    const zip = new AdmZip(res.body as Buffer);
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toEqual(["ok.txt"]);
  });
});
