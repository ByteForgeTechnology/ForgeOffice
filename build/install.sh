#!/usr/bin/env bash
# ForgeOffice installer for Linux servers: installs Docker if needed, asks how ForgeOffice should be set up,
# and starts it ready for the setup wizard. Run from the unzipped release folder:  sudo ./install.sh
#
#   Express: all of ForgeOffice on this server.
#   Custom:  the parts you choose: a new ForgeOffice, or this server joining one that runs on others.
#
# Run a newer release's install.sh on an installed server to upgrade it (data is kept).

VERSION="@VERSION@"
# build.sh fills in the release; a copy straight from the source tree still has the placeholder
case "$VERSION" in @*) VERSION="development" ;; esac
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG=/var/log/forgeoffice-install.log
BACKTITLE="ForgeOffice ${VERSION} - Installer"
W=76
IMAGE="forgeoffice/app:${VERSION}"
PROJECT=forgeoffice

INSTALL_DIR=/opt/forgeoffice
MODE=express                    # express: everything here | custom: chosen parts
DEPLOYMENT=new                  # custom only: new | join
ROLES="data gateway web directory apps mail store media worker"
WEB_MODE=http HTTP_PORT=8080 DOMAIN="" PUBLIC_URL=""
MAIL_HOST=""
EXTRAS=""                       # express only: av office
OFFICE_DOMAIN=""
BIND_IP="" RTC_IP="" RTC_PORT=40000
SMTP_PORT=25 SUBMISSION_PORT=587 SUBMISSIONS_PORT=465 IMAP_PORT=143 IMAPS_PORT=993
STORE_NODES="" REPLICAS=2
# Joining: what the first server's join code holds
J_PUBLIC_URL="" J_MAIL_HOST="" J_DB_PASS="" J_SECRET="" J_DB_HOST="" J_STORE_NODES="" J_REPLICAS="" J_IMAGE=""
# The gateway: other servers running a part (as well as, or instead of, this one)
declare -A ELSEWHERE=([web]="" [directory]="" [apps]="")
PKG_FILES=(compose.yml compose.multi.yml env.example INSTALL.txt install.sh uninstall.sh)
ALL_ROLES=(data gateway web directory apps mail store media worker)
# Gateway routes: part, FORGE_UPSTREAM_<name>, container, port
UPSTREAMS=(
    "web PORTAL_WEB portal-web 8081" "web MAIL_WEB mail-web 8082" "web CALENDAR_WEB calendar-web 8083"
    "web CONTACTS_WEB contacts-web 8084" "web TASKS_WEB tasks-web 8085" "web ADMIN_WEB admin-web 8086"
    "web DRIVE_WEB drive-web 8087" "web SITES_WEB sites-web 8088" "web TEAM_WEB team-web 8089"
    "directory DIRECTORY directory 8091"
    "apps MAIL_API mail-api 8092" "apps CALENDAR_API calendar-api 8093" "apps CONTACTS_API contacts-api 8094"
    "apps TASKS_API tasks-api 8095" "apps DRIVE_API drive-api 8097" "apps TEAM_API team-api 8098"
)

# ------------------------------------------------------------------------------------------------- basics
say() { printf '%s\n' "$*" >&2; }
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then exec sudo bash "$0" "$@"; fi
    say "Please run this installer as root."; exit 1
fi
if [ "$(uname -s)" != "Linux" ]; then say "This installer is for Linux servers."; exit 1; fi
: >>"$LOG" && chmod 600 "$LOG"
log "ForgeOffice ${VERSION} installer started from ${PKG_DIR}"

pkg_manager() {
    for p in apt-get dnf yum zypper pacman apk; do
        command -v "$p" >/dev/null 2>&1 && { echo "$p"; return 0; }
    done
    return 1
}
pkg_install() {
    case "$(pkg_manager)" in
        apt-get) apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" ;;
        dnf)     dnf install -y -q "$@" ;;
        yum)     yum install -y -q "$@" ;;
        zypper)  zypper -n -q install "$@" ;;
        pacman)  pacman -Sy --noconfirm --needed "$@" ;;
        apk)     apk add -q "$@" ;;
        *)       return 1 ;;
    esac
}

# whiptail draws the menus (the same toolkit as most distribution installers)
if ! command -v whiptail >/dev/null 2>&1; then
    say "Getting the installer's menus ready (installing whiptail)..."
    case "$(pkg_manager)" in apt-get) pkg=whiptail ;; pacman) pkg=libnewt ;; *) pkg=newt ;; esac
    pkg_install "$pkg" >>"$LOG" 2>&1 || { say "Could not install whiptail. Install it (package '$pkg') and run this again."; exit 1; }
fi
command -v curl >/dev/null 2>&1 || pkg_install curl >>"$LOG" 2>&1
command -v gzip >/dev/null 2>&1 || pkg_install gzip >>"$LOG" 2>&1

if [ "$(tput cols 2>/dev/null || echo 80)" -lt 80 ] || [ "$(tput lines 2>/dev/null || echo 24)" -lt 24 ]; then
    say "Your terminal is quite small: make the window at least 80x24 for the best view."; sleep 2
fi

# ------------------------------------------------------------------------------------------------- dialogs
# Each returns whiptail's exit status: 0 = OK/Yes, 1 = Cancel/No, 255 = Esc
msg()   { whiptail --backtitle "$BACKTITLE" --title "$1" --msgbox "$2" "${3:-14}" $W; }
ask()   { whiptail --backtitle "$BACKTITLE" --title "$1" ${3:+--defaultno} --yesno "$2" "${4:-12}" $W; }
input() { whiptail --backtitle "$BACKTITLE" --title "$1" --inputbox "$2" "${4:-12}" $W "$3" 3>&1 1>&2 2>&3; }

# Shows the end of the log, then stops
fail() {
    log "FAILED: $1"
    whiptail --backtitle "$BACKTITLE" --title "Something went wrong" --scrolltext --msgbox \
        "$1\n\nThe last lines of the log ($LOG):\n\n$(tail -n 25 "$LOG" | sed 's/\x1b\[[0-9;]*m//g')" 24 $W
    clear; exit 1
}

# Runs a command in the background with a progress bar; its output goes to the log
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

server_ip() {
    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -n "$ip" ] || ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
    echo "${ip:-$(hostname)}"
}

port_in_use() {
    if command -v ss >/dev/null 2>&1; then
        ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
    else
        (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
    fi
}

random_text() { head -c 64 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-"${1:-32}"; }
random_hex()  { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
is_hostname() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$ ]]; }
is_domain()   { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; }
is_port()     { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
# A name next to the domain: mail.example.com for office.example.com (or for example.com)
beside_domain() { local d=$DOMAIN; [[ "$d" == *.*.* ]] && d=${d#*.}; echo "$1.$d"; }

# ------------------------------------------------------------------------------------------------- Docker
docker_ready() { command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; }

start_docker() {
    if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker
    elif command -v rc-service >/dev/null 2>&1; then rc-update add docker default; rc-service docker start
    else service docker start; fi
}

install_docker() {
    . /etc/os-release
    case "$ID" in
        ubuntu|debian|raspbian|fedora|centos|rhel)
            curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sh /tmp/get-docker.sh ;;
        rocky|almalinux|ol)
            dnf -y install dnf-plugins-core &&
            dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo &&
            dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin ;;
        arch|manjaro|endeavouros) pacman -Sy --noconfirm --needed docker docker-compose ;;
        opensuse*|sles) zypper -n install docker docker-compose ;;
        alpine) apk add docker docker-cli-compose ;;
        *) echo "No automatic Docker install for '$ID'"; return 2 ;;
    esac || return 1
    start_docker
}

ensure_docker() {
    if command -v docker >/dev/null 2>&1; then
        docker info >/dev/null 2>&1 || step "Starting Docker" "Docker is installed but not running. Starting it..." start_docker
        docker info >/dev/null 2>&1 || fail "Docker is installed but would not start."
        if ! docker compose version >/dev/null 2>&1; then
            step "Installing Docker Compose" "Adding the Docker Compose plugin..." pkg_install docker-compose-plugin
            docker compose version >/dev/null 2>&1 || fail "Docker Compose (v2) is missing and could not be added. Install the docker-compose-plugin package, then run this installer again."
        fi
        log "Docker: $(docker --version)"
        return 0
    fi
    ask "Docker" "ForgeOffice runs in Docker, which isn't installed on this server yet.\n\nInstall Docker now? It comes from Docker's own repositories and takes a few minutes." || { clear; say "Docker is needed. Nothing was changed."; exit 1; }
    step "Installing Docker" "Installing Docker. This can take a few minutes..." install_docker
    local rc=$?
    [ $rc -eq 2 ] && fail "This Linux distribution ($(. /etc/os-release; echo "$PRETTY_NAME")) can't have Docker installed automatically. Install Docker with its Compose plugin (docs.docker.com/engine/install), then run this installer again."
    if ! docker_ready || ! docker info >/dev/null 2>&1; then fail "Docker could not be installed."; fi
    msg "Docker" "Docker is installed and running.\n\n$(docker --version)" 10
}

# ------------------------------------------------------------------------------------------------- the parts
has_role() { [[ " $ROLES " == *" $1 "* ]]; }
is_new()   { [ "$MODE" = express ] || [ "$DEPLOYMENT" = new ]; }
add_role() { has_role "$1" || ROLES="$ROLES $1"; }
del_role() { ROLES=$(echo " $ROLES " | sed "s/ $1 / /g; s/^ *//; s/ *$//"); }

role_label() {
    case "$1" in
        data)      echo "Database and Redis (one server only)" ;;
        gateway)   echo "Gateway: the address people open" ;;
        web)       echo "Web apps: mail, calendar, files, chat..." ;;
        directory) echo "Directory: sign-in, users, admin center" ;;
        apps)      echo "App back ends: mail, calendar, drive, team..." ;;
        mail)      echo "Mail server: SMTP and IMAP" ;;
        store)     echo "Storage node: mail, files and recordings" ;;
        media)     echo "Meeting server: audio and video" ;;
        worker)    echo "Background jobs: delivery, scans, backups" ;;
    esac
}
role_short() {
    case "$1" in
        data) echo Database ;; gateway) echo Gateway ;; web) echo "Web apps" ;; directory) echo Directory ;;
        apps) echo "App back ends" ;; mail) echo "Mail server" ;; store) echo Storage ;; media) echo Meetings ;; worker) echo "Background jobs" ;;
    esac
}
# The ports each part publishes on this server's private address
role_ports() {
    case "$1" in
        data) echo 5432 6379 ;; web) echo 8081 8082 8083 8084 8085 8086 8087 8088 8089 ;; directory) echo 8091 ;;
        apps) echo 8092 8093 8094 8095 8097 8098 ;; store) echo 8096 ;;
    esac
}

# ------------------------------------------------------------------------------------------------- labels
mode_label() {
    if [ "$MODE" = express ]; then echo "Express: all of ForgeOffice on this server"
    else echo "Custom: chosen parts"; fi
}
deployment_label() {
    if [ "$DEPLOYMENT" = new ]; then echo "A new ForgeOffice (its first server)"
    else echo "Join ${J_PUBLIC_URL:-(enter the join code)}"; fi
}
roles_label() {
    local r out=""
    for r in "${ALL_ROLES[@]}"; do has_role "$r" && out="${out:+$out, }$(role_short "$r")"; done
    echo "${out:-(none)}"
}
proxy_label() {
    if [ "$WEB_MODE" = https ]; then echo "Yes: https://${DOMAIN:-(choose a domain)}"; else echo "No"; fi
}
port_label() {
    if [ "$WEB_MODE" = https ]; then echo "${HTTP_PORT} (behind the HTTPS proxy)"; else echo "${HTTP_PORT}"; fi
}
web_label() {
    if [ "$DEPLOYMENT" = join ] && [ "$MODE" = custom ]; then echo "$J_PUBLIC_URL"
    elif ! has_role gateway; then echo "${PUBLIC_URL:-(choose)}"
    elif [ "$WEB_MODE" = https ]; then echo "https://${DOMAIN:-(choose a domain)}"
    else echo "http://${BIND_IP}:${HTTP_PORT}"; fi
}
mail_ports_label() { echo "SMTP ${SMTP_PORT}, ${SUBMISSION_PORT}, ${SUBMISSIONS_PORT}  IMAP ${IMAP_PORT}, ${IMAPS_PORT}"; }
meetings_label() {
    if [ "$MODE" = express ]; then echo "${RTC_IP} (ports 40000-40099)"; else echo "${RTC_IP} (port ${RTC_PORT})"; fi
}
extras_label() {
    local out=""
    [[ " $EXTRAS " == *" av "* ]] && out="Virus scanning"
    [[ " $EXTRAS " == *" office "* ]] && out="${out:+$out, }Office editing"
    echo "${out:-None}"
}
elsewhere_label() {
    local g n=0
    for g in web directory apps; do [ -n "${ELSEWHERE[$g]}" ] && n=$((n + 1)); done
    if [ $n -eq 0 ]; then echo "Everything is on this server"; else echo "$n part(s) on other servers"; fi
}
public_url() {
    if [ "$MODE" = custom ] && [ "$DEPLOYMENT" = join ]; then echo "$J_PUBLIC_URL"
    else web_label; fi
}

# ------------------------------------------------------------------------------------------------- questions
choose_mode() {
    local c
    c=$(whiptail --backtitle "$BACKTITLE" --title "Install type" --default-item "$MODE" --menu \
        "How should ForgeOffice be installed?\n\nExpress puts all of it on this server, which suits most organisations. Custom lets you choose the parts this server runs, to spread ForgeOffice over several servers or run more copies of a part." 18 $W 2 \
        express "Express: all of ForgeOffice on this server (recommended)" \
        custom  "Custom: choose the parts, for several servers" 3>&1 1>&2 2>&3) || return
    MODE=$c
    if [ "$MODE" = express ]; then
        ROLES="${ALL_ROLES[*]}"
    else
        choose_deployment
        choose_roles
    fi
}

choose_folder() {
    local d
    d=$(input "Install folder" "Where should ForgeOffice's settings and compose files live?\n(The data itself is kept in Docker volumes.)" "$INSTALL_DIR") || return
    case "$d" in /*) INSTALL_DIR="${d%/}" ;; *) msg "Install folder" "Please give a full path, starting with /." 8 ;; esac
}

choose_deployment() {
    local c
    c=$(whiptail --backtitle "$BACKTITLE" --title "Deployment" --default-item "$DEPLOYMENT" --menu \
        "Is this the first server of a new ForgeOffice, or is it joining one that already runs on other servers?" 14 $W 2 \
        new  "A new ForgeOffice: this is its first server" \
        join "Join a ForgeOffice running on other servers" 3>&1 1>&2 2>&3) || return
    if [ "$c" = join ]; then
        enter_join_code || return
        DEPLOYMENT=join
        del_role data
    else
        DEPLOYMENT=new
        add_role data
    fi
}

# The first server's join code: the shared settings (database, secret, storage) every server needs
enter_join_code() {
    local v text k val
    while :; do
        v=$(input "Join code" "Paste the join code shown when the first server was installed (it is also in join-code.txt in that server's install folder), or type the path of a copy of join-code.txt:" "" 13) || return 1
        [ -f "$v" ] && v=$(cat "$v")
        v=$(printf '%s' "$v" | tr -d ' \t\r\n' | grep -o 'FORGEJOIN1:[A-Za-z0-9+/=]*' | head -n 1)
        text=$(printf '%s' "${v#FORGEJOIN1:}" | base64 -d 2>/dev/null | gzip -dc 2>/dev/null)
        if [ -n "$v" ] && [ -n "$text" ]; then break; fi
        msg "Join code" "That isn't a ForgeOffice join code. It starts with FORGEJOIN1: and is one long line." 8
    done
    while IFS='=' read -r k val; do
        # Only plain values: nothing in a join code is ever run
        [[ "$val" =~ ^[A-Za-z0-9._:/,@\ -]*$ ]] || continue
        case "$k" in
            FORGE_PUBLIC_URL) J_PUBLIC_URL=$val ;;
            FORGE_MAIL_HOSTNAME) J_MAIL_HOST=$val ;;
            POSTGRES_PASSWORD) J_DB_PASS=$val ;;
            FORGE_SECRET) J_SECRET=$val ;;
            FORGE_DB_HOST) J_DB_HOST=$val ;;
            FORGE_STORE_NODES) J_STORE_NODES=$val ;;
            FORGE_STORE_REPLICAS) J_REPLICAS=$val ;;
            FORGE_IMAGE) J_IMAGE=$val ;;
        esac
    done <<<"$text"
    if [ -z "$J_PUBLIC_URL" ] || [ -z "$J_DB_PASS" ] || [ -z "$J_SECRET" ] || [ -z "$J_DB_HOST" ]; then
        msg "Join code" "That join code is incomplete. Copy it again from the first server." 8
        return 1
    fi
    if [ -n "$J_IMAGE" ] && [ "$J_IMAGE" != "$IMAGE" ]; then
        ask "Different release" "The other servers run ${J_IMAGE#*:}, and this is ${VERSION}.\n\nEvery server should run the same release: upgrade them first (run the newer install.sh on each), or use the matching release here.\n\nCarry on anyway?" yes 13 || return 1
    fi
    if ! timeout 4 bash -c "exec 3<>/dev/tcp/${J_DB_HOST}/5432" 2>/dev/null; then
        ask "Database not reachable" "This server can't reach the database at ${J_DB_HOST}:5432.\n\nCheck the firewall on that server lets this one in (ports 5432 and 6379).\n\nCarry on anyway?" yes 12 || return 1
    fi
    log "Join code read: ${J_PUBLIC_URL}, database at ${J_DB_HOST}"
    return 0
}

choose_roles() {
    local args=() r v
    for r in "${ALL_ROLES[@]}"; do
        [ "$DEPLOYMENT" = join ] && [ "$r" = data ] && continue
        args+=("$r" "$(role_label "$r")" "$(has_role "$r" && echo ON || echo OFF)")
    done
    while :; do
        v=$(whiptail --backtitle "$BACKTITLE" --title "Components" --separate-output --checklist \
            "Which parts of ForgeOffice should this server run? (Space ticks, Enter confirms.)\n\nAny part except the database can run on several servers for more capacity." 21 $W 9 "${args[@]}" 3>&1 1>&2 2>&3) || return
        v=$(echo $v)
        [ -n "$v" ] && break
        msg "Components" "Choose at least one part." 7
    done
    ROLES=$v
    if [ "$DEPLOYMENT" = new ] && ! has_role data; then
        add_role data
        msg "Components" "A new ForgeOffice keeps its database on its first server, so the database is included. Other servers join it later." 9
    fi
    if [ "$DEPLOYMENT" = new ] && ! has_role directory; then
        msg "Components" "Nothing works until the Directory runs (it sets up the database and signs people in). Install it on another server straight after this one." 9
    fi
    if has_role store && [ "$DEPLOYMENT" = new ]; then STORE_NODES=""; fi
}

choose_bind() {
    local v
    while :; do
        v=$(input "Server address" "This server's private address: the other ForgeOffice servers reach it here, and its parts' ports are published on it. Keep those ports behind your firewall." "$BIND_IP") || return
        is_hostname "$v" && { BIND_IP=$v; return; }
        msg "Server address" "That doesn't look like an IP address or server name." 8
    done
}

# Should the HTTPS proxy be installed? Yes = ForgeOffice on the user's own domain with a certificate.
choose_proxy() {
    if ! ask "HTTPS proxy (recommended)" "Put ForgeOffice on your own domain name with HTTPS?\n\nA certificate is fetched for it and renewed by itself. Meetings (camera and microphone) only work over HTTPS, except on this server itself.\n\n  Yes: the domain already points at this server, and ports 80 and 443 are open to the internet.\n  No:  people open ForgeOffice on a port instead (http://${BIND_IP}:${HTTP_PORT}), or you'll put your own proxy in front of it." "$([ "$WEB_MODE" = https ] || echo yes)" 19; then
        WEB_MODE=http
        return
    fi
    local busy="" p v
    for p in 80 443; do port_in_use "$p" && busy="$busy $p"; done
    if [ -n "$busy" ]; then
        msg "HTTPS proxy" "The proxy needs ports 80 and 443, but port(s)${busy} are already in use on this server (another web server?).\n\nForgeOffice will use a port instead. Free those ports and choose HTTPS proxy again to use it." 11
        WEB_MODE=http
        return
    fi
    local suggested=$DOMAIN
    [ -z "$suggested" ] && [ "$DEPLOYMENT" = join ] && [[ "$J_PUBLIC_URL" == https://* ]] && suggested=$(echo "${J_PUBLIC_URL#https://}" | cut -d/ -f1 | cut -d: -f1)
    while :; do
        v=$(input "HTTPS proxy" "Domain name for ForgeOffice (e.g. office.example.com):\n\nIt must already point at this server so a certificate can be issued." "$suggested") || return
        if is_domain "$v"; then DOMAIN=$v; WEB_MODE=https; return; fi
        msg "HTTPS proxy" "That doesn't look like a domain name." 8
    done
}

# The gateway's port: what people use without the proxy, and only the proxy's own connection to it with it
choose_port() {
    local v text
    text="Port number for ForgeOffice (people open http://${BIND_IP}:PORT):"
    [ "$WEB_MODE" = https ] && text="Port number for ForgeOffice behind the HTTPS proxy. Only the proxy uses it (it isn't reachable from other machines), so any free port will do:"
    while :; do
        v=$(input "Web port" "$text" "$HTTP_PORT") || return
        if ! is_port "$v"; then msg "Web port" "The port must be a number from 1 to 65535." 8; continue; fi
        if port_in_use "$v"; then msg "Web port" "Something on this server is already using port $v. Choose another." 8; continue; fi
        HTTP_PORT=$v; return
    done
}

# A new ForgeOffice whose gateway runs on another server: the address people will use
choose_public_url() {
    local v
    while :; do
        v=$(input "Web address" "The address people will open ForgeOffice at, on the server that runs the gateway (e.g. https://office.example.com or http://10.0.0.20:8080):" "$PUBLIC_URL") || return
        [[ "$v" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] && { PUBLIC_URL=$v; return; }
        msg "Web address" "Give the address with http:// or https:// and no path, e.g. https://office.example.com" 8
    done
}

choose_mail_host() {
    local v
    while :; do
        v=$(input "Mail server name" "The mail server's host name: what your domains' MX records point at, and what mail apps connect to (e.g. mail.example.com):" "$MAIL_HOST") || return
        is_domain "$v" && { MAIL_HOST=$v; return; }
        msg "Mail server name" "That doesn't look like a host name (it needs a dot, e.g. mail.example.com)." 8
    done
}

choose_mail_ports() {
    local v a b c d e
    while :; do
        v=$(input "Mail ports" "Ports for SMTP (receiving mail), submission, submission over TLS, IMAP and IMAP over TLS, separated by spaces.\n\nOther mail servers only deliver to port 25: change it only for testing, or when something else on this server receives mail." "$SMTP_PORT $SUBMISSION_PORT $SUBMISSIONS_PORT $IMAP_PORT $IMAPS_PORT" 14) || return
        read -r a b c d e _ <<<"$v"
        if is_port "$a" && is_port "$b" && is_port "$c" && is_port "$d" && is_port "$e"; then
            SMTP_PORT=$a SUBMISSION_PORT=$b SUBMISSIONS_PORT=$c IMAP_PORT=$d IMAPS_PORT=$e
            return
        fi
        msg "Mail ports" "Enter five port numbers (1 to 65535), e.g. 25 587 465 143 993" 8
    done
}

choose_meetings() {
    local v
    while :; do
        v=$(input "Meetings" "The address people's browsers send meeting audio and video to: this server's address as their computers see it. Use its public IP if people join from the internet." "$RTC_IP") || return
        is_hostname "$v" && { RTC_IP=$v; break; }
        msg "Meetings" "That doesn't look like an IP address." 8
    done
    if [ "$MODE" = express ]; then
        msg "Meetings" "Meetings use UDP and TCP ports 40000 to 40099 on this server: open them in the firewall (and forward them, if this server is behind a router)." 9
        return
    fi
    while :; do
        v=$(input "Meetings" "The one port (UDP and TCP) every meeting on this server uses. Open it in the firewall:" "$RTC_PORT") || return
        is_port "$v" && { RTC_PORT=$v; return; }
        msg "Meetings" "The port must be a number from 1 to 65535." 8
    done
}

choose_extras() {
    local mem v
    mem=$(awk '/MemTotal/ { printf "%.1f", $2 / 1048576 }' /proc/meminfo 2>/dev/null)
    v=$(whiptail --backtitle "$BACKTITLE" --title "Extras" --separate-output --checklist \
        "Optional extras. This server has ${mem:-?} GB of memory: ForgeOffice itself uses about 2 GB.\n\n(Space ticks, Enter confirms.)" 15 $W 2 \
        av     "Virus scanning of uploads (ClamAV, about 1.5 GB)" "$([[ " $EXTRAS " == *" av "* ]] && echo ON || echo OFF)" \
        office "Edit Word, Excel and PowerPoint files (2-4 GB)" "$([[ " $EXTRAS " == *" office "* ]] && echo ON || echo OFF)" 3>&1 1>&2 2>&3) || return
    EXTRAS=$(echo $v)
    if [[ " $EXTRAS " == *" office "* ]] && [ "$WEB_MODE" = https ]; then choose_office_domain; fi
}

# Over HTTPS the Office editor needs its own HTTPS address
choose_office_domain() {
    local v
    [ -n "$OFFICE_DOMAIN" ] || OFFICE_DOMAIN=$(beside_domain docs)
    while :; do
        v=$(input "Office editing" "The editor runs on its own domain name, with its own certificate. Which name should it use? It must point at this server too (e.g. docs.example.com):" "$OFFICE_DOMAIN") || return
        if is_domain "$v" && [ "$v" != "$DOMAIN" ]; then OFFICE_DOMAIN=$v; return; fi
        msg "Office editing" "Give a domain name that is different from ForgeOffice's own (${DOMAIN})." 8
    done
}

# The gateway: other servers that run the web apps, the Directory or the app back ends
choose_elsewhere() {
    local c v g
    while :; do
        c=$(whiptail --backtitle "$BACKTITLE" --title "Other servers" --ok-button "Change" --cancel-button "Done" --menu \
            "The gateway sends people to the parts of ForgeOffice. List the other servers running each part (as well as this one, if it runs it too); several servers share the work.\n\nRun this installer again here to change these later." 19 $W 3 \
            web       "Web apps:      $(elsewhere_of web)" \
            directory "Directory:     $(elsewhere_of directory)" \
            apps      "App back ends: $(elsewhere_of apps)" 3>&1 1>&2 2>&3) || return
        g=$c
        while :; do
            v=$(input "Other servers" "Private addresses of the other servers running $(role_short "$g"), separated by spaces (empty for none):" "${ELSEWHERE[$g]}") || break
            v=$(echo $v)
            local ok=1 a
            for a in $v; do is_hostname "$a" || ok=0; done
            [ $ok -eq 1 ] && { ELSEWHERE[$g]=$v; break; }
            msg "Other servers" "Give IP addresses or server names separated by spaces." 8
        done
    done
}
elsewhere_of() {
    local here=""
    has_role "$1" && here="this server"
    if [ -n "${ELSEWHERE[$1]}" ]; then echo "${here:+$here + }${ELSEWHERE[$1]}"; else echo "${here:-not set!}"; fi
}

choose_store_nodes() {
    local v a urls ok
    while :; do
        v=$(input "Storage nodes" "Private addresses of the servers that will run a storage node, separated by spaces (more announce themselves when they join):" "$(echo "$STORE_NODES" | tr ',' '\n' | sed 's#^http://##; s#:8096$##' | tr '\n' ' ' | sed 's/ *$//')") || return
        urls="" ok=1
        for a in $v; do is_hostname "$a" || ok=0; urls="${urls:+$urls,}http://${a}:8096"; done
        [ $ok -eq 1 ] && [ -n "$urls" ] && { STORE_NODES=$urls; return; }
        msg "Storage nodes" "Give at least one IP address or server name." 8
    done
}

# ------------------------------------------------------------------------------------------------- deploy
image_tar() { ls "$PKG_DIR"/forgeoffice-*.tar.gz 2>/dev/null | head -n 1; }
machine_arch() { case "$(uname -m)" in x86_64|amd64) echo amd64 ;; aarch64|arm64) echo arm64 ;; *) uname -m ;; esac; }

copy_package() {
    mkdir -p "$INSTALL_DIR/docker" || return 1
    [ "$(cd "$INSTALL_DIR" && pwd -P)" = "$(cd "$PKG_DIR" && pwd -P)" ] && return 0
    for f in "${PKG_FILES[@]}"; do
        [ -f "$PKG_DIR/$f" ] && cp "$PKG_DIR/$f" "$INSTALL_DIR/$f"
    done
    cp -R "$PKG_DIR/docker/." "$INSTALL_DIR/docker/" || return 1
    chmod +x "$INSTALL_DIR/install.sh" "$INSTALL_DIR/uninstall.sh" 2>/dev/null
    return 0
}

profiles() {
    local p=""
    if [ "$MODE" = express ]; then
        [ "$WEB_MODE" = https ] && p="tls"
        local e; for e in $EXTRAS; do p="${p:+$p,}$e"; done
    else
        p=$(echo "$ROLES" | tr ' ' ',')
        has_role gateway && [ "$WEB_MODE" = https ] && p="$p,tls"
    fi
    echo "$p"
}

write_env() {
    local tz secret pass token
    tz=$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null)
    secret=$(random_hex) pass=$(random_text 32) token=$(random_text 24)
    {
        echo "# Written by the ForgeOffice ${VERSION} installer on $(date '+%F %T'). Kept on upgrades."
        echo "# Every setting is described in env.example."
        echo "FORGE_INSTALLER=${VERSION}"
        echo "COMPOSE_PROJECT_NAME=${PROJECT}"
        echo "FORGE_VERSION=${VERSION}"
        echo "FORGE_IMAGE=${IMAGE}"
        echo "COMPOSE_PROFILES=$(profiles)"
        [ -n "$tz" ] && echo "TZ=${tz}"
        if [ "$MODE" = express ]; then
            echo "FORGE_INSTALL_MODE=express"
            echo "COMPOSE_FILE=compose.yml"
        else
            echo "FORGE_INSTALL_MODE=${DEPLOYMENT}"
            echo "COMPOSE_FILE=compose.multi.yml"
            echo "FORGE_BIND=${BIND_IP}"
            echo "FORGE_MACHINE_NAME=$(hostname -s 2>/dev/null || hostname)"
        fi
        echo
        echo "# Shared by every server of this ForgeOffice"
        if [ "$MODE" = custom ] && [ "$DEPLOYMENT" = join ]; then
            echo "FORGE_PUBLIC_URL=${J_PUBLIC_URL}"
            echo "FORGE_MAIL_HOSTNAME=${J_MAIL_HOST}"
            echo "POSTGRES_PASSWORD=${J_DB_PASS}"
            echo "FORGE_SECRET=${J_SECRET}"
            echo "FORGE_DB_HOST=${J_DB_HOST}"
            echo "FORGE_STORE_NODES=${J_STORE_NODES}"
            echo "FORGE_STORE_REPLICAS=${J_REPLICAS:-2}"
        else
            echo "FORGE_PUBLIC_URL=$(public_url)"
            echo "FORGE_MAIL_HOSTNAME=${MAIL_HOST}"
            echo "POSTGRES_PASSWORD=${pass}"
            echo "FORGE_SECRET=${secret}"
            # The first-run wizard asks for it
            echo "FORGE_SETUP_TOKEN=${token}"
            if [ "$MODE" = custom ]; then
                echo "FORGE_DB_HOST=${BIND_IP}"
                if has_role store; then echo "FORGE_STORE_NODES=http://${BIND_IP}:8096"; else echo "FORGE_STORE_NODES=${STORE_NODES}"; fi
                echo "FORGE_STORE_REPLICAS=${REPLICAS}"
            fi
        fi
        echo
        echo "# This server"
        if [ "$MODE" = express ] || has_role gateway; then
            echo "FORGE_HTTP_PORT=${HTTP_PORT}"
            if [ "$WEB_MODE" = https ]; then
                echo "FORGE_HTTP_BIND=127.0.0.1"
                echo "FORGE_DOMAIN=${DOMAIN}"
            else
                echo "FORGE_HTTP_BIND=0.0.0.0"
            fi
        fi
        # Read by the media server (and required by compose.multi.yml on every server)
        echo "FORGE_RTC_ANNOUNCED_IP=${RTC_IP:-$BIND_IP}"
        [ "$MODE" = custom ] && echo "FORGE_RTC_PORT=${RTC_PORT}"
        if [ "$MODE" = express ] || has_role mail; then
            echo "FORGE_SMTP_HOST_PORT=${SMTP_PORT}"
            echo "FORGE_SUBMISSION_HOST_PORT=${SUBMISSION_PORT}"
            echo "FORGE_SUBMISSIONS_HOST_PORT=${SUBMISSIONS_PORT}"
            echo "FORGE_IMAP_HOST_PORT=${IMAP_PORT}"
            echo "FORGE_IMAPS_HOST_PORT=${IMAPS_PORT}"
        fi
        if [ "$MODE" = express ]; then
            [[ " $EXTRAS " == *" av "* ]] && echo "FORGE_CLAMAV=clamav:3310"
            if [[ " $EXTRAS " == *" office "* ]]; then
                echo "FORGE_OFFICE_JWT_SECRET=$(random_hex)"
                if [ "$WEB_MODE" = https ]; then
                    echo "FORGE_OFFICE_URL=https://${OFFICE_DOMAIN}"
                else
                    echo "FORGE_OFFICE_URL=http://${BIND_IP}:9980"
                    echo "FORGE_OFFICE_BIND=0.0.0.0"
                fi
            fi
        fi
        if [ "$MODE" = custom ] && has_role gateway; then
            upstream_lines
        fi
    } >"$INSTALL_DIR/.env.new" && chmod 600 "$INSTALL_DIR/.env.new" && mv "$INSTALL_DIR/.env.new" "$INSTALL_DIR/.env" || return 1
    write_sites
}

# The gateway: FORGE_UPSTREAM_<part> for each part that (also) runs on other servers
upstream_lines() {
    local spec g var name port list a
    echo
    echo "# The gateway: where parts run on other servers (this server's own copy comes first)"
    for spec in "${UPSTREAMS[@]}"; do
        read -r g var name port <<<"$spec"
        [ -n "${ELSEWHERE[$g]}" ] || continue
        list=""
        has_role "$g" && list="${name}:${port}"
        for a in ${ELSEWHERE[$g]}; do list="${list:+$list }${a}:${port}"; done
        echo "FORGE_UPSTREAM_${var}=\"${list}\""
    done
}

# The HTTPS proxy's extra sites: the Office editor's own domain
write_sites() {
    mkdir -p "$INSTALL_DIR/docker/sites" || return 1
    if [ "$MODE" = express ] && [ "$WEB_MODE" = https ] && [[ " $EXTRAS " == *" office "* ]]; then
        printf '# Written by the ForgeOffice installer: the Office editor on its own HTTPS address.\n%s {\n\treverse_proxy office:80\n}\n' "$OFFICE_DOMAIN" >"$INSTALL_DIR/docker/sites/office.caddy"
    else
        rm -f "$INSTALL_DIR/docker/sites/office.caddy"
    fi
}

# The shared settings another server needs to join, as one line
join_code() {
    local k
    printf 'FORGEJOIN1:%s\n' "$(
        for k in FORGE_PUBLIC_URL FORGE_MAIL_HOSTNAME POSTGRES_PASSWORD FORGE_SECRET FORGE_DB_HOST FORGE_STORE_NODES FORGE_STORE_REPLICAS FORGE_IMAGE; do
            echo "${k}=$(env_get "$k")"
        done | gzip -9c | base64 | tr -d '\n'
    )"
}
write_join_code() {
    {
        echo "# ForgeOffice join code, written by the installer on $(date '+%F %T')."
        echo "# To add a server: copy the ForgeOffice release to it, run sudo ./install.sh, choose Custom, then Join,"
        echo "# and paste the line below (or give the path of a copy of this file)."
        echo "# KEEP IT SECRET: it holds the database password and the master secret."
        join_code
    } >"$INSTALL_DIR/join-code.txt" && chmod 600 "$INSTALL_DIR/join-code.txt"
}

compose() { (cd "$INSTALL_DIR" && docker compose "$@"); }

# The images that don't come with the release (ForgeOffice's own is loaded from the release file)
pull_images() {
    local s=()
    if [ "$MODE" = express ]; then
        s=(db redis gateway)
        [ "$WEB_MODE" = https ] && s+=(caddy)
        [[ " $EXTRAS " == *" av "* ]] && s+=(clamav)
        [[ " $EXTRAS " == *" office "* ]] && s+=(office)
    else
        has_role data && s+=(db redis)
        has_role gateway && s+=(gateway)
        has_role gateway && [ "$WEB_MODE" = https ] && s+=(caddy)
    fi
    [ ${#s[@]} -eq 0 ] && return 0
    compose pull "${s[@]}"
}

# Everything started and answering? (ClamAV and the Office editor take longer and aren't waited for)
ready() {
    local svc state health n=0
    while read -r svc state health; do
        case "$svc" in clamav|office|caddy|"") continue ;; esac
        n=$((n + 1))
        [ "$state" = running ] || return 1
        case "$health" in starting|unhealthy) return 1 ;; esac
    done < <(compose ps -a --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null)
    [ $n -gt 0 ] || return 1
    if has_role gateway && has_role directory; then
        curl -fsS -o /dev/null "http://127.0.0.1:${HTTP_PORT}/api/v1/branding" 2>/dev/null || return 1
    fi
    return 0
}

# Waits up to 6 minutes for ForgeOffice to answer, with a progress bar
wait_ready() {
    {
        for i in $(seq 1 180); do
            ready && { echo 100; exit 0; }
            echo $(( i * 100 / 180 )); sleep 2
        done
    } | whiptail --backtitle "$BACKTITLE" --title "Waiting for ForgeOffice" --gauge "\nWaiting for ForgeOffice to start. The first start can take a minute or two while the database prepares itself..." 10 $W 0
    ready && return 0
    compose ps -a >>"$LOG" 2>&1; compose logs --tail 40 >>"$LOG" 2>&1
    return 1
}

old_volumes() { docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null; }

# The ports this install publishes that something else already uses
busy_ports() {
    local ports=() p r busy=""
    if [ "$MODE" = express ]; then
        ports=("$HTTP_PORT" 8081 8082 8083 8084 8085 8086 8087 8088 8089 8091 8092 8093 8094 8095 8096 8097 8098 8099 40000
               "$SMTP_PORT" "$SUBMISSION_PORT" "$SUBMISSIONS_PORT" "$IMAP_PORT" "$IMAPS_PORT")
        [ "$WEB_MODE" = https ] && ports+=(80 443)
        [[ " $EXTRAS " == *" office "* ]] && ports+=(9980)
    else
        for r in $ROLES; do ports+=($(role_ports "$r")); done
        has_role gateway && ports+=("$HTTP_PORT")
        has_role gateway && [ "$WEB_MODE" = https ] && ports+=(80 443)
        has_role media && ports+=("$RTC_PORT" 8099)
        has_role mail && ports+=("$SMTP_PORT" "$SUBMISSION_PORT" "$SUBMISSIONS_PORT" "$IMAP_PORT" "$IMAPS_PORT")
    fi
    for p in "${ports[@]}"; do port_in_use "$p" && busy="$busy $p"; done
    echo "$busy"
}

summary() {
    local out="  Install type:  $(mode_label)\n  Folder:        ${INSTALL_DIR}\n"
    if [ "$MODE" = custom ]; then
        out="${out}  Deployment:    $(deployment_label)\n  Components:    $(roles_label)\n  This server:   ${BIND_IP}\n"
    fi
    out="${out}  Web address:   $(public_url)\n"
    is_new && out="${out}  Mail server:   ${MAIL_HOST}\n"
    has_role media && out="${out}  Meetings:      $(meetings_label)\n"
    [ "$MODE" = express ] && out="${out}  Extras:        $(extras_label)\n"
    echo "$out"
}

deploy() {
    if [ "$MODE" = custom ] && [ "$DEPLOYMENT" = join ] && [ -z "$J_DB_HOST" ]; then msg "Not ready" "Enter the join code from the first server first (Deployment)." 8; return 1; fi
    if [ -z "$ROLES" ]; then msg "Not ready" "Choose the parts this server runs first (Components)." 8; return 1; fi
    if has_role gateway && [ "$WEB_MODE" = https ] && [ -z "$DOMAIN" ]; then msg "Not ready" "Choose the domain name first (HTTPS proxy)." 8; return 1; fi
    if [ "$MODE" = express ] && [ "$WEB_MODE" = https ] && [[ " $EXTRAS " == *" office "* ]] && [ -z "$OFFICE_DOMAIN" ]; then msg "Not ready" "Choose the Office editor's domain name first (Extras)." 8; return 1; fi
    if is_new && ! has_role gateway && [ -z "$PUBLIC_URL" ]; then msg "Not ready" "Enter the address people will open ForgeOffice at first (Web address)." 8; return 1; fi
    if is_new && [ -z "$MAIL_HOST" ]; then msg "Not ready" "Choose the mail server's name first (Mail server name)." 8; return 1; fi
    if [ "$MODE" = custom ] && [ "$DEPLOYMENT" = new ] && ! has_role store && [ -z "$STORE_NODES" ]; then msg "Not ready" "List the servers that will run a storage node first (Storage nodes)." 8; return 1; fi
    if [ "$MODE" = custom ] && has_role gateway; then
        local g missing=""
        for g in web directory apps; do has_role "$g" || [ -n "${ELSEWHERE[$g]}" ] || missing="${missing:+$missing, }$(role_short "$g")"; done
        if [ -n "$missing" ]; then
            ask "Other servers" "The gateway doesn't know where these parts run yet: ${missing}.\n\nPeople can't use them until it does. Choose Other servers to list them, or carry on and run this installer again here once those servers are set up.\n\nCarry on anyway?" yes 14 || return 1
        fi
    fi
    local busy; busy=$(busy_ports)
    if [ -n "$busy" ]; then
        msg "Ports in use" "Something on this server already uses port(s)${busy}, which ForgeOffice needs.\n\nStop whatever uses them, or choose other ports in the menu (Web port, Mail ports, Meetings), then select Install again." 12
        return 1
    fi

    local vols; vols=$(old_volumes)
    local -a vol_list
    mapfile -t vol_list <<<"$vols"
    if [ -n "$vols" ]; then
        local c
        c=$(whiptail --backtitle "$BACKTITLE" --title "Old ForgeOffice data found" --default-item keep --menu \
            "Docker on this server still holds data from an earlier ForgeOffice install:\n\n$(echo "$vols" | sed 's/^/   /' | head -n 8)\n\nA new install can't use it (its passwords are unknown)." 20 $W 2 \
            keep   "Stop - leave it alone (nothing is changed)" \
            delete "Delete that data permanently and start fresh" 3>&1 1>&2 2>&3)
        [ "$c" = delete ] || return 1
        ask "Delete old data?" "This permanently deletes the old ForgeOffice data (mail, files, the database) in:\n\n$(echo "$vols" | sed 's/^/   /' | head -n 8)\n\nAre you sure?" yes 18 || return 1
        step "Removing old data" "Removing the old data volumes..." docker volume rm "${vol_list[@]}" || fail "The old data volumes could not be removed (is an old ForgeOffice container still running? Stop it with 'docker compose down' in its folder)."
    fi

    ask "Ready to install" "ForgeOffice ${VERSION} will be installed with:\n\n$(summary)\nInstall now?" "" 20 || return 1

    step "Copying files" "Copying ForgeOffice's files to ${INSTALL_DIR}..." copy_package || fail "The files could not be copied to ${INSTALL_DIR}."
    write_env || fail "The settings file ${INSTALL_DIR}/.env could not be written."
    [ "$MODE" = custom ] && [ "$DEPLOYMENT" = new ] && { write_join_code || fail "The join code could not be written."; }
    step "Loading ForgeOffice" "Loading the ForgeOffice image into Docker. This takes a minute..." docker load -i "$(image_tar)" || fail "The ForgeOffice image could not be loaded."
    step "Downloading" "Downloading the database, gateway and other images..." pull_images || fail "Some images could not be downloaded. Check this server can reach the internet (Docker Hub and ghcr.io)."
    step "Starting ForgeOffice" "Starting the containers..." compose up -d --remove-orphans || fail "The containers could not be started."
    wait_ready || fail "ForgeOffice did not start in time. Check 'docker compose ps' and 'docker compose logs' in ${INSTALL_DIR}."
    log "Installed into ${INSTALL_DIR} ($(mode_label); $(roles_label))"
    finished "installed"
}

finished() {
    local url next manage
    url=$(env_get FORGE_PUBLIC_URL)
    manage="Manage it from ${INSTALL_DIR} with:\n   docker compose ps          what's running\n   docker compose logs -f     follow the logs\n   docker compose restart     restart ForgeOffice\n   sudo ./uninstall.sh        remove ForgeOffice"
    if [ "$1" = upgraded ]; then
        next="ForgeOffice is running again at:\n\n      ${url}\n\nAny database changes the new version needs were made when it started."
    elif [ "$(env_get FORGE_INSTALL_MODE)" = join ]; then
        next="This server has joined ForgeOffice at ${url}, running: $(roles_label).\n\nStorage nodes and meeting servers appear by themselves in the admin center under Organisation > Servers & storage."
        has_role gateway || [ -z "$(echo "$ROLES" | grep -wE 'web|directory|apps')" ] || next="${next}\n\nOn the gateway's server, run its install.sh again and add this server (${BIND_IP}) under Other servers."
    else
        next="Open this address in a web browser to finish setting up:\n\n      ${url}\n\nThe setup wizard asks for this setup token:  $(env_get FORGE_SETUP_TOKEN)"
        has_role gateway && [ "$WEB_MODE" = http ] && next="${next}\n\nMeetings need HTTPS for cameras and microphones (except on this server itself)."
        [ "$(env_get FORGE_INSTALL_MODE)" = new ] && next="${next}\n\nTo add servers: copy this release to each, run sudo ./install.sh, choose Custom > Join, and give it the join code in ${INSTALL_DIR}/join-code.txt, also shown in the admin center under Organisation > Servers & storage (keep it secret)."
    fi
    whiptail --backtitle "$BACKTITLE" --title "ForgeOffice is ${1}" --scrolltext --msgbox "${next}\n\n${manage}" 24 $W
    clear
    say "ForgeOffice ${VERSION} is ${1}: ${url}"
    [ "$1" = installed ] && is_new && say "Setup token: $(env_get FORGE_SETUP_TOKEN)"
}

# ------------------------------------------------------------------------------------------------- upgrade
env_get() { sed -n "s/^$1=//p" "$INSTALL_DIR/.env" 2>/dev/null | tail -n 1 | sed "s/^[\"']\(.*\)[\"']$/\1/"; }
env_set() {
    if grep -q "^$1=" "$INSTALL_DIR/.env"; then sed -i "s|^$1=.*|$1=$2|" "$INSTALL_DIR/.env"
    else echo "$1=$2" >>"$INSTALL_DIR/.env"; fi
}

# The settings an existing install was made with
load_existing() {
    local m p r g
    m=$(env_get FORGE_INSTALL_MODE)
    if [ "$m" = express ]; then MODE=express; ROLES="${ALL_ROLES[*]}"
    else
        MODE=custom; DEPLOYMENT=${m:-new}
        ROLES=""
        for r in $(env_get COMPOSE_PROFILES | tr ',' ' '); do
            case " ${ALL_ROLES[*]} " in *" $r "*) ROLES="${ROLES:+$ROLES }$r" ;; esac
        done
    fi
    p=$(env_get COMPOSE_PROFILES)
    WEB_MODE=http; [[ ",$p," == *",tls,"* ]] && WEB_MODE=https
    HTTP_PORT=$(env_get FORGE_HTTP_PORT); HTTP_PORT=${HTTP_PORT:-8080}
    BIND_IP=$(env_get FORGE_BIND); BIND_IP=${BIND_IP:-$(server_ip)}
    for g in web directory apps; do
        local spec var name port list
        for spec in "${UPSTREAMS[@]}"; do
            read -r r var name port <<<"$spec"
            [ "$r" = "$g" ] || continue
            list=$(env_get "FORGE_UPSTREAM_${var}")
            ELSEWHERE[$g]=$(echo "$list" | tr ' ' '\n' | grep -v "^${name}:" | sed 's/:[0-9]*$//' | tr '\n' ' ' | sed 's/ *$//')
            break
        done
    done
}

upgrade() {
    local current; current=$(env_get FORGE_VERSION)
    local note="Your data and settings are kept.\n\nTip: the admin center makes a backup every night; start one now from its Overview page if you like."
    [ "$MODE" = custom ] && note="${note}\n\nUpgrade every server of this ForgeOffice to the same release, starting with the one that runs the Directory (it updates the database)."
    ask "Upgrade ForgeOffice" "ForgeOffice is installed in ${INSTALL_DIR} (${current:-unknown version}).\n\nUpgrade it to ${VERSION}? ${note}" "" 17 || { clear; exit 0; }

    step "Copying files" "Updating ForgeOffice's files in ${INSTALL_DIR}..." copy_package || fail "The files could not be copied to ${INSTALL_DIR}."
    env_set FORGE_VERSION "$VERSION"
    env_set FORGE_IMAGE "$IMAGE"
    env_set FORGE_INSTALLER "$VERSION"
    step "Loading ForgeOffice" "Loading the new ForgeOffice image into Docker. This takes a minute..." docker load -i "$(image_tar)" || fail "The ForgeOffice image could not be loaded."
    step "Starting ForgeOffice" "Restarting ForgeOffice on the new version..." compose up -d --remove-orphans || fail "The containers could not be started."
    wait_ready || fail "ForgeOffice did not start after the upgrade. If a database update failed, the log below says why; your data is unchanged."
    [ "$(env_get FORGE_INSTALL_MODE)" = new ] && write_join_code
    log "Upgraded ${INSTALL_DIR} from ${current} to ${VERSION}"
    finished "upgraded"
}

# The gateway's list of other servers, changed after installing
change_elsewhere() {
    choose_elsewhere
    local tmp="$INSTALL_DIR/.env.new"
    grep -v -e '^FORGE_UPSTREAM_' -e '^# The gateway: where parts run' "$INSTALL_DIR/.env" >"$tmp" && upstream_lines >>"$tmp" && chmod 600 "$tmp" && mv "$tmp" "$INSTALL_DIR/.env" || fail "The settings file could not be updated."
    step "Restarting the gateway" "Restarting the gateway with the new list..." compose up -d --force-recreate gateway || fail "The gateway could not be restarted."
    log "Gateway's other servers changed: web='${ELSEWHERE[web]}' directory='${ELSEWHERE[directory]}' apps='${ELSEWHERE[apps]}'"
    msg "Other servers" "The gateway now sends people to:\n\n  Web apps:       $(elsewhere_of web)\n  Directory:      $(elsewhere_of directory)\n  App back ends:  $(elsewhere_of apps)" 12
}

# Where an existing install lives: the default folder, or wherever its containers were started from.
# Only installs this installer made count (a developer's checkout of the source has no FORGE_INSTALLER).
find_existing() {
    grep -q '^FORGE_INSTALLER=' "$INSTALL_DIR/.env" 2>/dev/null && return 0
    local dir
    for dir in $(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | sort -u); do
        grep -q '^FORGE_INSTALLER=' "$dir/.env" 2>/dev/null && { INSTALL_DIR=$dir; return 0; }
    done
    return 1
}

existing_menu() {
    load_existing
    local items=() c
    if [ "$(env_get FORGE_VERSION)" = "$VERSION" ]; then items+=(upgrade "Install ${VERSION} again (data and settings are kept)")
    else items+=(upgrade "Upgrade to ${VERSION} (data and settings are kept)"); fi
    [ "$(env_get FORGE_INSTALL_MODE)" = new ] && items+=(join "Show the join code, to add another server")
    [ "$MODE" = custom ] && has_role gateway && items+=(servers "Change the other servers the gateway uses")
    items+=(quit "Leave everything as it is")
    while :; do
        c=$(whiptail --backtitle "$BACKTITLE" --title "ForgeOffice is installed" --menu \
            "ForgeOffice $(env_get FORGE_VERSION) is installed in ${INSTALL_DIR} ($(roles_label)).\n\nWhat would you like to do?" 16 $W 4 "${items[@]}" 3>&1 1>&2 2>&3) || { clear; exit 0; }
        case "$c" in
            upgrade) upgrade; exit 0 ;;
            join)
                write_join_code
                whiptail --backtitle "$BACKTITLE" --title "Join code" --scrolltext --msgbox "On the new server: copy this release to it, run sudo ./install.sh, choose Custom > Join and paste this code (one line). Keep it secret: it holds the database password and the master secret.\n\n$(join_code)\n\nIt is also in ${INSTALL_DIR}/join-code.txt:\n   sudo cat ${INSTALL_DIR}/join-code.txt" 22 $W ;;
            servers) change_elsewhere ;;
            *) clear; exit 0 ;;
        esac
    done
}

# ------------------------------------------------------------------------------------------------- main
main() {
    local arch; arch=$(machine_arch)
    if [ -z "$(image_tar)" ] || [ ! -f "$PKG_DIR/compose.yml" ]; then
        msg "Files missing" "Run this installer from the unzipped ForgeOffice release folder: it needs the forgeoffice-*.tar.gz image and compose.yml next to it." 9; clear; exit 1
    fi
    case "$(image_tar)" in
        *"-${arch}.tar.gz") ;;
        *) msg "Wrong release" "This release is for $(basename "$(image_tar)" .tar.gz | sed 's/.*-//') servers, and this one is ${arch}. Use the ForgeOffice release made for ${arch}." 9; clear; exit 1 ;;
    esac

    msg "Welcome" "Welcome to ForgeOffice: mail, calendars, files, intranet sites, chat and meetings for your organisation, on your own servers.\n\nThis installer will:\n\n   * install Docker, if this server doesn't have it yet\n   * ask a few questions about how ForgeOffice should run\n   * start ForgeOffice, ready for you to finish setting it up in a web browser\n\nUse the arrow keys, Tab, Space and Enter to move around. A log is kept in ${LOG}." 20

    ensure_docker
    if find_existing; then existing_menu; exit 0; fi

    BIND_IP=$(server_ip)
    RTC_IP=$BIND_IP
    MAIL_HOST=$(hostname -f 2>/dev/null)
    is_domain "$MAIL_HOST" || MAIL_HOST=""

    # The main questions in turn, then the menu to check or change any of them
    choose_mode
    [ "$MODE" = custom ] && choose_bind && RTC_IP=$BIND_IP
    if has_role gateway; then
        choose_proxy
        [ "$WEB_MODE" = https ] && [ -z "$MAIL_HOST" ] && MAIL_HOST=$(beside_domain mail)
        [ "$WEB_MODE" = http ] && port_in_use "$HTTP_PORT" && choose_port
    elif is_new; then
        choose_public_url
    fi
    is_new && [ -z "$MAIL_HOST" ] && choose_mail_host
    [ "$MODE" = express ] && choose_extras
    [ "$MODE" = custom ] && [ "$DEPLOYMENT" = new ] && ! has_role store && choose_store_nodes
    [ "$MODE" = custom ] && has_role gateway && [ "$DEPLOYMENT" = join ] && choose_elsewhere

    local choice="Install" items
    while :; do
        items=("Install type" "$(mode_label)" "Install folder" "$INSTALL_DIR")
        if [ "$MODE" = custom ]; then
            items+=("Deployment" "$(deployment_label)" "Components" "$(roles_label)" "Server address" "$BIND_IP")
        fi
        if has_role gateway; then items+=("HTTPS proxy" "$(proxy_label)" "Web port" "$(port_label)")
        elif is_new; then items+=("Web address" "${PUBLIC_URL:-(choose)}"); fi
        is_new && items+=("Mail server name" "${MAIL_HOST:-(choose)}")
        has_role mail && items+=("Mail ports" "$(mail_ports_label)")
        has_role media && items+=("Meetings" "$(meetings_label)")
        [ "$MODE" = custom ] && has_role gateway && items+=("Other servers" "$(elsewhere_label)")
        [ "$MODE" = custom ] && [ "$DEPLOYMENT" = new ] && ! has_role store && items+=("Storage nodes" "${STORE_NODES:-(choose)}")
        [ "$MODE" = express ] && items+=("Extras" "$(extras_label)")
        items+=("" "" "Install" "Install ForgeOffice with these settings")

        choice=$(whiptail --backtitle "$BACKTITLE" --title "ForgeOffice Install Menu" --default-item "$choice" \
            --ok-button "Select" --cancel-button "Quit" --menu "\nChoose an item to change it, then select Install.\nForgeOffice will be at: $(public_url)" 23 $W 14 "${items[@]}" 3>&1 1>&2 2>&3)
        case $? in 0) ;; *) ask "Quit" "Leave the installer? Nothing has been installed yet." || continue; clear; exit 0 ;; esac
        case "$choice" in
            "Install type")
                choose_mode
                [ "$MODE" = custom ] && [ "$BIND_IP" = "$(server_ip)" ] && choose_bind ;;
            "Install folder")
                choose_folder
                if grep -q '^FORGE_INSTALLER=' "$INSTALL_DIR/.env" 2>/dev/null; then existing_menu; exit 0; fi ;;
            "Deployment")       choose_deployment ;;
            "Components")       choose_roles ;;
            "Server address")   choose_bind ;;
            "HTTPS proxy")
                choose_proxy
                [ "$MODE" = express ] && [ "$WEB_MODE" = https ] && [[ " $EXTRAS " == *" office "* ]] && [ -z "$OFFICE_DOMAIN" ] && choose_office_domain ;;
            "Web port")         choose_port ;;
            "Web address")      choose_public_url ;;
            "Mail server name") choose_mail_host ;;
            "Mail ports")       choose_mail_ports ;;
            "Meetings")         choose_meetings ;;
            "Other servers")    choose_elsewhere ;;
            "Storage nodes")    choose_store_nodes ;;
            "Extras")           choose_extras ;;
            "Install")          deploy && exit 0 ;;
        esac
    done
}

main "$@"
