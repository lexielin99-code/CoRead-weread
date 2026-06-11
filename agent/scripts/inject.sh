#!/usr/bin/env bash
# CoRead tmux 注入脚本
# 从 receiver/inbox/pending.txt 读取第一条消息，注入到 tmux 里运行的 CoRead agent。
#
# 使用方式：
#   1. 在 tmux 里把运行 `node agent/index.js` 的窗口命名为 coread：
#      tmux rename-window coread
#   2. 或者设置环境变量：export COREAD_TMUX_TARGET="session:window.pane"
#
# 默认 target：当前 session 第一个名为 coread 的 window

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PENDING_FILE="$SCRIPT_DIR/../../receiver/inbox/pending.txt"

if [ ! -f "$PENDING_FILE" ]; then
  exit 0
fi

MSG=$(head -1 "$PENDING_FILE")
if [ -z "$MSG" ]; then
  exit 0
fi

# 确定注入 target
TARGET="${COREAD_TMUX_TARGET:-}"
if [ -z "$TARGET" ]; then
  # 自动找名为 coread 的 window
  TARGET=$(tmux list-windows -a -F "#{session_name}:#{window_name}.0" 2>/dev/null | grep ":coread\." | head -1)
fi
if [ -z "$TARGET" ]; then
  # fallback：当前 session 第一个 pane
  TARGET=$(tmux display-message -p "#{session_name}:#{window_index}.#{pane_index}" 2>/dev/null)
fi
if [ -z "$TARGET" ]; then
  echo "[inject] 未找到 tmux target，消息未注入" >&2
  exit 1
fi

# 注入
tmux send-keys -t "$TARGET" "$MSG" Enter

# 移除已注入条目
sed -i '' '1d' "$PENDING_FILE"

echo "[inject] → $TARGET: ${MSG:0:60}..."
