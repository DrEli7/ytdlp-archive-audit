# Contributing

欢迎提交可复现的问题或小范围 PR。请先说明真实工作流、输入格式与预期结果；不要上传个人资料、凭据、真实私人媒体信息或商业库存数据。

1. 用合成样例复现问题，保留必要的格式与边界。
2. 在 Node.js 22+ 运行 `npm ci --ignore-scripts`、`npm test`。
3. 修改行为时更新相关单元/CLI 测试与 README。
4. 保持离线、只读输入和明确退出码。新格式先考虑复用成熟解析库。
5. PR 说明测试命令、结果和兼容范围；不要以删除测试来处理失败。

English contributions are welcome. Keep fixtures synthetic, changes focused, and claims supported by reproducible tests. Dependencies should remain pinned with the lockfile committed. MIT-licensed contributions only.

