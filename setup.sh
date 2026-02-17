#!/usr/bin/env bash
set -e

echo "================================"
echo "  Claude Sidebar - Setup"
echo "================================"
echo ""

OS="$(uname -s)"

# ── macOS ──
if [ "$OS" = "Darwin" ]; then
  echo "[*] Detected macOS"

  # Xcode Command Line Tools
  if ! xcode-select -p &>/dev/null; then
    echo "[+] Installing Xcode Command Line Tools..."
    xcode-select --install
    echo "    Waiting for installation to complete..."
    until xcode-select -p &>/dev/null; do
      sleep 5
    done
    echo "    Done."
  else
    echo "[✓] Xcode Command Line Tools already installed"
  fi

  # Node.js
  if ! command -v node &>/dev/null; then
    echo "[+] Installing Node.js..."
    if command -v brew &>/dev/null; then
      brew install node
    else
      echo "    Installing Homebrew first..."
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      brew install node
    fi
  else
    echo "[✓] Node.js $(node -v) found"
  fi

  # Claude CLI
  if ! command -v claude &>/dev/null; then
    echo "[+] Installing Claude CLI..."
    npm install -g @anthropic-ai/claude-code
  else
    echo "[✓] Claude CLI found"
  fi

# ── Linux ──
elif [ "$OS" = "Linux" ]; then
  echo "[*] Detected Linux"

  # Build tools
  if ! command -v gcc &>/dev/null || ! command -v make &>/dev/null; then
    echo "[+] Installing build essentials..."
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq
      sudo apt-get install -y build-essential python3
    elif command -v dnf &>/dev/null; then
      sudo dnf groupinstall -y "Development Tools"
      sudo dnf install -y python3
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm base-devel python
    fi
  else
    echo "[✓] Build tools found"
  fi

  # Node.js
  if ! command -v node &>/dev/null; then
    echo "[+] Installing Node.js..."
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y nodejs
    elif command -v pacman &>/dev/null; then
      sudo pacman -S --noconfirm nodejs npm
    fi
  else
    echo "[✓] Node.js $(node -v) found"
  fi

  # Claude CLI
  if ! command -v claude &>/dev/null; then
    echo "[+] Installing Claude CLI..."
    npm install -g @anthropic-ai/claude-code
  else
    echo "[✓] Claude CLI found"
  fi

# ── Windows (Git Bash / MSYS2) ──
elif [[ "$OS" == MINGW* ]] || [[ "$OS" == MSYS* ]] || [[ "$OS" == CYGWIN* ]]; then
  echo "[*] Detected Windows"

  # Node.js
  if ! command -v node &>/dev/null; then
    echo "[!] Node.js not found. Please install from: https://nodejs.org"
    exit 1
  else
    echo "[✓] Node.js $(node -v) found"
  fi

  # WSL
  if ! command -v wsl.exe &>/dev/null; then
    echo "[!] WSL not found. Please install WSL:"
    echo "    wsl --install"
    echo "    Then install Claude CLI inside WSL:"
    echo "    wsl bash -c 'npm install -g @anthropic-ai/claude-code'"
    exit 1
  else
    echo "[✓] WSL found"
    # Check Claude inside WSL
    if wsl.exe bash -c "command -v claude" &>/dev/null; then
      echo "[✓] Claude CLI found in WSL"
    else
      echo "[+] Installing Claude CLI in WSL..."
      wsl.exe bash -c "npm install -g @anthropic-ai/claude-code"
    fi
  fi
fi

echo ""
echo "[*] Installing dependencies..."
npm install

echo ""
echo "================================"
echo "  Setup complete!"
echo "  Run: npm start"
echo "================================"
