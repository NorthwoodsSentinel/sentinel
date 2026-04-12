// Sentinel — Edge-Native Network Intelligence
// "AI that knows how a network lives"
//
// Entry point: routes requests to the SentinelAgent Durable Object.
// Each client gets their own DO instance — state is per-client, isolated.

import type { Env } from "./types";
import { renderDashboard } from "./dashboard";

export { SentinelAgent } from "./agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check (JSON)
    if (path === "/health") {
      return Response.json({
        service: "sentinel",
        version: "0.1.0",
        status: "operational",
        description: "Edge-native network intelligence",
      });
    }

    // Blog preview
    if (path === "/blog") {
      const blogHtml = await import("./blog").then(m => m.blogHtml);
      return new Response(blogHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Journey
    if (path === "/journey") {
      const journeyHtml = await import("./journey").then(m => m.journeyHtml);
      return new Response(journeyHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Substack preview
    if (path === "/substack") {
      const substackHtml = await import("./substack").then(m => m.substackHtml);
      return new Response(substackHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Dashboard
    if (path === "/" || path === "/dashboard") {
      const clientId = url.searchParams.get("client") || "home";
      return new Response(renderDashboard(clientId), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Route to the correct Sentinel agent instance
    // Default client ID — each client gets their own isolated DO instance
    const clientId = url.searchParams.get("client") || "home";
    const agentId = env.SENTINEL_AGENT.idFromName(clientId);
    const agent = env.SENTINEL_AGENT.get(agentId);

    // Strip the query params and forward to the DO
    const agentUrl = new URL(request.url);
    agentUrl.searchParams.delete("client");

    return agent.fetch(new Request(agentUrl.toString(), request));
  },
};
