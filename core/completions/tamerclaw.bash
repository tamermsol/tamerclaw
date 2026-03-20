#!/bin/bash
# Bash completions for TamerClaw CLI
# Source this file:  source <tamerclaw-home>/core/completions/tamerclaw.bash
# Or symlink to /etc/bash_completion.d/tamerclaw

_tamerclaw_completions() {
    local cur prev
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    # Top-level subcommands
    local commands="init update start stop restart status logs agents add-agent set-token test test-claude send cron-list version help"

    # If completing the first argument, offer subcommands
    if [[ ${COMP_CWORD} -eq 1 ]]; then
        COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
        return 0
    fi

    # Helper: dynamically read agent IDs from config.json
    _tc_agent_ids() {
        local home="${TAMERCLAW_HOME:-$(cd "$(dirname "$(command -v tamerclaw 2>/dev/null || echo .)")" && pwd)}"
        local config="$home/user/config.json"
        if [[ -r "$config" ]] && command -v node &>/dev/null; then
            node -e "
                const c = JSON.parse(require('fs').readFileSync('${config}','utf-8'));
                console.log(Object.keys(c.agents).join(' '));
            " 2>/dev/null
        fi
    }

    local subcmd="${COMP_WORDS[1]}"

    case "${subcmd}" in
        start|stop|restart)
            if [[ ${COMP_CWORD} -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "bridge supreme all --foreground" -- "${cur}") )
            fi
            ;;
        logs)
            if [[ ${COMP_CWORD} -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "bridge supreme all" -- "${cur}") )
            fi
            ;;
        set-token)
            if [[ ${COMP_CWORD} -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "$(_tc_agent_ids)" -- "${cur}") )
            fi
            ;;
        test)
            if [[ ${COMP_CWORD} -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "--all $(_tc_agent_ids)" -- "${cur}") )
            fi
            ;;
        send)
            if [[ ${COMP_CWORD} -eq 2 ]]; then
                COMPREPLY=( $(compgen -W "$(_tc_agent_ids)" -- "${cur}") )
            fi
            ;;
        add-agent)
            if [[ ${COMP_CWORD} -eq 3 ]]; then
                # Complete directories for agent path
                COMPREPLY=( $(compgen -d -- "${cur}") )
            fi
            ;;
        # These subcommands take no arguments
        init|update|status|agents|test-claude|cron-list|version|help)
            COMPREPLY=()
            ;;
    esac

    return 0
}

complete -F _tamerclaw_completions tamerclaw
complete -F _tamerclaw_completions ./tamerclaw
