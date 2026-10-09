// Invariant: every runtime dependency in package.json is actually imported
// by something under src/ (fleet-audit#992). A declared-but-dead dependency
// still ships in the .mcpb and draws dependabot majors that change nothing.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
};

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const source = walkTs(join(ROOT, 'src'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

function isImported(name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`from ['"]${escaped}(?:/[^'"]*)?['"]|import\\(['"]${escaped}(?:/[^'"]*)?['"]\\)`).test(source);
}

// Dependencies src/ reaches only through another package's subpath, so no
// `from '<name>'` appears in src/ — each needs a reason here.
const INDIRECT: Record<string, string> = {
  // optional peer of @chrischall/mcp-utils, loaded by its `/fetchproxy`
  // subpath (createFetchproxyTransport) — the bridge itself.
  '@fetchproxy/server': '@chrischall/mcp-utils/fetchproxy',
};

describe('package dependencies', () => {
  it('every runtime dependency is imported from src/', () => {
    const unused = Object.keys(pkg.dependencies).filter((d) => !isImported(d) && !(d in INDIRECT && isImported(INDIRECT[d]!)));
    expect(unused).toEqual([]);
  });

  it('the bundle script externalises only declared dependencies', () => {
    const externals = [...pkg.scripts.bundle.matchAll(/--external:(\S+)/g)].map(
      (m) => m[1]!
    );
    const undeclared = externals.filter((e) => !(e in pkg.dependencies));
    expect(undeclared).toEqual([]);
  });
});
