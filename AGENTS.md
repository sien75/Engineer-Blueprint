# AGENTS.md — Engineer-Blueprint

## Git Workflow (Must Commit & Push via `my-server`)

**Never run `git commit` or `git push` directly from the local machine.**

- `my-server` repository path: `~/GithubCode/Engineer-Blueprint`
- Commit identity: use the git `user.name` and `user.email` already configured on `my-server`

### Pre-Commit Sensitive Information Check

Before every commit, check for the following three categories. If any potential issue is found, confirm with the user first; if none are found, state so explicitly:

1. **Local paths & usernames**: `/Users/<name>`, `/home/<name>`, local hostnames, etc.
2. **Credentials & secrets**: API keys, tokens, `.env` files, private keys, etc.
3. **Personal data & private addresses**: email addresses, phone numbers, internal domains/IPs, runtime `.db`/`.sqlite`/log files, etc.

### Commit Procedure

1. **Verify scope and check for sensitive data locally**
   - Run `git status` and `git diff` locally to review the files and changes to be committed. Complete the sensitive information check and confirm with the user.
2. **Connect to `my-server` and sync with remote**
   - Run `ssh my-server`, enter `~/GithubCode/Engineer-Blueprint`, and run `git pull` to stay up to date with the remote.
3. **Transfer local changes to `my-server`**
   - Modified tracked files: generate a patch locally (e.g., `git diff`), send it to `my-server:~/GithubCode/Engineer-Blueprint`, and apply it with `git apply`.
   - New untracked files or deletions: transfer new files via `tar` or file copy, and mirror any file deletions on `my-server`.
4. **Commit and push on `my-server`**
   - Verify the repository's configured git identity (`git config user.name` and `git config user.email`).
   - Run `git add`, `git commit`, and `git push`.
5. **Clean local workspace and pull**
   - Back on the local machine, discard local working-tree changes (`git checkout -- .` and remove any newly committed untracked files), run `git pull` to fetch the commit, and verify `git status` is clean.
6. **Report the result**
   - Report the commit hash, commit message, and list of modified files.
