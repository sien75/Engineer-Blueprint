# AGENTS.md — Engineer-Blueprint

## Git 提交规范（必须通过 `my-server`）

**严禁在本机直接执行 `git commit` 或 `git push` 到 GitHub（Never commit or push directly from the local machine）。**

- 远端仓库：`git@github.com:sien75/Engineer-Blueprint.git`
- `my-server` 仓库路径：`~/GithubCode/Engineer-Blueprint`
- `my-server` 提交身份：`user.name = sien75`、`user.email = smooooooe@hotmail.com`

### 提交前敏感信息检查

每次提交前必须检查以下三类内容；发现疑似项先向用户确认，未发现则明确说明：

1. **本地路径与用户名**：`/Users/<name>`、`/home/<name>`、本机主机名等
2. **凭据与密钥**：API key、token、`.env`、私钥等
3. **个人数据与私有地址**：邮箱、手机号、内网域名/IP、运行时 `.db`/`.sqlite`/日志等文件

### 提交流程

1. **本地确认范围与敏感信息检查**
   - 在本机运行 `git status` / `git diff`，确认本次要提交的文件清单与改动内容，完成敏感信息检查后向用户确认。
2. **登录 `my-server` 并同步远端**
   - `ssh my-server` 进入 `~/GithubCode/Engineer-Blueprint`，先执行 `git pull` 保持与远端同步。
3. **将本地改动同步到 `my-server`**
   - 已跟踪文件的修改：本地生成 patch（如 `git diff`）发到 `my-server:~/GithubCode/Engineer-Blueprint` 后执行 `git apply`。
   - 新增未跟踪文件或删除：通过 `tar` / 文件拷贝同步新增文件，并在 `my-server` 上同步删除对应文件。
4. **在 `my-server` 上提交并推送**
   - 确认仓库内局部配置：
     ```bash
     git config user.name "sien75"
     git config user.email "smooooooe@hotmail.com"
     ```
   - 执行 `git add`、`git commit` 与 `git push`。
5. **本地清理并拉取同步**
   - 回到本机清掉工作区改动（`git checkout -- .` 并清理已提交的新增未跟踪文件），执行 `git pull` 拉回提交，确认 `git status` 干净。
6. **汇报结果**
   - 汇报提交 hash、commit message 与涉及文件清单。
