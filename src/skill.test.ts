import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './contract.ts';
import { TOOL_NAMES } from './mcp/tools.ts';

// Staleness guard for skills/throng/SKILL.md: a renamed tool or error code breaks this test.
const skill = readFileSync(new URL('../skills/throng/SKILL.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

const backticked = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map(m => m[1] ?? '');

describe('skills/throng/SKILL.md', () => {
    it('has frontmatter with name throng and a description', () => {
        const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
        expect(front).toMatch(/^name: throng$/m);
        expect(/^description: (.*)$/m.exec(front)?.[1]?.trim()).toBeTruthy();
    });

    it('names only error codes from ERROR_CODES in its error table', () => {
        const rows = skill.split('\n').filter(line => line.startsWith('| `'));
        const codes = rows.flatMap(row => backticked(row.split('|')[1] ?? ''));
        expect(codes.length).toBeGreaterThan(5);
        for (const code of codes) expect(ERROR_CODES, code).toContain(code);
    });

    it('names only registered tools', () => {
        const mentioned = new Set(skill.match(/\b[a-z]+_thronglets?\b|\bsend_message\b|\blist_harnesses\b/g));
        for (const name of mentioned) expect(TOOL_NAMES, name).toContain(name);
        expect(mentioned.size, 'every tool is covered').toBe(TOOL_NAMES.length);
    });

    it('is the path the README install command links', () => {
        expect(readme).toMatch(/ln -s .*skills\/throng\b/);
    });
});
