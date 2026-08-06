// pi modes — the spawn recipe a pi session runs under.
//
// A mode is not a permission boundary. It is the accumulated craft for one kind
// of work: a system prompt appended to pi's own, a tool allowlist, the skills
// worth loading, and any extensions that make the discipline mechanical rather
// than remembered. `ops` is the first one; see docs/pi-modes-design.md.
//
// Modes live on disk rather than in the DB because they carry extension code,
// which a JSON column cannot hold. Built-in modes ship in this repo so both
// machines get them from the same deploy; a machine can add or override one by
// dropping a directory of the same name under AGENTS_ROOT/.hermit/pi-modes/.
//
//   apps/gateway/pi-modes/<name>/mode.json      the recipe
//   apps/gateway/pi-modes/<name>/SYSTEM.md      appended to pi's system prompt
//   apps/gateway/pi-modes/<name>/extensions/*   loaded with --extension
//
// Site-specific knowledge (which hosts exist, which service has which quirk)
// deliberately does NOT live here. It belongs in skills, loaded on demand, so a
// session that never touches a given machine does not pay for its runbook on
// every turn.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS_ROOT } from '../config';

/** What a mode.json may declare. Every field is optional but `label`. */
export type PiMode = {
  /** Directory name — the value stored in ChatSession.runtimeMode. */
  name: string;
  label: string;
  blurb?: string;
  /**
   * Tool allowlist, expanded to `--tools`. Omitted = pi's default active set
   * (read, bash, edit, write) plus whatever extensions register.
   *
   * NOTE: `--tools` allowlists extension tools too, so hermit's own tools are
   * unioned in by buildModeArgs — a mode that forgets them would silently lose
   * the dashboard's ask / attach / title plumbing. Measured, not assumed: with
   * `--tools read,grep,find,ls` pi reported exactly those four and none of
   * hermit's six.
   */
  tools?: string[];
  /**
   * Tool allowlist for the omp backend, which does NOT share pi's vocabulary.
   *
   * Three things differ, all measured against a live omp:
   *  - omp activates all 31 built-ins by default; pi activates four. So on pi
   *    `tools` reads "also switch these on", and on omp it reads "restrict to
   *    these" — opposite intents from the same list.
   *  - The names differ (`glob` where pi has `find`/`ls`).
   *  - omp's `--tools` validates against built-ins ONLY and hard-errors on
   *    anything else, while leaving extension tools always available. Passing
   *    pi's list — which names hermit's own tools — fails the spawn outright.
   *
   * So it is a separate field rather than a translation. Omitted means omp gets
   * no `--tools` and keeps its full surface, which is the sane default.
   */
  ompTools?: string[];
  /** Skill names resolved against the agent's own skills dir, plus mode-local ones. */
  skills?: string[];
  /** Paths relative to the mode directory. */
  extensions?: string[];
  /** Overrides the session's model. Only set it where the mode genuinely requires one. */
  model?: string | null;
  /** Provenance for anything lifted from another project. Not read by the gateway. */
  attribution?: unknown;
};

export type LoadedMode = PiMode & {
  dir: string;
  /** Contents of SYSTEM.md, if present. */
  systemPrompt: string;
};

/** hermit's own tools, registered by hermit-pi-extension.ts. */
export const HERMIT_TOOL_NAMES = [
  'set_session_title',
  'log_status',
  'attach_file',
  'attach_image',
  'describe_image',
  'ask',
] as const;

export const DEFAULT_MODE = 'coding';

/** Built-in modes, shipped with the gateway. */
function builtinRoot(): string {
  return fileURLToPath(new URL('../../pi-modes', import.meta.url));
}

/** Machine-local modes, which shadow built-ins of the same name. */
function localRoot(): string {
  return path.join(AGENTS_ROOT, '.hermit', 'pi-modes');
}

function readDirSafe(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Every mode name available on this machine, local shadowing built-in. */
export function listModeNames(): string[] {
  return [...new Set([...readDirSafe(builtinRoot()), ...readDirSafe(localRoot())])].sort();
}

function readMode(dir: string, name: string): LoadedMode | null {
  const manifest = path.join(dir, 'mode.json');
  if (!fs.existsSync(manifest)) return null;
  let parsed: PiMode;
  try {
    parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as PiMode;
  } catch (e) {
    console.warn(`[pi-modes] ${name}/mode.json is not valid JSON:`, (e as Error).message);
    return null;
  }
  const systemPath = path.join(dir, 'SYSTEM.md');
  const systemPrompt = fs.existsSync(systemPath) ? fs.readFileSync(systemPath, 'utf8').trim() : '';
  return { ...parsed, name, label: parsed.label || name, dir, systemPrompt };
}

/**
 * Load one mode by name, or null if it is not installed.
 *
 * Not cached: a mode is read once per pi child spawn, which is rare, and
 * caching would mean editing a SYSTEM.md required a gateway restart to see.
 */
export function loadMode(name: string): LoadedMode | null {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) return null;
  return readMode(path.join(localRoot(), name), name) ?? readMode(path.join(builtinRoot(), name), name);
}

/**
 * The mode a session actually runs under.
 *
 * An unknown name resolves to the default rather than throwing: mode names are
 * stored per session and the modes themselves are on disk, so a session created
 * against a mode that was later renamed or removed — or one that synced from a
 * machine that has it and this one does not — must still start. It degrades to
 * plain pi, which is exactly what it was before modes existed.
 */
export function resolveMode(name: string | null | undefined): LoadedMode | null {
  const wanted = name?.trim() || DEFAULT_MODE;
  const found = loadMode(wanted);
  if (found) return found;
  if (wanted !== DEFAULT_MODE) {
    console.warn(`[pi-modes] session asked for unknown mode "${wanted}" — falling back to ${DEFAULT_MODE}`);
    return loadMode(DEFAULT_MODE);
  }
  return null;
}

/** Resolve a mode's skill entries to absolute paths that exist. */
function resolveSkillPaths(mode: LoadedMode, agentDirectory: string): string[] {
  const out: string[] = [];
  for (const entry of mode.skills ?? []) {
    // An absolute or explicitly-relative entry is a path; a bare name is looked
    // up in the mode's own skills/ dir first, then the agent's.
    const candidates = entry.startsWith('/') || entry.startsWith('.')
      ? [path.resolve(mode.dir, entry)]
      : [
          path.join(mode.dir, 'skills', entry),
          path.join(agentDirectory, '.claude', 'skills', entry),
        ];
    const hit = candidates.find((p) => fs.existsSync(p));
    if (hit) out.push(hit);
    else console.warn(`[pi-modes] ${mode.name}: skill "${entry}" not found (looked in ${candidates.join(', ')})`);
  }
  return out;
}

/**
 * Expand a mode into pi CLI arguments, appended after the hermit extension.
 *
 * `hermitExtension` is passed in rather than imported so this stays a pure
 * function of its inputs and can be unit-tested without resolving module URLs.
 */
export function buildModeArgs(
  mode: LoadedMode | null,
  opts: { agentDirectory: string; runtime?: 'pi-rpc' | 'omp-rpc' },
): string[] {
  if (!mode) return [];
  const isOmp = opts.runtime === 'omp-rpc';
  const args: string[] = [];

  for (const rel of mode.extensions ?? []) {
    const abs = path.resolve(mode.dir, rel);
    if (fs.existsSync(abs)) args.push('--extension', abs);
    else console.warn(`[pi-modes] ${mode.name}: extension "${rel}" not found at ${abs}`);
  }

  if (isOmp) {
    // No hermit-tools union here: omp's --tools rejects any name that is not a
    // built-in, and its extension tools are available regardless of the flag.
    // Unioning them in would fail the spawn AND be pointless.
    if (mode.ompTools?.length) args.push('--tools', mode.ompTools.join(','));
  } else if (mode.tools?.length) {
    // Union with hermit's tools — see the note on PiMode.tools. A mode author
    // listing only the built-ins they want must not lose the dashboard plumbing.
    const tools = [...new Set([...mode.tools, ...HERMIT_TOOL_NAMES])];
    args.push('--tools', tools.join(','));
  }

  // Skills are pi-only. pi's `--skill <path>` ADDS a skill on top of discovery;
  // omp's `--skills <glob>` FILTERS discovery down to what matches. Passing a
  // mode's skill list to omp would therefore hide every other skill the agent
  // has, which is the opposite of the intent. omp already discovers
  // `.claude/skills/` natively (verified: it lists this agent's full set), so
  // it needs no flag to see them.
  if (!isOmp) {
    for (const skill of resolveSkillPaths(mode, opts.agentDirectory)) {
      args.push('--skill', skill);
    }
  }

  // --append-system-prompt takes text, not a path, so the file is read here.
  // Appending (rather than --system-prompt) keeps pi's own core prompt, which
  // the mode text is written to complement rather than replace.
  if (mode.systemPrompt) args.push('--append-system-prompt', mode.systemPrompt);

  return args;
}
