import paramiko, sys

HOST = "SERVER_IP"
PORT = 22
USER = "root"
PASS = "SERVER_SSH_PASSWORD"

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, port=PORT, username=USER, password=PASS, timeout=20)

def run(cmd):
    i,o,e = c.exec_command(cmd)
    out = o.read().decode(errors="replace")
    err = e.read().decode(errors="replace")
    return out, err

cmds = [
    "node -v; npm -v; which node; which npx",
    "ls -la /opt/quantfolio 2>/dev/null | head -30",
    "ls -la /opt/quantfolio/client/dist 2>/dev/null | head -5; echo '--- dist check ---'; ls /opt/quantfolio/client/dist/index.html 2>/dev/null && echo 'DIST_EXISTS' || echo 'NO_DIST'",
    "cat /opt/quantfolio/start_server.sh 2>/dev/null",
    "pgrep -af 'node' | head -10",
    "df -h /opt 2>/dev/null | tail -3; echo '---'; free -m | head -3",
    "ls /opt/quantfolio/client/node_modules/.bin/vite 2>/dev/null && echo 'VITE_OK' || echo 'NO_VITE'",
    "ls /opt/quantfolio/server/node_modules/better-sqlite3 2>/dev/null >/dev/null && echo 'BETTER_SQLITE_OK' || echo 'NO_BETTER_SQLITE'; ls /opt/quantfolio/server/node_modules/sqlite 2>/dev/null >/dev/null && echo 'NODE_SQLITE_OK' || echo 'NO_NODE_SQLITE'",
]

for cmd in cmds:
    print("="*60)
    print("$", cmd)
    out, err = run(cmd)
    print(out)
    if err.strip():
        print("ERR:", err)

c.close()
