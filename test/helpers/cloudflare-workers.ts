// Stand-in for the Workers runtime module `cloudflare:workers` under Vitest/Node (aliased in vitest.config.ts).
// Only what src/ uses: a DurableObject base class that keeps `ctx` and `env`, as the runtime's does.
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
