// Invariant: every read tool that takes a `view` arg is named in the README's
// "Response size" section, which says compact is the default and that
// `view: "full"` restores media URLs.
//
// Why this exists: #272 gave five tools that used to return every field a
// compact default, so callers silently stopped getting photo/avatar URLs
// (auto-review follow-up #273). A caller that relied on those URLs needs a
// documented way back; this test keeps that documentation in step with the
// tools that actually honour `view`.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, 'src', 'tools');

/** Tool names whose registration block passes `view: viewArg()`. */
function toolsTakingView(): string[] {
  const names: string[] = [];
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
    const blocks = src.split(/registerTool\(\s*/).slice(1);
    for (const block of blocks) {
      const name = /^'(compass_\w+)'/.exec(block)?.[1];
      if (name && /\bviewArg\(\)/.test(block)) names.push(name);
    }
  }
  return names.sort();
}

function responseSizeSection(): string {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf('## Response size');
  if (start < 0) return '';
  const next = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, next < 0 ? undefined : next);
}

describe('README "Response size" section', () => {
  it('finds the view-taking tools in src/', () => {
    // Guard against the scan silently matching nothing.
    expect(toolsTakingView()).toContain('compass_get_property');
    expect(toolsTakingView()).not.toContain('compass_get_property_photos');
  });

  it('exists and documents the compact default and the full escape hatch', () => {
    const section = responseSizeSection();
    expect(section).not.toBe('');
    expect(section).toMatch(/compact/);
    expect(section).toContain('view: "full"');
  });

  it.each(toolsTakingView())('names %s', (tool) => {
    expect(responseSizeSection()).toContain(`\`${tool}\``);
  });

  it('says compass_get_property_photos is exempt', () => {
    expect(responseSizeSection()).toContain('`compass_get_property_photos`');
  });
});
