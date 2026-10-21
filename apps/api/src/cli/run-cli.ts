/**
 * Operator commands that ship in the API image (roadmap 9.22). A production
 * host holds the compose files and the images, not a checkout: the image
 * carries `dist` and the production dependencies only (no `scripts/`, no
 * ts-node), so a command a runbook or `docs/SECRETS.md` tells an operator to
 * run must be compiled with the API. In the container:
 * `node dist/cli/<command> ...` (`dc exec api ...`); from a checkout,
 * `npm run <command>` runs the same module through `scripts/`, which loads
 * `.env.local` / `.env` first. Found walking DukaanAiReconciliationStale:
 * the documented `npm run` commands answered `ts-node: not found` on the host.
 */

/** A command's entry: the arguments after the script name; resolves to the exit code. */
export type CliCommand = (argv: string[]) => Promise<number>;

/** A refusal the operator can correct (arguments, environment, an unknown id): printed as `error: ...`, exit 2. */
export class CliUsageError extends Error {}

/**
 * Runs a command and answers its exit code: whatever it returns (0 done,
 * 1 a finding such as drift), or 2 when it throws, with the message on
 * stderr. Never rejects.
 */
export async function runCli(command: CliCommand, argv: string[]): Promise<number> {
  try {
    return await command(argv);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

/**
 * The module-level entry of a command file. It sets `process.exitCode`
 * instead of calling `process.exit`, which can cut off output still being
 * written to a pipe (a `--json` report read by a script).
 */
export function runAsMain(command: CliCommand): void {
  void runCli(command, process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
