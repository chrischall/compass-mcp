// Adapter that lets @fetchproxy/server's FetchproxyServer satisfy
// compass-mcp's CompassTransport interface.
//
// FetchproxyServer is domain-agnostic — its FetchInit shape is
// `{ url, method, tabUrl, headers?, body? }`. compass-mcp's tools and
// CompassClient use compass-relative paths (`/homedetails/...`,
// `/async-create-search-page-state/`), so the adapter prepends
// `https://www.compass.com` and pins `tabUrl` to compass.com so the
// extension routes the fetch through the right tab.
import { FetchproxyServer, type FetchproxyServerOpts } from '@fetchproxy/server';
import type { FetchInit, FetchResult, CompassTransport } from './transport.js';

const COMPASS_ORIGIN = 'https://www.compass.com';
const COMPASS_TAB_URL = 'https://www.compass.com/';

export interface FetchproxyTransportOptions {
  port?: number;
  /** MCP server name announced to the extension. Defaults to 'compass-mcp'. */
  server?: string;
  /** MCP server version. Should match package.json + the banner in index.ts. */
  version: string;
}

export class FetchproxyTransport implements CompassTransport {
  private readonly inner: FetchproxyServer;

  constructor(opts: FetchproxyTransportOptions) {
    const options: FetchproxyServerOpts = {
      port: opts.port ?? 37149,
      serverName: opts.server ?? 'compass-mcp',
      version: opts.version,
      // Subdomains of compass.com (www, photos, etc.) match automatically.
      domains: ['compass.com'],
    };
    this.inner = new FetchproxyServer(options);
  }

  start(): Promise<void> {
    return this.inner.listen();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  async fetch(init: FetchInit): Promise<FetchResult> {
    const url = init.path.startsWith('http')
      ? init.path
      : `${COMPASS_ORIGIN}${init.path}`;
    const result = await this.inner.fetch({
      url,
      method: init.method,
      tabUrl: COMPASS_TAB_URL,
      headers: init.headers,
      body: init.body,
    });
    // fetchproxy returns a discriminated union. CompassTransport's
    // contract is "return on HTTP-level outcomes (including 4xx/5xx),
    // throw on protocol-level failures". Map ok:false to a thrown error.
    if (!result.ok) {
      throw new Error(`fetchproxy transport error: ${result.error}`);
    }
    return { status: result.status, body: result.body, url: result.url };
  }
}
