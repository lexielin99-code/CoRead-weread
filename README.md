# CoRead — AI 共读伙伴

> *We read to know we are not alone.*

在微信读书里划线，AI 立刻接话讨论。不是问答工具，是一个有自己观点、会记得你读过什么的长期共读伙伴。

---

## 它做什么

- **划线即开聊**：在微信读书选中一段文字，填写（或不填）你的第一反应，发送后 AI 几秒内接话，有观点，会交锋
- **跨书记忆**：讨论时自动检索你读过的其他书，有相关的就带出来（"你之前读的那本心理学书里提到过类似的……"）
- **沉淀不丢失**：每次讨论的收口 takeaway 写入本地文件；章节读完自动生成摘要；重启后记忆仍在
- **侧栏 UI**：Chrome Side Panel 原生展示聊天记录，不遮挡正文，不变形
- **进度门控**：只引用你实际读过的章节内容，不靠训练知识臆测后文

---

## 架构

```
微信读书网页
  │  划线 / 章节切换
  ▼
Chrome Extension (extension/)
  │  POST /annotation  POST /content  POST /chapter-complete
  ▼
本地接收端 receiver/index.js  :7239
  │  写 inbox/annotations.jsonl
  │  写 books/{bookId}/chapters/{chapterUid}.txt
  │  SSE 推送 → Chrome Side Panel
  ▼
Agent  agent/index.js
  │  轮询 annotations.jsonl（游标跳过已处理）
  │  recall.js 跨书检索
  │  调用 LLM API（OpenAI 兼容）
  │  写 chat_output.jsonl → SSE → 侧栏显示
  └─ 会话结束：合并重写 profile.md / soul.md
```

---

## 快速开始

### 前置要求

- Node.js 18+
- Chrome 浏览器
- 任意 OpenAI 兼容的 LLM API Key（支持 GPT-4o、DeepSeek、Kimi、Ollama 本地等）
- 微信读书网页版账号（weread.qq.com）

### 1. 克隆项目

```bash
git clone https://github.com/your-username/coread.git
cd coread
```

### 2. 启动本地接收端

```bash
cd receiver
npm install
node index.js
# 监听 http://localhost:7239
```

### 3. 配置并启动 Agent

```bash
cd agent
npm install
cp .env.example .env
# 编辑 .env，填入 COREAD_API_KEY / COREAD_API_BASE / COREAD_MODEL
npm start
```

`.env` 配置示例：

```env
# DeepSeek
COREAD_API_KEY=sk-xxx
COREAD_API_BASE=https://api.deepseek.com/v1
COREAD_MODEL=deepseek-chat

# 本地 Ollama（无需 key）
COREAD_API_KEY=ollama
COREAD_API_BASE=http://localhost:11434/v1
COREAD_MODEL=qwen2.5:14b
```

### 4. 加载 Chrome 扩展

1. 打开 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」，选择 `extension/` 目录
4. 打开 [weread.qq.com](https://weread.qq.com) 进入任意书籍阅读页

### 5. 开始共读

- 在正文里选中一段文字，弹出标注窗口
- 填入你的想法（或留空直接发送）
- Agent 终端和右侧 Side Panel 同时给出回应

---

## 目录结构

```
coread/
├── extension/          # Chrome MV3 扩展
│   ├── manifest.json
│   ├── content.js      # 标注弹窗、章节切换检测
│   ├── service_worker.js   # 章节正文网络拦截
│   ├── sidebar.html/js     # Chrome Side Panel 聊天 UI
│   └── page_hook.js    # MAIN world 注入，拦截 clipboard
│
├── receiver/           # 本地 HTTP 接收端（localhost:7239）
│   ├── index.js
│   ├── inbox/          # annotations.jsonl / chat_*.jsonl
│   └── books/
│       └── {bookId}/
│           ├── chapters/   # 章节正文缓存 .txt
│           ├── summaries.md    # 滚动章节摘要
│           └── discussions.jsonl   # 讨论 takeaway
│
└── agent/              # AI Agent
    ├── index.js        # 主进程：轮询 → LLM → 输出
    ├── AGENT.md        # Agent 行为规则（系统提示词）
    ├── profile.md      # 你的阅读画像（自动维护）
    ├── soul.md         # Agent 的立场与记忆（自动维护）
    ├── open_topics.md  # 未聊透的话题
    └── scripts/
        ├── recall.js   # 跨书记忆检索
        ├── coldstart.js    # 冷启动：从微信读书 API 拉取历史
        └── inject.sh   # tmux 消息注入
```

---

## Token 控制设计

随着书读得越多，上下文不会线性膨胀：

- **Inbox 游标**：已处理的标注通过游标跳过，不重复读取
- **按需加载**：每次讨论只加载当前书的章节窗口（±300字）和摘要，其他书不进上下文
- **跨书检索**：其他书的记忆通过 `recall.js` 关键词检索，只把命中的 2-3 句 takeaway 带入
- **记忆合并**：`profile.md` / `soul.md` 每次会话结束时合并重写而非追加，文件长度保持稳定

---

## 隐私说明

所有数据（章节正文、标注、对话记录）均存储在本地 `receiver/` 目录，不上传任何服务器。LLM API 调用只发送当前讨论的片段，不发送完整书库。

---

## .gitignore 建议

```gitignore
agent/.env
agent/profile.md
agent/soul.md
agent/.coldstart_skipped
receiver/books/
receiver/inbox/
```

---

## License

MIT
