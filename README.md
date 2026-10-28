# yt-dlp Archive Audit

离线核对 **yt-dlp download archive、`.info.json` 和本地媒体**：找出 archive 中无法核验的记录、没有 archive 的 sidecar、零长度文件、同一记录的多个候选文件。

**English:** Read-only reconciliation of yt-dlp download archives and adjacent media files. It reports evidence and uncertainty; it never edits an archive, deletes a file, retries downloads, or contacts a website.

## 为什么存在

[yt-dlp](https://github.com/yt-dlp/yt-dlp) 已负责下载、后处理与 archive 去重。本工具不复制下载器；它补上本地归档维护时的一步：移动目录、手工整理或恢复备份之后，快速检查 archive 与现有 sidecar 是否还能对应。无需数据库、账号或 Web 服务。

没有 sidecar 的 archive 条目只能标记 **archive-only / 无法核验**，绝不会因为没匹配到文件就声称文件已删除。适用于保留 `--write-info-json`、且 JSON 与媒体使用相同文件名主体的常见目录布局。

## 开始

需要 Node.js 22 或更新版本。无第三方运行时依赖。当前通过 GitHub 获取，未声明发布到 npm。

```sh
git clone https://github.com/DrEli7/ytdlp-archive-audit.git
cd ytdlp-archive-audit
npm ci --ignore-scripts
npm test
npm run demo
```

示例输出包含：1 个 `present`、1 个 `missing-media`、1 个 `archive-only`、1 个 `sidecar-only`。`examples/` 完全是合成数据；`present.mp4` 是明确标注的文本夹具，**不是可播放视频**。这也说明本工具仅检查存在性与字节数，不验证解码或内容完整性。

```sh
node src/cli.mjs --archive downloads.txt --root ./videos
node src/cli.mjs --archive downloads.txt --root ./videos --format json > audit.json
node src/cli.mjs --archive downloads.txt --root ./videos --check

# 用自己的媒体扩展名白名单替换默认列表
node src/cli.mjs --archive downloads.txt --root ./videos --extensions mp4,mkv,mp3,m4a
```

使用输出重定向时写入**新文件**，不要覆盖 archive 或 sidecar。正常报告退出 0；`--check` 在存在需审查条目或诊断时退出 1；参数/文件系统读取失败退出 2。未知参数也会失败，防止拼写错误悄悄改变审查范围。

## 判定规则

| 状态 | 确实观察到的事实 |
| --- | --- |
| `present` | 一个 sidecar 对应一个非空、允许扩展名的相邻同主体文件 |
| `archive-only` | archive 有记录，扫描中没有可用的对应 sidecar；**无法核验** |
| `sidecar-only` | sidecar 不匹配任何 archive 记录；另附其 `mediaStatus` |
| `missing-media` | 对应 sidecar 存在，但没有相邻同主体的允许媒体文件；需人工核对布局/重命名 |
| `zero-length` | 匹配到的唯一候选文件是 0 字节 |
| `ambiguous` | 同一 archive 记录有多个 sidecar，或一个 sidecar 有多个媒体候选 |

归档键使用 `extractor_key`（或 `ie_key`）转小写，再加原样视频 ID；支持 sidecar 内 `_old_archive_ids` 的兼容别名。这个映射来自 [yt-dlp 的 archive 实现](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/YoutubeDL.py) 与 [`make_archive_id`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/utils/_utils.py)。

**为什么不用 JSON 里的 `filepath`？** yt-dlp 的 `sanitize_info` 在清理 JSON 时会移除 `filepath`、`_filename` 等字段；这些字段也可能指向旧机器路径。本工具始终只使用扫描到的文件，不沿 metadata 中的路径访问文件。

例如 `讲座 [abc].info.json` 可以匹配相邻 `讲座 [abc].mp4`、`.mkv`、`.mp3` 等，以适应后处理改扩展名。如果两个都存在，保留歧义。`.part`、字幕、封面、日志不被当成媒体。默认扩展名见 `src/index.mjs`，匹配主体区分大小写。若你用 `-P infojson:` 分开保存、重命名文件、保留多个格式或使用自定义输出模板，应预期更多待人工审查的结果。

## 隐私与边界

- 扫描用户指定目录；跳过符号链接/目录联接，不跟随 sidecar 声明路径。根目录必须是实际目录；扫描期间请避免并发移动或替换文件。此工具不作为对抗恶意本地进程的文件系统沙箱。
- 无网络请求，不改 archive 或媒体。只把报告写到 stdout。默认不输出视频标题、描述、cookies、请求头或网页 URL。
- 如果确需 URL，可使用 `--format json --include-urls`。它只接受没有嵌入用户名/密码的 HTTP(S) URL；query 可能有私有 token，请检查报告后再分享。该选项不会执行下载。
- 单个 sidecar 默认上限 16 MiB；损坏、过大的 JSON、缺少标识符和 playlist sidecar 会报告并跳过，不默认为“已验证”。未读到的 sidecar 可能导致对应条目 `archive-only`。
- 只能核验一个指定媒体根目录；不能证明文件未保存在其他位置，也不能验证媒体可播放、hash 或下载完整性。默认清理 JSON 中没有保留下来的旧 archive 别名无法恢复。
- 扫描与匹配为内存索引，适合本地媒体库；极大目录请按子目录分别审查。不要把没有 sidecar 的未知记录批量从 archive 删除。

## 库接口与测试

```js
import { auditArchive } from './src/index.mjs';
const report = await auditArchive(archiveText, './videos');
console.log(report.summary);
```

`npm test` 覆盖身份映射、兼容别名、缺失与未知的区别、重复/多格式歧义、零长度、损坏 JSON、不可信 metadata 路径、URL 隐私、符号链接、大小上限、CLI 退出码与输入保持不变。CI 为 Ubuntu / Windows、Node 22 / 24。

MIT License。独立社区工具，与 yt-dlp 无官方关联。
