import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Context-group hints, published on each tool as `_meta.mint` (the mcp-host
 * context-groups contract). Inert data: a host that does not read them sees
 * an extra `_meta` key and nothing else. The shape is fixed by the host's
 * contract, so it is restated here rather than imported — this server takes
 * no dependency on mcp-host.
 *
 * Compass is a listings search: every read needs a location, address or
 * listing the person names, so nothing here answers "what's new / due / on"
 * on its own and no tool is canonical; there is no listable set of the
 * person's subjects, so no tool declares `subject`. `aliases` are the words a
 * person says (lowercase, at most 8, each at most 40 chars).
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'home';
  intent: MintIntent;
  canonical?: true;
  subject?: string;
  when?: { start: string; end: string };
  aliases?: string[];
}

export type MintMeta = { mint: MintHint };

/** `_meta` for a Compass tool: every tool here is in the `home` group. */
export function homeMeta(intent: MintIntent, aliases?: string[]): MintMeta {
  return { mint: { domain: 'home', intent, ...(aliases ? { aliases } : {}) } };
}

/**
 * A view of `server` whose `registerTool` adds the `_meta` named for a tool in
 * `metaByName`, for the tools a shared registrar (realty-core, mcp-utils)
 * registers without taking a `_meta` option. Everything else passes through
 * untouched.
 */
export function withMintMeta(server: McpServer, metaByName: Record<string, MintMeta>): McpServer {
  const registerTool = ((name: string, config: { _meta?: Record<string, unknown> }, cb: unknown) =>
    (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(
      name,
      metaByName[name] ? { ...config, _meta: { ...config._meta, ...metaByName[name] } } : config,
      cb
    )) as McpServer['registerTool'];
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') return registerTool;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
