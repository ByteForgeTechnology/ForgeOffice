#!/usr/bin/env bash
# ForgeOffice uninstaller: stops and removes ForgeOffice from this server, optionally with all of its data.
# Run as root:  sudo ./uninstall.sh   (it is also copied into the install folder, e.g. /opt/forgeoffice)
# Docker itself is left alone. On a server that is one of several, only this server's parts are removed.

VERSION="@VERSION@"
case "$VERSION" in @*) VERSION="development" ;; esac
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG=/var/log/forgeoffice-install.log
BACKTITLE="ForgeOffice ${VERSION} - Uninstaller"
W=76
PROJECT=forgeoffice
INSTALL_DIR=""

say() { printf '%s\n' "$*" >&2; }
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then exec sudo bash "$0" "$@"; fi
    say "Please run this uninstaller as root."; exit 1
fi
: >>"$LOG" && chmod 600 "$LOG"
command -v whiptail >/dev/null 2>&1 || { say "whiptail is needed (it was installed with ForgeOffice). Install the whiptail/newt package and run this again."; exit 1; }
command -v docker >/dev/null 2>&1 || { say "Docker isn't installed on this server, so there is no ForgeOffice to remove."; exit 1; }
log "ForgeOffice uninstaller started from ${SELF_DIR}"

msg() { whiptail --backtitle "$BACKTITLE" --title "$1" --msgbox "$2" "${3:-14}" $W; }
ask() { whiptail --backtitle "$BACKTITLE" --title "$1" ${3:+--defaultno} --yesno "$2" "${4:-12}" $W; }

fail() {
    log "FAILED: $1"
    whiptail --backtitle "$BACKTITLE" --title "Something went wrong" --scrolltext --msgbox \
        "$1\n\nThe last lines of the log ($LOG):\n\n$(tail -n 25 "$LOG" | sed 's/\x1b\[[0-9;]*m//g')" 24 $W
    clear; exit 1
}

step() {
    local title="$1" text="$2"; shift 2
    log "--- $title: $*"
    "$@" >>"$LOG" 2>&1 &
    local pid=$! pct=0
    {
        while kill -0 "$pid" 2>/dev/null; do
            echo "$pct"; sleep 1
            [ "$pct" -lt 94 ] && pct=$(( pct + (97 - pct) / 15 + 1 ))
        done
        echo 100; sleep 0.3
    } | whiptail --backtitle "$BACKTITLE" --title "$title" --gauge "\n$text" 9 $W 0
    wait "$pid"
}

# Only installs the installer made count (a developer's checkout of the source has no FORGE_INSTALLER)
is_install() { [ -f "$1/.env" ] && grep -q '^FORGE_INSTALLER=' "$1/.env" 2>/dev/null; }

# The install: this script's own folder, the default folder, or wherever ForgeOffice's containers were started from
find_install() {
    local dir
    for dir in "$SELF_DIR" /opt/forgeoffice; do
        is_install "$dir" && { INSTALL_DIR=$dir; return 0; }
    done
    for dir in $(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u); do
        is_install "$dir" && { INSTALL_DIR=$dir; return 0; }
    done
    return 1
}

env_get() { sed -n "s/^$1=//p" "$INSTALL_DIR/.env" 2>/dev/null | tail -n 1 | sed "s/^[\"']\(.*\)[\"']$/\1/"; }
compose() { (cd "$INSTALL_DIR" && docker compose "$@"); }
project_volumes() { docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null; }
forge_images() { docker images forgeoffice/app --format '{{.Repository}}:{{.Tag}}' 2>/dev/null; }
has_profile() { [[ ",$(env_get COMPOSE_PROFILES)," == *",$1,"* ]]; }

remove_images() {
    local images; images=$(forge_images)
    [ -z "$images" ] && return 0
    # shellcheck disable=SC2086
    docker rmi $images
}

remove_everything() {
    compose down --volumes --remove-orphans || return 1
    local vols; vols=$(project_volumes)
    # shellcheck disable=SC2086
    [ -z "$vols" ] || docker volume rm $vols || return 1
    remove_images
}

main() {
    if ! find_install; then
        msg "Nothing to remove" "ForgeOffice couldn't be found on this server (looked in ${SELF_DIR}, /opt/forgeoffice and Docker's containers)." 9
        clear; exit 0
    fi
    local mode note version
    mode=$(env_get FORGE_INSTALL_MODE)
    version=$(env_get FORGE_VERSION)
    case "$mode" in
        express) note="All of ForgeOffice runs on this server." ;;
        new)     note="This is the first server of a ForgeOffice that may span several: it holds the database every server uses." ;;
        *)       note="This server is one of several running ForgeOffice: only its own parts ($(env_get COMPOSE_PROFILES | tr ',' ' ')) are removed." ;;
    esac

    local choice
    choice=$(whiptail --backtitle "$BACKTITLE" --title "Uninstall ForgeOffice" --default-item keep --menu \
        "ForgeOffice ${version:+${version} }is installed in ${INSTALL_DIR}.\n${note}\n\nWhat would you like to do?" 18 $W 3 \
        keep     "Remove ForgeOffice, keep its data (it can be installed again)" \
        all      "Remove ForgeOffice and delete ALL of its data" \
        cancel   "Cancel - change nothing" 3>&1 1>&2 2>&3)
    [ "$choice" = keep ] || [ "$choice" = all ] || { clear; say "Nothing was changed."; exit 0; }

    if [ "$choice" = keep ]; then
        local extra=""
        [ "$mode" = new ] && extra="\n\nThe other servers stop working while the database here is stopped."
        ask "Remove ForgeOffice" "ForgeOffice will be stopped and its containers and image removed.\n\nKept: its data (mail, files, the database, in Docker volumes) and its settings in ${INSTALL_DIR}. Running install.sh again brings it back as it was.${extra}\n\nCarry on?" "" 16 || { clear; say "Nothing was changed."; exit 0; }
        step "Stopping ForgeOffice" "Stopping and removing ForgeOffice's containers..." compose down --remove-orphans || fail "ForgeOffice's containers could not be removed."
        step "Removing the image" "Removing the ForgeOffice image..." remove_images || log "Some ForgeOffice images were left (still in use?)"
        log "Removed ForgeOffice from ${INSTALL_DIR}, data kept"
        msg "ForgeOffice removed" "ForgeOffice has been stopped and removed.\n\nIts data and settings are kept. To bring it back, run install.sh from a ForgeOffice release (or ${INSTALL_DIR}/install.sh with the release's image file next to it).\n\nDocker itself is still installed." 14
        clear; say "ForgeOffice was removed; its data is kept."
        exit 0
    fi

    local lost="   * every mailbox, file, site, chat and setting kept on this server\n   * the backups in the forge_backups volume\n   * ForgeOffice's settings in ${INSTALL_DIR}"
    if [ "$mode" = new ]; then
        lost="   * THE DATABASE EVERY FORGEOFFICE SERVER USES: users, mail, calendars, files' records\n${lost}"
    elif [ "$mode" = join ] && has_profile store; then
        lost="${lost}\n\nThis server is a storage node: retire it first in the admin center (Organisation > Servers & storage), so its files are copied to the other nodes."
    fi
    ask "Delete everything?" "This PERMANENTLY deletes:\n\n${lost}\n\nIt cannot be undone. Make a backup first (on the admin center's Overview page) and copy it off this server if you might need anything.\n\nCarry on?" yes 22 || { clear; say "Nothing was changed."; exit 0; }
    local typed
    typed=$(whiptail --backtitle "$BACKTITLE" --title "Delete everything?" --inputbox "To confirm, type DELETE in capitals:" 10 $W 3>&1 1>&2 2>&3)
    [ "$typed" = DELETE ] || { msg "Cancelled" "That wasn't DELETE, so nothing has been changed." 8; clear; exit 0; }

    step "Removing ForgeOffice" "Removing ForgeOffice's containers, data and image..." remove_everything || fail "ForgeOffice could not be removed completely."
    log "Removed ForgeOffice and all of its data from ${INSTALL_DIR}"
    # Last, as this script may be running from inside that folder. Never a system folder, whatever was detected.
    local real; real=$(cd "$INSTALL_DIR" && pwd -P)
    case "$real" in
        /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/mnt|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var) real="" ;;
    esac
    # Nor someone's whole home folder
    [ "$(dirname "$real")" = /home ] && real=""
    [ -n "$real" ] || fail "Everything else was removed, but ${INSTALL_DIR} looks like a system or home folder, so it was left for you to tidy up by hand."
    rm -rf -- "$INSTALL_DIR" || fail "Everything else was removed, but the folder ${INSTALL_DIR} could not be deleted."
    msg "ForgeOffice removed" "ForgeOffice and all of its data have been removed from this server.\n\nDocker itself is still installed." 10
    clear; say "ForgeOffice and its data were removed."
}

main "$@"
