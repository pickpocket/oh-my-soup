#!/bin/sh
set -e

# OMS Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/pickpocket/oh-my-soup/main/scripts/install.sh | sh
#
# Options:
#   --ref <tag>    Install a specific release tag instead of the latest
#   -r <tag>       Shorthand for --ref
#
# Installs the prebuilt single-file binary and its local LLVM objdump dependency.

REPO="pickpocket/oh-my-soup"
INSTALL_DIR="${OMS_INSTALL_DIR:-${PI_INSTALL_DIR:-$HOME/.local/bin}}"

REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done


# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

install_binary() {
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)         echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    BINARY="oms-${PLATFORM}-${ARCH}"
    # Get release tag
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        if RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/tags/${REF}"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
        else
            echo "Release tag not found: $REF"
            echo "Available releases: https://github.com/${REPO}/releases"
            exit 1
        fi
    else
        echo "Fetching latest release..."
        RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "https://api.github.com/repos/${REPO}/releases/latest")
        LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to fetch release tag"
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    # Download binary
    BINARY_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    if ! curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "${INSTALL_DIR}/oms"; then
        echo ""
        echo "✗ ${LATEST} has no ${BINARY} asset."
        echo "  See https://github.com/${REPO}/releases/tag/${LATEST} for what it ships."
        exit 1
    fi
    chmod +x "${INSTALL_DIR}/oms"

    # Verify the freshly installed binary can actually start before reporting
    # success. Bun's musl-target binaries link libstdc++/libgcc dynamically,
    # which stock Alpine/musl systems do not ship, so the download succeeds while
    # the binary exits 127 with relocation errors. Never claim success for a
    # binary that cannot run.
    if ! SMOKE_OUTPUT="$("${INSTALL_DIR}/oms" --version 2>&1)"; then
        echo ""
        echo "✗ oms was downloaded to ${INSTALL_DIR}/oms but cannot start:"
        echo "$SMOKE_OUTPUT" | sed 's/^/    /'
        if [ "$PLATFORM" = "linux-musl" ]; then
            echo ""
            echo "The musl build links libstdc++/libgcc dynamically. Install them, then re-run 'oms':"
            if command -v apk >/dev/null 2>&1; then
                echo "    apk add libstdc++ libgcc"
            else
                echo "    (install the libstdc++ and libgcc runtime packages for your distro)"
            fi
        fi
        exit 1
    fi

    # The installer can come from main while the binary is an older release.
    # Probe the downloaded CLI rather than assuming it has main's components.
    if SETUP_HELP="$("${INSTALL_DIR}/oms" setup --help 2>&1)"; then
        :
    else
        SETUP_STATUS=$?
        echo "Could not determine the installed release's setup components:" >&2
        printf '%s\n' "$SETUP_HELP" >&2
        exit "$SETUP_STATUS"
    fi
    if printf '%s\n' "$SETUP_HELP" | grep -Eq '(^|[[:space:]|()])objdump($|[[:space:]|()])'; then
        echo "Installing local LLVM objdump..."
        if "${INSTALL_DIR}/oms" setup objdump; then
            :
        else
            SETUP_STATUS=$?
            echo "oms was installed, but LLVM objdump setup failed." >&2
            echo "Check the error above, then retry: \"${INSTALL_DIR}/oms\" setup objdump" >&2
            exit "$SETUP_STATUS"
        fi
    else
        echo "Release $LATEST does not support managed LLVM objdump setup; skipping objdump installation."
    fi

    echo ""
    echo "✓ Installed oms to ${INSTALL_DIR}/oms"

    # An oms earlier on PATH (a previous `bun install -g`, Homebrew, ...) keeps
    # winning over this install until it is removed or INSTALL_DIR moves ahead.
    ACTIVE_OMS="$(command -v oms 2>/dev/null || true)"
    if [ -n "$ACTIVE_OMS" ] && ! [ "$ACTIVE_OMS" -ef "${INSTALL_DIR}/oms" ]; then
        echo "'oms' still resolves to ${ACTIVE_OMS}; remove that install or put ${INSTALL_DIR} ahead of it on PATH."
        return
    fi

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'oms' to get started!" ;;
        *) print_path_hint ;;
    esac
}

# Print $1 in single quotes, so POSIX shells read it literally.
sh_quote() {
    printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Print $1 in double quotes, so fish reads it literally. fish expands only $
# inside them and treats \ as an escape, so escape \, " and $.
fish_quote() {
    printf '"%s"' "$(printf '%s' "$1" | sed 's/[\\"$]/\\&/g')"
}

# Print path $1 for the user to paste: ~/<rest> when it is in the home
# directory and has no characters a shell treats specially, otherwise quoted
# with the quoting function $2.
display_path() {
    case "$1" in
        "$HOME"/*)
            rest="${1#"$HOME"/}"
            case "$rest" in
                *[!A-Za-z0-9._/+-]*) ;;
                *)
                    printf '%s/%s' "~" "$rest"
                    return
                    ;;
            esac
            ;;
    esac
    "$2" "$1"
}

# Tell the user that INSTALL_DIR is not on PATH and print one command, for
# their login shell, that adds it to the shell's startup file and loads it.
print_path_hint() {
    # The startup file each shell reads, and the command that loads it into
    # the current shell. fish needs no file: fish_add_path saves the change.
    rc_file=""
    load_cmd="source"
    case "$(basename "${SHELL:-sh}")" in
        zsh) rc_file="${ZDOTDIR:-$HOME}/.zshrc" ;;
        bash)
            if [ "$(uname -s)" = "Darwin" ]; then
                # Terminals on macOS start bash as a login shell, which reads
                # only the first of these files that exists. Creating
                # ~/.bash_profile would hide an existing ~/.profile.
                rc_file="$HOME/.bash_profile"
                for login_file in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
                    if [ -f "$login_file" ]; then
                        rc_file="$login_file"
                        break
                    fi
                done
            else
                rc_file="$HOME/.bashrc"
            fi
            ;;
        fish) ;;
        *)
            rc_file="$HOME/.profile"
            load_cmd="."
            ;;
    esac

    if [ -z "$rc_file" ]; then
        path_cmd="fish_add_path $(display_path "$INSTALL_DIR" fish_quote)"
    else
        # Write $HOME instead of the expanded home directory so the line stays
        # correct if the home directory moves. The startup file reads the path
        # inside double quotes, so escape the characters those quotes expand.
        case "$INSTALL_DIR" in
            "$HOME"/*) dir_base="\$HOME/" dir_rest="${INSTALL_DIR#"$HOME"/}" ;;
            *) dir_base="" dir_rest="$INSTALL_DIR" ;;
        esac
        dir_rest="$(printf '%s' "$dir_rest" | sed 's/[\\"$`]/\\&/g')"
        rc_line="export PATH=\"${dir_base}${dir_rest}:\$PATH\""
        # zsh's and dash's echo turn backslashes into escape sequences.
        case "$rc_line" in
            *\\*) write_cmd="printf '%s\\n'" ;;
            *) write_cmd="echo" ;;
        esac
        rc_shown="$(display_path "$rc_file" sh_quote)"
        path_cmd="${write_cmd} $(sh_quote "$rc_line") >> ${rc_shown} && ${load_cmd} ${rc_shown}"
    fi

    # printf, not echo: the echo of macOS /bin/sh turns \n in a path into a
    # line break.
    printf '\n%s is not in your PATH. To add it, run:\n\n' "$INSTALL_DIR"
    printf '  %s\n\n' "$path_cmd"
    echo "Then run 'oms' to get started!"
}

install_binary
