# Security

Report a security problem privately, not in a public issue:
https://github.com/mattmuller/rls-saboteur/security/advisories/new

Please include what you ran, what happened, and the version (`rls-saboteur --version` or the package version).

## What this tool does to your system

- It refuses any database that is not local unless you pass `--allow-remote-i-understand-this-locks-tables`.
- It never reads your rows. It reads the catalogue and runs your own tests.
- For each break it creates a temporary copy of the database (`saboteur_<pid>_<n>`), changes one policy
  inside that copy, runs your tests against it, then drops the copy.
- With `--isolation in-place` it changes policies on the target database itself and restores them
  afterwards. Use that only on a throwaway local database. Never point the tool at production.
