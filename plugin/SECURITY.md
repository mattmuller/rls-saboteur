# Security

Report a security problem privately, not in a public issue:
https://github.com/mattmuller/rls-saboteur/security/advisories/new

Please include what you ran, what happened, and the version (`rls-saboteur --version` or the package version).

## What this tool does to your system

- It refuses any database that is not local unless you pass `--allow-remote-i-understand-this-locks-tables`.
- It never reads your rows. It reads the catalogue and runs your own tests.
- For each break it creates a temporary copy of the database (`saboteur_<pid>_<n>`), changes one policy
  inside that copy, runs your tests against it, then drops the copy.
- It never changes the database you point it at, and never changes a setting of it. Every connection to it is
  opened read-only and only plain `SELECT` reads are allowed through (src/guard.ts). There is no in-place mode:
  it was removed in 0.2.0 because it changed the real database.
- Every copy is labelled (`COMMENT ON DATABASE ... 'rls-saboteur copy <token>'`). It drops only labelled copies:
  the name must start with `saboteur_`, must not be your database, and the label must match this run, or belong
  to a run whose process has died.
- It closes other sessions on the source only on a local host, only after you answer yes, and never with
  `--no-terminate` or the remote flag.
- Before copying anything it prints a plan and asks `Continue? (y/N)`. With no terminal it exits 2 unless you
  pass `--yes`. A test command from `.rls-saboteur.json` is shown and confirmed before it runs.
- A `.rls-saboteur.json` `test` value and `--test` run as shell commands, like `package.json` scripts.
  Run the tool only in projects you trust.
- Never pass untrusted text (pull request titles, branch names, comment bodies) to the Action's `extra-args`
  or `test` inputs. Use `permissions: contents: read` on workflows that use the Action.
- A crash (`SIGKILL`, power loss) cannot leave your database changed. It can leave a copy named `saboteur_...`.
  The next run drops it if it is labelled and its process is dead. A copy that crashed between `CREATE DATABASE`
  and its label is never dropped by the tool. Drop it by hand.
- The test command (`--test` or the config file) is your own code. It receives the address of a copy only, but it
  is a shell command and runs as you.
