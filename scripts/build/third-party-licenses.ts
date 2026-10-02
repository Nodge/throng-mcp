import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Rolldown } from 'tsdown';

const LICENSE_FILES = ['license', 'license.md', 'license.txt', 'licence', 'licence.md'];
const MARKER = '/node_modules/';

interface Bundled {
    name: string;
    version: string;
    license: string | undefined;
    text: string | undefined;
}

/** The package directory a bundled module comes from: up to the package name after the last `/node_modules/`. */
function packageDir(id: string): string | undefined {
    const at = id.lastIndexOf(MARKER);
    if (at === -1) return undefined;
    const start = at + MARKER.length;
    const [first, second] = id.slice(start).split('/');
    if (!first) return undefined;
    const name = first.startsWith('@') && second ? `${first}/${second}` : first;
    return id.slice(0, start) + name;
}

/** A fenced block keeps the license's own layout; the fence outgrows any backtick run inside. */
function fenced(text: string): string {
    const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    return `${fence}text\n${text}\n${fence}`;
}

const key = (pkg: Bundled) => `${pkg.name}@${pkg.version}`;

function readPackage(dir: string): Bundled {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        license?: unknown;
    };
    const entries = readdirSync(dir);
    const file = LICENSE_FILES.map(wanted => entries.find(entry => entry.toLowerCase() === wanted)).find(Boolean);
    return {
        name: pkg.name,
        version: pkg.version,
        license: typeof pkg.license === 'string' ? pkg.license : undefined,
        text: file
            ? readFileSync(join(dir, file), 'utf8')
                  .replace(/^\s*\n/, '')
                  .trimEnd()
            : undefined,
    };
}

/** Emits `THIRD_PARTY_LICENSES.md`: name, version, license and license text of every package with code in the bundle. */
export function thirdPartyLicenses(): Rolldown.Plugin {
    return {
        name: 'third-party-licenses',
        generateBundle(_options, bundle) {
            const dirs = new Set<string>();
            for (const output of Object.values(bundle)) {
                if (output.type !== 'chunk') continue;
                for (const [id, module] of Object.entries(output.modules)) {
                    const dir = module.renderedLength > 0 ? packageDir(id) : undefined;
                    if (dir) dirs.add(dir);
                }
            }
            // pnpm keeps one directory per peer context, so one `name@version` can come from several.
            const unique = new Map<string, Bundled>();
            for (const pkg of [...dirs].map(readPackage)) if (!unique.has(key(pkg))) unique.set(key(pkg), pkg);
            const packages = [...unique.values()];
            const unlicensed = packages.filter(pkg => !pkg.license && !pkg.text);
            if (unlicensed.length > 0) {
                this.error(`no license file or field: ${unlicensed.map(key).join(', ')}`);
            }
            // Code-unit order, not localeCompare: the same bytes on any machine.
            const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
            packages.sort((a, b) => order(a.name, b.name) || order(a.version, b.version));
            const sections = packages.map(pkg =>
                [
                    `## ${key(pkg)}`,
                    `License: ${pkg.license ?? 'see text'}`,
                    pkg.text === undefined ? 'License text not shipped with the package.' : fenced(pkg.text),
                ].join('\n\n')
            );
            const source =
                ['# Third-party licenses', 'Packages bundled into `dist/`.', ...sections].join('\n\n') + '\n';
            this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_LICENSES.md', source });
        },
    };
}
