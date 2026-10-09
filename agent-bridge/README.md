# API / 本地 Agent 双模式（开发预览）

本分支为 AI-Marker-Suite 添加 API / Agent 两个模式，默认仍使用原来的 API。
教师无须在评分方式界面分别选择 Codex / WorkBuddy 等 Agent。
智学网和七天网络等平台适配器、评分与提交逻辑未改动。

## 快速使用

需要 Node.js 20+，以及已安装且完成登录的 Codex CLI。
在本机运行命令：

    codex login
    node agent-bridge/server.js

Bridge 仅监听本机 127.0.0.1:37521；首次启动在终端打印配对令牌，
并将其保存于 ~/.ai-marker-agent/pairing-token。不要提交或分享令牌。
在 AI-Marker-Suite 设置页，选择“本地 Agent”，输入配对令牌并保存。
系统以本机 Agent 代替云端 API 执行单模型评分任务；切回 API
则沿用原有模型工作流。

## 实现和限制

- 当前真正实现的是 Codex CLI 执行器；WorkBuddy 尚未接入，本分支不会
  伪称已兼容。要接入其他 Agent，还需在 Bridge 中添加相应的连接器。
- 本机运行 Agent 并不意味着本地推理；Codex 可能把学生答卷发送到云端。
  必须获得学校对答卷处理的适当授权。
- Agent 模式暂不支持原有双评功能；API 模式保持双评原有行为。
- Bridge 需要配对令牌；只接受内联 PNG/JPEG/WebP 图片。
  图片写入私有临时目录，任务完成或失败时删除。
- 对于无法可靠评分的答卷，Agent 可以要求人工复核；
  此时 Bridge 返回错误而原用户脚本应暂停批改。
- 测试建议使用模拟或脱敏答卷，先以试改模式验证，再考虑自动提交。
- 本版本未经真实 Codex 登录环境、不同 Windows 版本与智学网/七天
  正式生产页面端到端验证；不可将单元测试通过视为生产可靠性证明。

## 构建和测试

    npm install
    npm test
    npm run build

新文件：agent-bridge/server.js、src/core/agent-mode.js、tests/agent-bridge.test.js。
