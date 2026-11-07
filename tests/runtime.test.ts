import { afterEach, describe, expect, it } from "vitest";
import { originOf } from "../lib/runtime";

const req = new Request("http://localhost:10000/api/confirm", { method: "POST" });

describe("public base URL for PayPal's return links", () => {
  afterEach(() => {
    delete process.env.APP_BASE_URL;
    delete process.env.RENDER_EXTERNAL_URL;
  });

  it("uses the request's origin in local dev", () => {
    expect(originOf(req)).toBe("http://localhost:10000");
  });

  it("uses Render's public URL when deployed there", () => {
    process.env.RENDER_EXTERNAL_URL = "https://mostrador.onrender.com";
    expect(originOf(req)).toBe("https://mostrador.onrender.com");
  });

  it("APP_BASE_URL wins, without a trailing slash; an empty one counts as unset", () => {
    process.env.RENDER_EXTERNAL_URL = "https://mostrador.onrender.com";
    process.env.APP_BASE_URL = "https://demo.example.com/";
    expect(originOf(req)).toBe("https://demo.example.com");
    process.env.APP_BASE_URL = "";
    expect(originOf(req)).toBe("https://mostrador.onrender.com");
  });
});
