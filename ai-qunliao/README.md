# AI 群聊中转站

`worker.js` 是部署在 Cloudflare Workers 上的中转站：

- `/admin`：带密码的设置页，用来填写、更换各家 API key，每家都能单独测试。
- `/mcp`：MCP 连接器入口，请求头 `X-Qunliao-Key` 要带上门票（`MCP_SECRET`）。添加到 claude.ai 后，群聊页面通过它调用 GPT、Gemini、Grok、DeepSeek、Kimi、Qwen、GLM。

Claude 本身不走这里，直接在群聊页面里用套餐额度调用。

## 部署（全程在 Cloudflare 网页后台操作）

1. **新建 Worker**：Workers & Pages → Create → 选 Hello World 模板 → 名字填 `ai-qunliao` → Deploy。
2. **粘贴代码**：进入这个 Worker → Edit code → 删掉编辑器里原有的全部内容 → 把 `worker.js` 整个粘进去 → Deploy。
3. **建 KV 存储**：Storage & Databases → KV → Create，名字填 `qunliao`。
4. **绑定 KV**：回到 Worker → Settings → Bindings → Add → KV namespace。变量名必须填 `KV`（大写），命名空间选 `qunliao`。
5. **加两个机密**：Worker → Settings → Variables and Secrets → Add，类型选 **Secret**：
   - `ADMIN_PASSWORD`：设置页密码，自己定。
   - `MCP_SECRET`：一串 30 位以上、只含字母和数字的随机字符（可以用密码管理器生成）。它是连接器的门票，谁拿到谁就能花你的 key，不要外传、不要截图。
6. **打开设置页**：`https://ai-qunliao.<你的子域名>.workers.dev/admin`，输入密码，填 key 和模型名，点每一栏的“测试”确认能通。
7. **添加连接器**：claude.ai → 设置 → 连接器 → 添加自定义连接器：
   - 名字：`qunliao`
   - 网址：`https://ai-qunliao.<你的子域名>.workers.dev/mcp`（网址里没有秘密，可以截图）
   - 认证：No sign-in
   - Request headers → Add header：名字填 `X-Qunliao-Key`，值用设置页的“复制门票”按钮复制后粘贴

## 换门票

怀疑门票泄露时：在 Cloudflare 里把 `MCP_SECRET` 改成新的随机字符，然后在 claude.ai 删掉 `qunliao` 连接器，按第 7 步重新添加。

## 换 key

打开设置页，在对应那栏粘贴新 key → 保存 → 测试。活动送的 key 如果来自硅基流动、魔搭等第三方平台，记得把“接口地址”和“模型名”也改成那个平台给的。
