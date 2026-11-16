// Worker entry: static pages are served directly; every other path is forwarded to the client's Durable Object
// with the `client` query parameter removed.
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function makeEnv() {
  const forwarded: Request[] = [];
  const names: string[] = [];
  const ns = {
    idFromName: (name: string) => {
      names.push(name);
      return { name } as unknown as DurableObjectId;
    },
    get: vi.fn(() => ({
      fetch: async (req: Request) => {
        forwarded.push(req);
        return new Response("from-do");
      },
    })),
  };
  const env = { SENTINEL_AGENT: ns, ENVIRONMENT: "test" } as unknown as Env;
  return { env, forwarded, names };
}

const get = (path: string, env: Env) => worker.fetch(new Request(`https://sentinel.example${path}`), env);

describe("worker fetch", () => {
  it("answers /health with service info", async () => {
    const res = await get("/health", makeEnv().env);
    expect(await res.json()).toEqual({
      service: "sentinel",
      version: "0.1.0",
      status: "operational",
      description: "Edge-native network intelligence",
    });
  });

  it.each([
    ["/blog", "<!DOCTYPE html>"],
    ["/journey", "<title>The Journey</title>"],
    ["/substack", "<!DOCTYPE html>"],
    ["/", "Sentinel — Network Intelligence"],
    ["/dashboard?client=acme", "Sentinel — Network Intelligence"],
  ])("serves %s as HTML", async (path, marker) => {
    const { env, forwarded } = makeEnv();
    const res = await get(path, env);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain(marker);
    expect(forwarded).toHaveLength(0);
  });

  it("forwards other paths to the named client's agent without the client parameter", async () => {
    const { env, forwarded, names } = makeEnv();
    const res = await worker.fetch(
      new Request("https://sentinel.example/ingest?client=acme&x=1", { method: "POST", body: "{}" }),
      env,
    );
    expect(await res.text()).toBe("from-do");
    expect(names).toEqual(["acme"]);
    expect(forwarded[0]!.url).toBe("https://sentinel.example/ingest?x=1");
    expect(forwarded[0]!.method).toBe("POST");
  });

  it("uses the 'home' agent when no client is given", async () => {
    const { env, names } = makeEnv();
    await get("/status", env);
    expect(names).toEqual(["home"]);
  });
});
