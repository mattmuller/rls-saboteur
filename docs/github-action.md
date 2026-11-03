# GitHub Action

```yaml
- uses: actions/checkout@v4
- uses: mattmuller/rls-saboteur@v1
  with:
    threshold: 95
```

It starts the database container only, runs the tool, writes the report to the job summary, and fails the job below the threshold.

The Action passes `--yes`. A CI run has no terminal to ask on, and the workflow file is your own approval of the plan: temporary copies of the CI database, which is thrown away with the job.

The Action passes `--close-sessions` by default only when `start-supabase` is `true` (the default), because the database is then a throwaway stack that the Action started itself. With `start-supabase: false` the database is yours, so the default is no. Set `close-sessions: true` or `false` to override either way.

## Security

- The action installs `rls-saboteur` from npm with `npx` and runs your tests with the Supabase CLI. It runs nothing else.
- Inputs are never interpolated into scripts. Each one is passed through an environment variable and quoted, so a crafted input cannot inject a command.
- `version` defaults to the version the action release ships with, and `supabase/setup-cli` is pinned. Pin the action itself to a tag or a commit.
- The release step must keep the `version` default in `action.yml` equal to `package.json`.
- The Action checks its inputs before it runs anything: `version` must look like `0.2.0`, `threshold` must be 0 to 100, `jobs` a whole number of 1 or more, `close-sessions` empty, `true` or `false`.
