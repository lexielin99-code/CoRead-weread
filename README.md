# CoRead — AI 共读伙伴

> *We read to know we are not alone.*

---

## 它是什么

大多数 AI 阅读工具的逻辑是：你问，它答，调用全库知识。

CoRead 不是这样。

它和你一起读——**只知道你读过的内容**，不知道后文，不会剧透，不会用它的训练知识抢答你还没读到的部分。你读到哪一页，它的认知边界就在哪一页。

你在微信读书网页版划一段话，写下你的第一反应（或什么都不写），几秒后它在侧栏接话：给出它自己的观点，不是复述，可以不同意你，会交锋。几轮之后它主动收口，沉淀出一句 takeaway。没聊透的话题它记下来，等时机合适再提。

读的书越多，它越懂你。它有两个长期记忆文件：一个记你——你的阅读品味、关注主题、思维习惯；一个记它自己——在讨论中形成的立场、你们之间的共识与分歧、它学会的与你相处的方式。每次共读结束后这两个文件都会更新，不追加，合并重写，永远是当下最准确的快照。

**这是一个对等的讨论伙伴，不是问答工具。**

---

## 核心设计决策

**进度门控（Progress Gating）是产品特性，不是技术妥协。**

即使模型训练知识里有后文的答案，agent 也不会用。它只引用 `receiver/books/{bookId}/chapters/` 里实际存在的章节缓存——那些是你真正读过、由浏览器扩展静默缓存下来的内容。它可以说"这个问题书的后面会回应，读到再聊"，但不会越界。

**你的标注是私密的。**

划线和批注只进入本地系统，不写入微信读书的公开想法/划线。章节正文缓存在本地，不上传任何服务器。

---

## 功能

- **划线即开聊**：选中文字 → 写下你的想法（可选）→ 发送 → 几秒内 AI 接话，有观点，会交锋
- **进度门控**：AI 只知道你读过的内容，不剧透后文，是读到同一页的伙伴
- **跨书记忆**：讨论时自动检索你读过的其他书，有相关就自然带出来
- **长期记忆生长**：阅读画像（profile）和 agent 自画像（soul）随每次共读更新，越来越懂你
- **话题追踪**：没聊透的内容进入 open_topics，设定重提条件，不会丢
- **侧栏 UI**：Chrome Side Panel 原生展示，不遮挡正文
- **完全本地**：所有数据存在你的机器上

---

## 架构

```
微信读书网页版
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

三个组件，没有云端服务，没有数据库。

---

## 快速开始

**前置要求**：Node.js 18+，Chrome，任意 OpenAI 兼容的 LLM API Key（支持 GPT-4o、DeepSeek、Kimi、Ollama 本地等），微信读书网页版账号

### 1. 克隆项目

```bash
git clone https://github.com/lexielin99-code/CoRead-weread.git
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
# 编辑 .env，填入 API 信息
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

在正文里选中一段文字，弹出标注窗口，写下你的想法（或留空直接发送）。Agent 和右侧 Side Panel 同时给出回应。

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
│           ├── chapters/       # 章节正文缓存 .txt
│           ├── summaries.md    # 滚动章节摘要
│           └── discussions.jsonl   # 讨论 takeaway
│
└── agent/              # AI Agent
    ├── index.js        # 主进程：轮询 → LLM → 输出
    ├── AGENT.md        # Agent 行为规则（系统提示词）
    ├── profile.md      # 你的阅读画像（自动维护，gitignored）
    ├── soul.md         # Agent 的立场与记忆（自动维护，gitignored）
    ├── open_topics.md  # 未聊透的话题
    └── scripts/
        ├── recall.js       # 跨书记忆检索
        ├── coldstart.js    # 冷启动：从微信读书 API 拉取历史
        └── inject.sh       # tmux 消息注入
```

---

## Token 控制

读的书越多，上下文不会线性膨胀：

- **Inbox 游标**：已处理的标注通过游标跳过，不重复读取
- **按需加载**：每次讨论只加载当前书的章节窗口（±300字）和摘要，其他书不进上下文
- **跨书检索**：其他书的记忆通过 `recall.js` 关键词检索，只把命中的 2-3 句 takeaway 带入
- **记忆合并**：`profile.md` / `soul.md` 每次会话结束合并重写而非追加，长度保持稳定

---

## 隐私

所有数据（章节正文、标注、对话记录）存储在本地 `receiver/` 目录。LLM API 调用只发送当前讨论片段，不发送完整书库。标注不写入微信读书公开系统。

---

## License

MIT
