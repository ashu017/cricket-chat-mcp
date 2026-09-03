/**
 * The flag reader.
 *
 * Upstream this was shared between two CLIs, which is why it sits in `core` rather than
 * beside its caller: `core` was the only module both could import. Here there is one
 * caller, `bin.ts`, and the reason to keep it in `core` is narrower but still real --
 * `core` is the layer with no filesystem and no `process`, so a flag reader here is
 * testable without either.
 *
 * Pure: strings in, a map out.
 *
 * This is not an argument-parsing library and should not become one. Three flags on one
 * binary do not justify a dependency that then travels in every published tarball.
 */

/** Where a subcommand writes. Injected so a test reads the output back. */
export type Writer = (text: string) => void;

/** A malformed invocation. Every CLI here turns this into exit 2 and a stderr line. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Split `argv` into positionals and flags.
 *
 * `valueFlags` is the whole of why this is not two lines. A flag that always consumed the
 * next token would swallow the JSON blob in
 * `cchat tool resolve_entity --compact '{"query":"Kohli"}'`, and the failure would read as
 * a malformed argument rather than as a parser bug. A flag that never consumed one would
 * turn `--sample 400` into a positional `400` that nothing reads.
 *
 * `--name=value` is accepted for every flag, value-taking or not, because that is the
 * spelling a reader reaches for when a value starts with a dash.
 */
export function split(
  argv: readonly string[],
  valueFlags: ReadonlySet<string>,
): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals !== -1) {
      flags.set(token.slice(2, equals), token.slice(equals + 1));
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (valueFlags.has(name) && next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

/** A flag's value, or null when it was not given. `--name` with no value is a mistake. */
export function stringFlag(flags: Map<string, string | true>, name: string): string | null {
  const value = flags.get(name);
  if (value === undefined) return null;
  if (value === true) throw new UsageError(`--${name} needs a value`);
  return value;
}

/**
 * An integer flag, or null when it was not given.
 *
 * Mirrors argparse's `type=int`: a value that is not an integer is a usage error, not a
 * silent `NaN` that reaches `build()` and turns `--sample notanumber` into a full ingest.
 */
export function intFlag(flags: Map<string, string | true>, name: string): number | null {
  const value = stringFlag(flags, name);
  if (value === null) return null;
  if (!/^-?\d+$/.test(value)) {
    throw new UsageError(`--${name} needs an integer, got ${JSON.stringify(value)}`);
  }
  return Number.parseInt(value, 10);
}

/**
 * The flags that were given but are not in `known`, sorted.
 *
 * A CLI that ignores an unrecognised flag is a CLI where a typo does the wrong thing
 * quietly, which is the failure this project keeps finding: `cchat ingest --sampl 400`
 * would ingest every archive rather than 400 matches, and the only symptom is a command
 * that takes half an hour.
 */
export function unknownFlags(
  flags: Map<string, string | true>,
  known: ReadonlySet<string>,
): string[] {
  return [...flags.keys()].filter((name) => !known.has(name)).sort();
}
