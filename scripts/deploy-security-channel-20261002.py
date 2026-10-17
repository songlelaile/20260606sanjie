#!/usr/bin/env python3
"""Bounded security deployment: prepare never edits Nginx or database; publish applies only two reviewed CREATE-only migrations and swaps one default backend. No login, grant creation or provider call is performed."""
import argparse, datetime, fcntl, hashlib, json, os, re, shutil, signal, socket, stat, subprocess, sys, tempfile, time
from pathlib import Path, PurePosixPath
import urllib.error, urllib.parse, urllib.request
sys.dont_write_bytecode = True
HEX = re.compile(r'[a-f0-9]{64}')
BASE = Path('/opt/sanjie-releases/20261002-plugin-website-navigation-v4')
OLD_NAME = 'sanjie-plugin-website-navigation-20261002-v4'
OLD_PORT = 31948
NEW_NAME = 'sanjie-security-channel-20261002-v1'
NEW_PORT = 31953
CONF = Path('/etc/nginx/conf.d/sanjie.conf')
PUBLIC = 'https://shaozhuangai.com'
LOCK = Path('/var/lock/sanjie-site-deploy.lock')
SCHEMA = 'SANJIE_SECURITY_CHANNEL_DEPLOY_V1'
MANIFEST_SCHEMA = 'SANJIE_SECURITY_CHANNEL_OVERLAY_V1'
LATEST = 'private-assets/extension-updates/ai-automation/latest.json'
LATEST_ROUTE = '/api/tools/updates/ai-automation/latest'
EXPECTED_NGINX = '99d25d31140e85e7bf4e2413c53aecbd3d180990c88d662077acd18338a71f4b'
APP_PREFIXES = ('NEXT_PUBLIC_', 'SANJIE_', 'SOWER_', 'MODEL_GATEWAY_', 'DMP_', 'VIDEO_', 'TENANT_ARK_', 'OPENAI_', 'ANTHROPIC_', 'ARK_', 'DOUBAO_', 'SUB2API_', 'DEEPSEEK_', 'QWEN_', 'GEMINI_', 'KLING_', 'SEEDANCE_')
APP_KEYS = {'DATABASE_URL', 'DIRECT_URL', 'SESSION_SECRET', 'SHARE_ENCRYPTION_KEY', 'PUBLIC_APP_ORIGIN', 'LEGACY_SESSION_ACCEPT_UNTIL', 'AI_API_ENCRYPTION_KEY'}
def app_key(key):
    return key != 'SANJIE_CANONICAL_ROOT' and (key in APP_KEYS or key.startswith(APP_PREFIXES))

def need(condition, message):
    if not condition:
        raise RuntimeError(message)

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def unique(pairs):
    result = {}
    for k, v in pairs:
        need(k not in result, 'Duplicate JSON key')
        result[k] = v
    return result

def read_json(path):
    return json.loads(Path(path).read_text(), object_pairs_hook=unique)

def descriptor(path):
    path = Path(path)
    need(path.is_file(), 'File missing: ' + str(path))
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        before = os.fstat(stream.fileno())
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
        after = os.fstat(stream.fileno())
    identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    need(identity(before) == identity(after) == identity(path.stat()), 'File changed while hashing: ' + str(path))
    return {'size': after.st_size, 'sha256': digest.hexdigest()}

def valid_descriptor(value):
    return (isinstance(value, dict) and set(value) == {'size', 'sha256'} and
            type(value['size']) is int and value['size'] >= 0 and
            isinstance(value['sha256'], str) and HEX.fullmatch(value['sha256']))

def source_inventory_summary(files):
    canonical = json.dumps(files, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('utf-8')
    return {'count': len(files), 'sha256': hashlib.sha256(canonical).hexdigest()}

def safe_relative(name):
    need(isinstance(name, str) and 0 < len(name) < 512, 'Invalid relative path')
    p = PurePosixPath(name)
    need(not p.is_absolute() and str(p) == name and
         all(v not in ('', '.', '..') for v in name.split('/')) and
         not re.search(r'[\\\x00-\x1f\x7f]', name), 'Unsafe relative path')
    return p

def no_symlinks(path, root):
    path, root = Path(path), Path(root)
    need(path == root or root in path.parents, 'Path escaped its root')
    for part in (path, *path.parents):
        need(not part.is_symlink(), 'Linked path rejected: ' + str(part))
        if part == root:
            return

def atomic_bytes(path, data, expected_sha=None):
    path = Path(path)
    need(not path.is_symlink(), 'Refusing linked destination')
    existing = path.stat() if path.exists() else None
    if expected_sha is not None:
        need(descriptor(path)['sha256'] == expected_sha, 'Compare-and-swap rejected external change')
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), stat.S_IMODE(existing.st_mode) if existing else 0o600)
            if existing:
                os.fchown(stream.fileno(), existing.st_uid, existing.st_gid)
        if expected_sha is not None:
            need(descriptor(path)['sha256'] == expected_sha, 'Compare-and-swap rejected external change')
        os.replace(temporary, path)
        parent_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        Path(temporary).unlink(missing_ok=True)

def write_json(path, value):
    atomic_bytes(path, (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode())

def output(argv, timeout=30):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    need(result.returncode == 0, 'Command failed: ' + argv[0])
    return result.stdout

def process(name, root, port):
    rows = [r for r in json.loads(output(['pm2', 'jlist'])) if r.get('name') == name]
    need(len(rows) == 1, 'PM2 name missing or duplicated: ' + name)
    row = rows[0]
    env = row.get('pm2_env', {})
    need(env.get('status') == 'online' and row.get('pid', 0) > 0 and
         Path(env.get('pm_cwd', '')).resolve() == Path(root).resolve() and str(env.get('PORT')) == str(port),
         'PM2 identity mismatch: ' + name)
    return {'name': name, 'directory': str(root), 'port': port, 'pid': row['pid'], 'pm_id': row.get('pm_id'), 'restarts': env.get('restart_time'), 'status': 'online'}

def retained_processes():
    # Only identity/status fields, never PM2 environment values or command arguments.
    rows = json.loads(output(['pm2', 'jlist']))
    result = {}
    for row in rows:
        name = row.get('name')
        need(isinstance(name, str) and name not in result, 'PM2 process names are not unique')
        env = row.get('pm2_env', {})
        result[name] = {'pm_id': row.get('pm_id'), 'pid': row.get('pid'),
                        'cwd': env.get('pm_cwd'), 'port': env.get('PORT'),
                        'status': env.get('status'), 'restarts': env.get('restart_time')}
    return result

def application_environment(name):
    # Values exist in memory only. Do not return them in a receipt or log.
    rows = [r for r in json.loads(output(['pm2', 'jlist'])) if r.get('name') == name]
    need(len(rows) == 1, 'PM2 application environment identity missing')
    env = rows[0].get('pm2_env', {})
    selected = {key: value for key, value in env.items() if app_key(key)}
    need(all(isinstance(value, (str, int, float, bool)) for value in selected.values()),
         'Unsupported application environment value type')
    return {key: str(value) for key, value in selected.items()}

def environment_fingerprint(values):
    return hashlib.sha256(json.dumps(values, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def nginx_directives(data, include_ancestry=False):
    """Parse directive boundaries while retaining exact byte spans; never log values."""
    need(isinstance(data, bytes) and len(data) < 1024 * 1024, 'Nginx config size rejected')
    tokens = []
    index = 0
    while index < len(data):
        char = data[index:index + 1]
        if char.isspace():
            index += 1
            continue
        if char == b'#':
            newline = data.find(b'\n', index)
            index = len(data) if newline < 0 else newline + 1
            continue
        start = index
        if char in (b'{', b'}', b';'):
            index += 1
        else:
            quote = None
            while index < len(data):
                char = data[index:index + 1]
                if char == b'\\':
                    need(index + 1 < len(data), 'Nginx trailing escape rejected')
                    index += 2
                    continue
                if quote:
                    if char == quote:
                        quote = None
                    index += 1
                    continue
                if char in (b'"', b"'"):
                    quote = char
                    index += 1
                    continue
                if char.isspace() or char in (b'{', b'}', b';', b'#'):
                    break
                index += 1
            need(quote is None, 'Nginx unterminated quote rejected')
            need(index > start, 'Nginx empty token rejected')
        tokens.append((data[start:index], start, index))
    need(len(tokens) < 100000, 'Nginx token limit exceeded')

    def parse(position, nested=False, depth=0):
        need(depth < 64, 'Nginx nesting limit exceeded')
        rows, header = [], []
        while position < len(tokens):
            token = tokens[position]
            position += 1
            if token[0] == b'}':
                need(nested and not header, 'Nginx block boundary rejected')
                return rows, position
            if token[0] == b'{':
                need(header, 'Nginx anonymous block rejected')
                children, position = parse(position, True, depth + 1)
                rows.append((header, children))
                header = []
            elif token[0] == b';':
                need(header, 'Nginx empty directive rejected')
                rows.append((header, None))
                header = []
            else:
                header.append(token)
        need(not nested and not header, 'Nginx incomplete directive rejected')
        return rows, position

    tree, position = parse(0)
    flattened = []

    def visit(rows, parents=()):
        for header, children in rows:
            flattened.append((header, children, parents) if include_ancestry else (header, children))
            if children is not None:
                visit(children, parents + (tuple(token[0] for token in header),))

    visit(tree)
    return flattened

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None

def request(origin, route, method='GET', limit=8 * 1024 * 1024, data=None, extra_headers=None, timeout=30):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    headers = {'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity'}
    headers.update(extra_headers or {})
    req = urllib.request.Request(origin + route, method=method, data=data, headers=headers)
    try:
        response = opener.open(req, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(limit + 1)
        need(len(body) <= limit, 'HTTP response exceeds bound: ' + route)
        return response.status, body, response.headers


def wait_for_public_readiness(origin):
    """Read-only reload transition gate; all full smoke expectations stay intact."""
    started = time.monotonic()
    deadline = started + 30
    checks = (('/.env', 404, False), ('/api/auth/me', 403, True))
    streak, attempts, observed = 0, 0, []
    while time.monotonic() < deadline:
        attempts += 1
        observed = []
        complete = True
        for index, (route, expected, declared_ai) in enumerate(checks):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                complete = False
                break
            # A new opener plus Connection: close uses a fresh connection. The
            # unique query prevents a cached old status from satisfying the gate.
            nonce = str(time.time_ns()) + '-' + str(attempts) + '-' + str(index)
            headers = {'Host': 'shaozhuangai.com', 'Cache-Control': 'no-cache, no-store',
                       'Pragma': 'no-cache', 'Connection': 'close'}
            if declared_ai:
                headers['x-sanjie-ai-client'] = 'security-acceptance'
            try:
                status, _, _ = request(origin, route + '?_security_ready=' + nonce,
                                       limit=4096, extra_headers=headers, timeout=min(2, remaining))
            except Exception:
                status = None  # Do not log exception values, credentials or bodies.
            observed.append({'path': route, 'status': status, 'aiDeclared': declared_ai})
            complete = complete and status == expected
        if complete and len(observed) == len(checks) and time.monotonic() <= deadline:
            streak += 1
            if streak == 3:
                return {'consecutiveFreshSuccesses': streak, 'attempts': attempts,
                        'elapsedSeconds': round(time.monotonic() - started, 3), 'checks': observed}
        else:
            streak = 0
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(0.5, remaining))
    raise RuntimeError('Public backend readiness did not stabilize within 30 seconds')


MIGRATIONS = {
    '20261002143000_security_rate_bucket': {'SecurityRateBucket'},
    '20261002150000_ai_access_channel': {'AIAccessGrant', 'AIAccessEvent'}
}
SQL_FILES = {'prisma/migrations/' + name + '/migration.sql' for name in MIGRATIONS}
PUBLIC_DOWNLOAD_PATHS = (
    '/downloads/sycm-keyword-collector-v1.9.80.zip',
    '/downloads/shaozhuang-ai-v1.9.80-macos-full.zip',
    '/downloads/sycm-keyword-collector-v1.9.83.zip',
    '/downloads/shaozhuang-ai-v1.9.83-macos-full.zip'
)
RUNTIME_LINKS = {'uploads', 'public/uploads', 'public/media'}
IGNORE_DIRS = {'.git', '.next', 'node_modules', '.cache', 'deployment-logs', '__pycache__', '.codex-deploy'}
ALLOW_OVERLAY = {
    'next.config.mjs', '.env.example', 'prisma/schema.prisma', 'scripts/predeploy-guard.sh',
    'src/middleware.ts', 'src/middleware.test.ts', 'src/middleware-compatibility.test.ts', 'src/middleware-creative-return.test.ts', 'src/lib/auth.ts', 'src/lib/auth.test.ts',
    'src/lib/production-compatibility-policy.ts', 'src/lib/production-compatibility-policy.test.ts',
    'src/lib/auth-redirect-url.ts', 'src/lib/auth-redirect-url.test.ts',
    'src/lib/uat-environment.ts', 'src/lib/uat-environment.test.ts', 'src/lib/creative-viral-surfaces.ts',
    'src/lib/accounts.ts', 'src/lib/creative-access-policy.ts', 'src/lib/creative-entitlements.ts',
    'src/lib/creative-entitlements-production.test.ts',
    'src/lib/read-json-with-limit.ts', 'src/lib/read-json-with-limit.test.ts',
    'src/lib/server-session.ts', 'src/lib/session-server.ts',
    'src/lib/request-security.ts', 'src/lib/request-security.test.ts',
    'src/lib/security-rate-limit.ts', 'src/lib/security-rate-limit.test.ts',
    'src/lib/security-client-ip.ts', 'src/lib/security-client-ip.test.ts',
    'src/lib/security-response.ts', 'src/lib/security-web-account.ts', 'src/lib/security-web-account.test.ts',
    'src/lib/creative-asset-policy.ts', 'src/lib/creative-asset-policy.test.ts',
    'src/app/api/creative/assets/[...path]/route.ts', 'src/app/api/creative/assets/[...path]/route.test.ts',
    'src/app/api/protected-downloads/[...path]/route.ts', 'src/app/api/protected-downloads/[...path]/route.test.ts',
    'src/app/api/auth/login/route.test.ts',
    'src/app/api/auth/login/route.ts', 'src/app/api/auth/register/route.ts', 'src/app/api/auth/register/route.test.ts',
    'src/app/api/auth/me/route.ts', 'src/app/api/auth/me/route.test.ts',
    'src/app/api/auth/creative-access/route.ts',
    'src/lib/algorithm/three-stage.ts', 'src/lib/algorithm/three-stage-config.ts',
    'src/lib/algorithm/three-stage.test.ts', 'src/lib/algorithm/three-stage.regression.test.ts',
    'src/lib/algorithm/three-stage-boundary.test.ts', 'src/components/GrowthProfitConfigEditor.tsx',
    'src/lib/ai-access.ts', 'src/lib/ai-access.test.ts',
    'src/lib/ai-access-route-security.ts', 'src/lib/ai-access-operations.ts', 'src/lib/ai-access-operations.test.ts',
    'src/lib/ai-access-route-security.test.ts', 'src/lib/ai-access-production-reports.ts', 'src/lib/ai-access-production-reports.test.ts',
    'src/lib/ai-access-operation-policy.ts', 'src/lib/ai-access-operation-policy.test.ts',
    'src/app/api/ai-access/grants/route.ts', 'src/app/api/ai-access/grants/route.test.ts',
    'src/app/api/ai-access/grants/[id]/route.ts', 'src/app/api/ai-access/grants/[id]/route.test.ts',
    'src/app/api/ai-access/events/route.ts', 'src/app/api/ai-access/events/route.test.ts',
    'src/app/api/ai-access/execute/route.ts', 'src/app/api/ai-access/execute/route.test.ts',
    'src/app/api/ai-access/routes.test.ts',
    'src/app/management/ai-access/page.tsx', 'src/app/management/page.tsx', 'src/components/management/ManagementConsole.tsx',
    'src/components/management/AIAccessConsole.tsx', 'src/components/management/AIAccessConsole.module.css',
    'src/components/management/AIAccessConsole.test.ts',
    'scripts/test-security-nginx.mjs', 'scripts/test-security-rate-postgres.mjs'
} | SQL_FILES
REQUIRED_OVERLAY = {
    'src/middleware.ts', 'next.config.mjs', 'src/lib/request-security.ts',
    'src/lib/security-rate-limit.ts', 'src/lib/security-web-account.ts', 'src/lib/security-response.ts',
    'src/lib/creative-asset-policy.ts', 'src/app/api/creative/assets/[...path]/route.ts',
    'src/lib/algorithm/three-stage.ts', 'src/lib/algorithm/three-stage-config.ts', 'src/components/GrowthProfitConfigEditor.tsx',
    'src/lib/ai-access.ts', 'src/lib/ai-access-route-security.ts', 'src/lib/ai-access-operations.ts',
    'src/lib/ai-access-operation-policy.ts', 'src/app/api/ai-access/execute/route.ts',
    'src/app/api/ai-access/grants/route.ts', 'src/app/api/ai-access/grants/[id]/route.ts',
    'src/app/api/ai-access/events/route.ts', 'src/app/management/ai-access/page.tsx',
    'src/components/management/AIAccessConsole.tsx', 'src/components/management/AIAccessConsole.module.css',
    'src/components/management/ManagementConsole.tsx', 'prisma/schema.prisma',
    'src/lib/creative-access-policy.ts', 'src/lib/creative-entitlements.ts',
    'src/lib/production-compatibility-policy.ts', 'src/lib/ai-access-production-reports.ts',
    'src/lib/read-json-with-limit.ts', 'src/app/api/protected-downloads/[...path]/route.ts',
    'src/lib/server-session.ts', 'src/lib/auth-redirect-url.ts',
    'src/app/api/auth/login/route.ts', 'src/app/api/auth/register/route.ts', 'src/lib/accounts.ts',
    'src/app/api/auth/me/route.ts', 'src/app/api/auth/creative-access/route.ts', 'src/app/management/page.tsx'
} | SQL_FILES
REQUIRED_TESTS = {
    'src/middleware.test.ts', 'src/lib/request-security.test.ts', 'src/lib/security-rate-limit.test.ts',
    'src/lib/security-web-account.test.ts', 'src/lib/creative-asset-policy.test.ts',
    'src/app/api/creative/assets/[...path]/route.test.ts', 'src/lib/ai-access.test.ts',
    'src/lib/ai-access-operation-policy.test.ts', 'src/lib/algorithm/three-stage-boundary.test.ts',
    'src/components/management/AIAccessConsole.test.ts',
    'src/middleware-compatibility.test.ts', 'src/middleware-creative-return.test.ts', 'src/lib/production-compatibility-policy.test.ts',
    'src/lib/creative-entitlements-production.test.ts', 'src/lib/ai-access-production-reports.test.ts',
    'src/lib/ai-access-operations.test.ts', 'src/lib/ai-access-route-security.test.ts',
    'src/app/api/ai-access/routes.test.ts', 'src/app/api/protected-downloads/[...path]/route.test.ts',
    'src/lib/read-json-with-limit.test.ts', 'src/app/api/auth/login/route.test.ts', 'src/app/api/auth/register/route.test.ts'
}
ANONYMOUS_CHECKS = [
    {'path': '/login', 'status': 200},
    {'path': '/downloads/shaozhuang-ai-legacy-icon.png', 'method': 'HEAD', 'status': 200},
    {'path': '/tools', 'status': 307, 'loginRedirect': True},
    {'path': '/management/ai-access', 'status': 307, 'loginRedirect': True},
    {'path': '/creative/labs/image-prompt-lab/promptlab.html', 'status': 307, 'loginRedirect': True},
    {'path': '/creative/labs/image-prompt-lab/studio-genesis-contract.js', 'status': 307, 'loginRedirect': True},
    {'path': '/creative/labs/image-prompt-lab/README.md', 'status': 307, 'loginRedirect': True},
    {'path': '/_next/static/security-fixture.js.map', 'status': 404},
    {'path': '/.env', 'status': 404},
    {'path': '/api/auth/me', 'status': 401},
    {'path': '/api/ai-access/grants', 'status': 401},
    {'path': '/api/ai-access/execute', 'status': 405},
    {'path': '/api/auth/me', 'status': 403, 'aiDeclared': True}
]
SIGNED_CREATIVE_CHECKS = [
    {'path': '/creative/labs/image-prompt-lab/promptlab.html?mode=main&source=web&studio=1',
     'status': 200, 'signed': True, 'contentType': 'text/html', 'creativeAsset': True},
    {'path': '/creative/labs/image-prompt-lab/studio-genesis-ui.js?v=20261002-plugin83-main-mode-v1',
     'status': 200, 'signed': True, 'contentType': 'text/javascript', 'creativeAsset': True}
]


def database_file(name):
    return name.endswith(('.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3'))


def ignored(name):
    return any(v in IGNORE_DIRS for v in PurePosixPath(name).parts) or name == 'next-env.d.ts' or name.endswith('.tsbuildinfo')


def inventory(root):
    result = {}
    def visit(source, relative, ancestors=()):
        if ignored(relative) or relative in RUNTIME_LINKS or database_file(relative) or (relative.startswith('.env') and '/' not in relative and relative != '.env.example'):
            return
        resolved = source.resolve(strict=True)
        need(resolved not in ancestors, 'Baseline symlink cycle')
        if source.is_dir():
            for child in sorted(source.iterdir()):
                visit(child, relative + '/' + child.name, (*ancestors, resolved))
        else:
            need(source.is_file(), 'Special source file rejected')
            result[relative] = descriptor(source)
    for child in sorted(Path(root).iterdir()):
        visit(child, child.name)
    need({'package.json', 'prisma/schema.prisma', LATEST} <= set(result), 'Incomplete baseline')
    return result


def environment_identity(root):
    result = {}
    for source in sorted(Path(root).glob('.env*')):
        if source.name == '.env.example':
            continue
        need(source.is_file(), 'Environment reference missing')
        s = source.stat()
        result[source.name] = {'target': str(source.resolve()), 'device': s.st_dev, 'inode': s.st_ino, 'size': s.st_size, 'mtimeNs': s.st_mtime_ns, 'ctimeNs': s.st_ctime_ns}
    need('.env' in result, 'Baseline .env required')
    return result


def runtime_identity(root):
    root = Path(root)
    result = {}
    def visit(source, relative):
        if relative in RUNTIME_LINKS or database_file(relative):
            result[relative] = str(source.resolve(strict=True))
        elif source.is_dir() and not ignored(relative):
            for child in source.iterdir():
                visit(child, relative + '/' + child.name)
    for child in root.iterdir():
        visit(child, child.name)
    return result


def sql_statements(text):
    need(isinstance(text, str) and len(text) < 65536 and '$$' not in text and '/*' not in text, 'SQL lexical form rejected')
    text = re.sub(r'--[^\n]*', '', text)
    result, start, quote, index = [], 0, None, 0
    while index < len(text):
        char = text[index]
        if quote:
            if char == quote:
                if index + 1 < len(text) and text[index + 1] == quote:
                    index += 1
                else:
                    quote = None
        elif char in ('\"', "'"):
            quote = char
        elif char == ';':
            statement = text[start:index].strip()
            if statement:
                result.append(statement)
            start = index + 1
        index += 1
    need(not quote and not text[start:].strip(), 'SQL requires complete semicolon statements')
    return result


def validate_sql(name, text):
    statements = sql_statements(text)
    expected = MIGRATIONS[name]
    tables = set()
    for sql in statements:
        table = re.match(r'^CREATE TABLE "([A-Za-z]+)"\s*\(', sql)
        index = re.match(r'^CREATE (?:UNIQUE )?INDEX "([A-Za-z_]+)" ON "([A-Za-z]+)"\s*\(', sql)
        need(bool(table or index), 'Only isolated CREATE TABLE/INDEX SQL is permitted')
        if table:
            need(table[1] in expected and table[1] not in tables, 'Migration table scope differs')
            tables.add(table[1])
        else:
            need(index[2] in expected and index[1].startswith(index[2] + '_'), 'Migration index scope differs')
        grammar = re.sub(r"'(?:''|[^'])*'", "''", sql)
        grammar = re.sub(r'ON DELETE (?:CASCADE|SET NULL)', '', grammar, flags=re.I)
        need(not re.search(r'\b(?:ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|COPY|GRANT|REVOKE|SELECT|EXECUTE|DO)\b', grammar, re.I), 'Unexpected migration statement')
        need(all(ref in {'User', 'AIAccessGrant'} for ref in re.findall(r'REFERENCES "([^"]+)"', sql)), 'Migration foreign-key scope differs')
    need(tables == expected, 'Migration must create exact owned tables')
    return statements


def verify_bundle(directory, manifest_path, manifest_sha):
    directory, manifest_path = Path(directory), Path(manifest_path)
    need(descriptor(manifest_path)['sha256'] == manifest_sha, 'Manifest SHA differs')
    manifest = read_json(manifest_path)
    need(manifest.get('schema') == MANIFEST_SCHEMA and re.fullmatch(r'[0-9a-f]{40}', manifest.get('sourceCommit', '')), 'Manifest identity rejected')
    need(manifest.get('downloadPolicy') in {'protected', 'public'}, 'Bind download policy explicitly to the reviewed overlay')
    seal = manifest.get('sourceInventory', {})
    need(set(seal) == {'count', 'sha256'} and type(seal['count']) is int and seal['count'] > 0 and HEX.fullmatch(seal['sha256']), 'Full baseline source inventory seal required')
    files = manifest.get('files')
    need(isinstance(files, dict) and REQUIRED_OVERLAY | REQUIRED_TESTS <= set(files) <= ALLOW_OVERLAY, 'Security overlay scope incomplete or unlisted')
    actual = set()
    for source in directory.rglob('*'):
        need(not source.is_symlink(), 'Linked overlay rejected')
        if source.is_file():
            actual.add(source.relative_to(directory).as_posix())
        else:
            need(source.is_dir(), 'Special overlay rejected')
    need(actual == set(files), 'Overlay extra or missing files')
    for name, row in files.items():
        safe_relative(name)
        source = directory / name
        no_symlinks(source, directory)
        need(isinstance(row, dict) and set(row) == {'before', 'after'} and (row['before'] is None or valid_descriptor(row['before'])) and valid_descriptor(row['after']), 'Invalid before/after descriptor')
        need(descriptor(source) == row['after'], 'Sealed overlay bytes differ: ' + name)
        if name in SQL_FILES:
            need(row['before'] is None, 'Owned migration must be new in baseline')
            validate_sql(PurePosixPath(name).parts[-2], source.read_text())
    need(not manifest.get('checks'), 'Runner owns fixed read-only HTTP checks; arbitrary probes forbidden')
    return manifest


def expected_candidate(base_files, manifest):
    result = dict(base_files)
    for name, row in manifest['files'].items():
        need(base_files.get(name) == row['before'], 'Baseline file CAS differs: ' + name)
        result[name] = row['after']
    return result


def nginx_retarget(data, old_port, new_port, target_string=None):
    rows = nginx_directives(data, include_ancestry=True)
    target_map = b'$sanjie_app_port'
    maps = [(header, body) for header, body, _ in rows if header[0][0] == b'map' and header[-1][0] == target_map]
    need(len(maps) == 1, 'Publish requires exactly one known application default map')
    header, entries = maps[0]
    need(len(header) == 3 and header[1][0] == b'$cookie_sanjie_creative_uat' and entries, 'Application map identity differs')
    defaults = [entry for entry, children in entries if entry[0][0] == b'default' and children is None]
    need(len(defaults) == 1 and len(defaults[0]) == 2 and defaults[0][1][0] == str(old_port).encode(), 'Application default port differs')
    need(not any(header[0][0] in (b'set', b'set_if_empty') and len(header) > 1 and header[1][0] == target_map for header, _, _ in rows), 'Application map override rejected')
    need(any(header[0][0] == b'proxy_pass' and len(header) == 2 and header[1][0] == b'http://127.0.0.1:$sanjie_app_port' for header, _, _ in rows), 'Application map is unused')
    start, end = defaults[0][1][1:]
    if target_string is not None:
        encoded = target_string.encode()
        need(data.count(encoded) == 1 and re.fullmatch(rb'default\s+' + str(old_port).encode() + rb'\s*;', encoded), 'Explicit Nginx target must match one default directive')
        target_start = data.index(encoded)
        need(target_start <= start < end <= target_start + len(encoded), 'Explicit Nginx target is not the app default')
    need(data[start:end] == str(old_port).encode(), 'Nginx selected byte span differs')
    return data[:start] + str(new_port).encode() + data[end:]


def build_inventory(root):
    root = Path(root) / '.next'
    need((root / 'BUILD_ID').is_file(), 'Next production build missing')
    return {p.relative_to(root).as_posix(): descriptor(p) for p in sorted(root.rglob('*')) if p.is_file() and 'cache' not in p.relative_to(root).parts and p.name != 'trace'}


def smoke(origin, latest, files, signed_cookie=None, after_migration=False, download_policy='protected'):
    rows = []
    public_downloads = set(PUBLIC_DOWNLOAD_PATHS) if download_policy == 'public' else set()
    need(all('public' + path in files for path in public_downloads), 'Retained exact public packages missing from baseline')
    checks = ANONYMOUS_CHECKS + [
        {'path': '/' + name.removeprefix('public/'), 'method': 'HEAD',
         'status': 200 if '/' + name.removeprefix('public/') in public_downloads else 401}
        for name in sorted(files) if name.startswith('public/downloads/') and name.endswith('.zip')
    ]
    if signed_cookie:
        checks += [{'path': '/api/auth/me', 'status': 200, 'signed': True}, {'path': '/api/auth/creative-access', 'status': 200, 'signed': True}]
        if after_migration:
            checks += [{'path': '/api/shops', 'status': 200, 'signed': True}, {'path': '/management/ai-access', 'status': 200, 'signed': True}]
            checks += SIGNED_CREATIVE_CHECKS
            # Nginx terminates HTTPS while Next listens on loopback HTTP. Exercise
            # that exact protocol boundary before the public backend is changed.
            if urllib.parse.urlsplit(origin).hostname == '127.0.0.1':
                checks += [{**check, 'proxyHttps': True} for check in SIGNED_CREATIVE_CHECKS]
    for check in checks:
        headers = {'Host': 'shaozhuangai.com'}
        if check.get('signed'):
            headers['Cookie'] = signed_cookie
        if check.get('aiDeclared'):
            headers['x-sanjie-ai-client'] = 'security-acceptance'
        if check.get('proxyHttps'):
            headers.update({'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'shaozhuangai.com', 'X-Forwarded-Port': '443'})
        status, body, response_headers = request(origin, check['path'], check.get('method', 'GET'), extra_headers=headers)
        need(status == check['status'], 'Read-only acceptance status differs: ' + check['path'] + ' (' + str(status) + ')')
        if check.get('loginRedirect'):
            location = urllib.parse.urlsplit(urllib.parse.urljoin(origin, response_headers.get('Location', '')))
            need(location.path == '/login' and location.netloc in {'shaozhuangai.com', urllib.parse.urlsplit(origin).netloc}, 'Login redirect origin differs')
        if check['path'] == '/api/auth/me' and check.get('signed'):
            need(json.loads(body).get('data', {}).get('role') == 'admin', 'Signed read-only account did not resolve admin')
        if check['path'] in public_downloads:
            need(response_headers.get('Content-Length') == str(files['public' + check['path']]['size']), 'Retained package Content-Length differs')
        row = {'path': check['path'], 'method': check.get('method', 'GET'), 'status': status, 'signed': bool(check.get('signed'))}
        if check.get('creativeAsset'):
            content_type = response_headers.get('Content-Type', '').split(';', 1)[0].strip().lower()
            need(content_type == check['contentType'], 'Creative asset Content-Type differs: ' + check['path'])
            expected_headers = {'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "frame-ancestors 'self'",
                                'Cross-Origin-Resource-Policy': 'same-origin', 'X-Content-Type-Options': 'nosniff'}
            need(all(response_headers.get(name) == value for name, value in expected_headers.items()), 'Creative asset security headers differ: ' + check['path'])
            need(response_headers.get('Cache-Control', '').replace(' ', '') == 'private,no-store', 'Creative asset cache policy differs: ' + check['path'])
            if content_type == 'text/html':
                need(b'<html' in body.lower() and b'id="labStartupScript"' in body, 'Creative iframe HTML content differs')
            else:
                source_name = 'public' + urllib.parse.urlsplit(check['path']).path
                need(source_name in files and {'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()} == files[source_name], 'Creative runtime script bytes differ')
            row.update(contentType=content_type, securityHeaders=expected_headers, proxyHttps=bool(check.get('proxyHttps')))
        rows.append(row)
    status, body, headers = request(origin, LATEST_ROUTE, extra_headers={'Host': 'shaozhuangai.com'}, limit=65536)
    need(status == 200 and {'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()} == latest, 'Existing signed updater bytes changed')
    rows.append({'path': LATEST_ROUTE, 'status': status, 'sha256': latest['sha256']})
    return rows


SIGN_READ_SESSION_JS = r"""
require('@next/env').loadEnvConfig(process.cwd());
const {PrismaClient}=require('@prisma/client'), crypto=require('node:crypto');
const db=new PrismaClient({log:[]});
(async()=>{try{
 if(!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length<32) throw Error('Missing secure signing configuration');
 const user=await db.user.findFirst({where:{authRole:'admin',status:'active'},select:{username:true,name:true,tenantId:true},orderBy:{createdAt:'asc'}});
 if(!user) throw Error('No active administrator for read-only acceptance');
 const now=Math.floor(Date.now()/1000),payload=encodeURIComponent(JSON.stringify({username:user.username,role:'admin',name:user.name,tenantId:user.tenantId,iat:now,exp:now+900}));
 const sig=crypto.createHmac('sha256',process.env.SESSION_SECRET).update(payload).digest('hex');
 const cookie=(process.env.SANJIE_SESSION_COOKIE_NAME||'sanjie_session')+'='+encodeURIComponent(sig+'.'+payload);
 process.stdout.write(JSON.stringify({cookie}));
}catch(e){process.stderr.write('Read-only session acceptance setup failed\n');process.exitCode=1;}finally{await db.$disconnect();}})();
"""


def dependency_identity(root):
    root = Path(root)
    files = [root / 'node_modules/next/package.json', root / 'node_modules/@prisma/client/package.json', root / 'node_modules/@prisma/client/runtime/library.js']
    client = (root / 'node_modules/@prisma/client/package.json').resolve(strict=True)
    generated = client.parents[2] / '.prisma/client'
    files += [generated / name for name in ('schema.prisma', 'default.js', 'index.js', 'index.d.ts') if (generated / name).is_file()]
    return {'target': str((root / 'node_modules').resolve(strict=True)), 'criticalFiles': {str(p.resolve(strict=True)): descriptor(p) for p in files}}


class Deployment:
    def __init__(self, args):
        self.args, self.new = args, args.candidate
        need(self.new.is_absolute() and self.new.parent == BASE.parent and self.new != BASE and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{1,100}', self.new.name), 'Candidate directory rejected')
        need(not self.new.is_symlink() and BASE.is_dir() and not BASE.is_symlink(), 'Release root linked/missing')
        need(HEX.fullmatch(args.runner_sha256) and descriptor(Path(__file__))['sha256'] == args.runner_sha256, 'Runner seal differs')
        need(HEX.fullmatch(args.manifest_sha256), 'Manifest SHA required')
        self.manifest = verify_bundle(args.overlay, args.manifest, args.manifest_sha256)
        self.logs = self.new / 'deployment-logs/security-channel-20261002'
        self.statefile = self.logs / 'state.json'
        self.identity = {'runnerSha256': args.runner_sha256, 'manifestSha256': args.manifest_sha256, 'baseline': str(BASE), 'baselineName': OLD_NAME, 'baselinePort': OLD_PORT, 'candidate': str(self.new), 'candidateName': NEW_NAME, 'candidatePort': NEW_PORT, 'nginxSha256': EXPECTED_NGINX, 'sourceCommit': self.manifest['sourceCommit']}

    def save(self, state, phase):
        state.update(phase=phase, updatedAt=now())
        write_json(self.statefile, state)

    def load(self):
        no_symlinks(self.statefile, self.new)
        state = read_json(self.statefile)
        need(state.get('schema') == SCHEMA and state.get('identity') == self.identity, 'Bound stage state differs')
        return state

    def baseline(self, state=None, after_cutover=False):
        need(descriptor(CONF)['sha256'] == (state['publishedNginxSha256'] if after_cutover else EXPECTED_NGINX), 'Nginx CAS differs')
        source = inventory(BASE)
        active = process(OLD_NAME, BASE, OLD_PORT)
        env, runtime, deps = environment_identity(BASE), runtime_identity(BASE), dependency_identity(BASE)
        app_sha = environment_fingerprint(application_environment(OLD_NAME))
        if state:
            need(source == state['baseFiles'] and active == state['baselineProcess'], 'Baseline source/process drift')
            need(env == state['environment'] and runtime == state['runtime'] and deps == state['dependencies'] and app_sha == state['applicationEnvironmentSha256'], 'Baseline environment/runtime/dependencies drift')
            existing = retained_processes()
            need(all(existing.get(name) == before for name, before in state['retainedProcesses'].items()), 'Existing PM2 identity changed')
            need(set(existing) <= set(state['retainedProcesses']) | {NEW_NAME}, 'Concurrent PM2 process detected')
        else:
            need(source_inventory_summary(source) == self.manifest['sourceInventory'], 'Whole baseline source seal differs')
        return source, active, env, runtime, deps, app_sha

    def child_environment(self, state, production=False):
        app = application_environment(OLD_NAME)
        need(environment_fingerprint(app) == state['applicationEnvironmentSha256'], 'Application environment drift')
        env = {key: value for key, value in os.environ.items() if not app_key(key)}
        env.pop('NODE_ENV', None)
        env.update(app)
        env.update(NODE_OPTIONS='--max-old-space-size=4096', PYTHONDONTWRITEBYTECODE='1', SANJIE_CANONICAL_ROOT=str(self.new))
        if production:
            env.update(NODE_ENV='production', PORT=str(NEW_PORT))
        return env

    def logged(self, argv, label, env=None, timeout=3600):
        log = self.logs / (label + '-' + str(time.time_ns()) + '.log')
        with log.open('xb') as output_file:
            result = subprocess.run(argv, cwd=self.new, env=env, stdout=output_file, stderr=subprocess.STDOUT, timeout=timeout)
        need(result.returncode == 0, 'Command failed; inspect private log ' + str(log))
        print('PASS ' + label, flush=True)
        return str(log)

    def signed_cookie(self, state):
        result = subprocess.run(['node', '-e', SIGN_READ_SESSION_JS], cwd=self.new, env=self.child_environment(state), capture_output=True, text=True, timeout=30)
        need(result.returncode == 0, 'Read-only signed session setup failed')
        cookie = json.loads(result.stdout).get('cookie')
        need(isinstance(cookie, str) and len(cookie) < 8192 and '\n' not in cookie, 'Signed session result invalid')
        return cookie  # Memory only: never write this value to logs, state or receipts.

    def clone(self):
        need(not self.new.exists() and not self.new.is_symlink(), 'Candidate exists; never overwrite')
        need(shutil.disk_usage(BASE.parent).free > 8 * 1024**3, 'Need 8 GiB free')
        self.new.mkdir(mode=0o755)
        def copy(source, target, relative):
            if ignored(relative):
                return
            private_env = relative.startswith('.env') and '/' not in relative and relative != '.env.example'
            if relative in RUNTIME_LINKS or database_file(relative) or private_env:
                target.symlink_to(source.resolve(strict=True), target_is_directory=source.is_dir())
            elif source.is_dir():
                target.mkdir(mode=stat.S_IMODE(source.stat().st_mode))
                for child in source.iterdir():
                    copy(child, target / child.name, relative + '/' + child.name)
            else:
                need(source.is_file(), 'Special baseline file rejected')
                shutil.copy2(source, target, follow_symlinks=True)
        for source in BASE.iterdir():
            copy(source, self.new / source.name, source.name)
        (self.new / 'node_modules').symlink_to((BASE / 'node_modules').resolve(strict=True), target_is_directory=True)
        self.logs.mkdir(parents=True, mode=0o700)

    def candidate(self, state, check_build=True):
        need(inventory(self.new) == state['candidateFiles'], 'Candidate source CAS differs')
        need(environment_identity(self.new) == state['environment'] and runtime_identity(self.new) == state['runtime'], 'Candidate credentials/runtime references differ')
        need(dependency_identity(self.new) == state['dependencies'] and (self.new / 'node_modules').is_symlink(), 'Candidate dependencies changed')
        for name in state['runtime']:
            need((self.new / name).is_symlink(), 'Runtime data must be referenced without copying')
        if check_build:
            need(build_inventory(self.new) == state['buildFiles'], 'Candidate build seal differs')

    def prepare(self):
        source, active, env, runtime, deps, app_sha = self.baseline()
        expected = expected_candidate(source, self.manifest)
        need(NEW_NAME not in retained_processes(), 'Candidate PM2 name exists')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', NEW_PORT))
        output(['nginx', '-t'])
        retained = retained_processes()
        self.clone()
        state = {'schema': SCHEMA, 'identity': self.identity, 'createdAt': now(), 'baseFiles': source, 'candidateFiles': expected, 'baselineProcess': active, 'environment': env, 'runtime': runtime, 'dependencies': deps, 'applicationEnvironmentSha256': app_sha, 'retainedProcesses': retained, 'databaseMigrationExecuted': False, 'published': False, 'providerRequestsExecuted': False, 'grantCreationExecuted': False}
        self.save(state, 'preparing')
        try:
            for name in self.manifest['files']:
                target = self.new / name
                no_symlinks(target, self.new)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(self.args.overlay / name, target)
            self.candidate(state, False)
            self.baseline(state)
            child_env = self.child_environment(state)
            state['preBuildPublicationGuardLog'] = self.logged(['bash', 'scripts/predeploy-guard.sh'], 'preserved-publication-guard-before-build', child_env)
            tests = sorted(name for name in self.manifest['files'] if name.endswith('.test.ts'))
            state['testLog'] = self.logged(['node', 'node_modules/vitest/vitest.mjs', 'run', *tests], 'security-tests', child_env)
            state['typecheckLog'] = self.logged(['node', 'node_modules/typescript/bin/tsc', '--noEmit'], 'typecheck', child_env)
            state['buildLog'] = self.logged(['node', 'node_modules/next/dist/bin/next', 'build'], 'build', child_env)
            need(not list((self.new / '.next/static').rglob('*.map')), 'Public browser source map build artifact')
            self.baseline(state)
            self.candidate(state, False)
            self.logged(['pm2', 'start', 'node_modules/next/dist/bin/next', '--name', NEW_NAME, '--cwd', str(self.new), '--interpreter', 'node', '--', 'start', '--hostname', '127.0.0.1', '--port', str(NEW_PORT)], 'start-loopback-canary', self.child_environment(state, True), 60)
            for attempt in range(40):
                try:
                    with socket.create_connection(('127.0.0.1', NEW_PORT), timeout=1):
                        break
                except OSError:
                    time.sleep(1)
            state['candidateProcess'] = process(NEW_NAME, self.new, NEW_PORT)
            need(environment_fingerprint(application_environment(NEW_NAME)) == app_sha, 'Canary app environment differs')
            state['canaryChecks'] = smoke('http://127.0.0.1:' + str(NEW_PORT), source[LATEST], expected, self.signed_cookie(state), download_policy=self.manifest['downloadPolicy'])
            state['authenticatedWorkspaceChecksDeferredUntilMigration'] = True
            state['buildFiles'] = build_inventory(self.new)
            self.candidate(state)
            self.baseline(state)
            self.save(state, 'prepared')
            print(json.dumps({'phase': 'prepared', 'candidate': str(self.new), 'port': NEW_PORT, 'overlayFiles': len(self.manifest['files']), 'published': False, 'databaseMigrationExecuted': False, 'signedReadOnlyChecks': 2, 'authenticatedWorkspaceChecksDeferredUntilMigration': True}))
        except BaseException as error:
            state['failure'] = str(error)
            self.save(state, 'prepare-failed')
            raise

    def publish(self):
        state = self.load()
        need(state['phase'] == 'prepared', 'Publish requires prepared bound stage')
        self.baseline(state)
        self.candidate(state)
        need(process(NEW_NAME, self.new, NEW_PORT) == state['candidateProcess'], 'Canary PM2 process drift')
        need(environment_fingerprint(application_environment(NEW_NAME)) == state['applicationEnvironmentSha256'], 'Canary app environment drift')
        original = CONF.read_bytes()
        changed = nginx_retarget(original, OLD_PORT, NEW_PORT, self.args.nginx_target_string)
        backup = CONF.with_name(CONF.name + '.pre-' + self.new.name)
        need(not backup.exists() and not backup.is_symlink(), 'Backup name exists')
        atomic_bytes(backup, original)
        state.update(rollbackNginx=str(backup), publishedNginxSha256=hashlib.sha256(changed).hexdigest())
        self.save(state, 'publishing')
        swapped = False
        try:
            self.baseline(state)
            state['migrations'] = self.apply_migrations(state)
            state['databaseMigrationExecuted'] = True
            self.save(state, 'publishing')
            signed = self.signed_cookie(state)
            state['postMigrationCanaryChecks'] = smoke('http://127.0.0.1:' + str(NEW_PORT), state['baseFiles'][LATEST], state['candidateFiles'], signed, True, self.manifest['downloadPolicy'])
            self.baseline(state)
            self.candidate(state)
            self.logged(['nginx', '-t'], 'before-switch-nginx-test', timeout=30)
            # os.replace may already commit before directory fsync (or a signal)
            # raises. From this point every failure must attempt CAS-safe restore.
            swapped = True
            atomic_bytes(CONF, changed, EXPECTED_NGINX)
            self.logged(['nginx', '-t'], 'switch-nginx-test', timeout=30)
            self.logged(['nginx', '-s', 'reload'], 'switch-nginx-reload', timeout=30)
            state['publicReadiness'] = wait_for_public_readiness(PUBLIC)
            state['publicChecks'] = smoke(PUBLIC, state['baseFiles'][LATEST], state['candidateFiles'], signed, True, self.manifest['downloadPolicy'])
            state['postPublicationGuardLog'] = self.logged(['bash', 'scripts/predeploy-guard.sh'], 'preserved-publication-guard-after-publish', self.child_environment(state))
            self.baseline(state, True)
            self.candidate(state)
            self.logged(['pm2', 'save'], 'save-pm2', timeout=30)
            self.baseline(state, True)
            state['published'] = True
            state['publishedAt'] = now()
            self.save(state, 'published')
            write_json(self.logs / 'publication-receipt.json', {key: state[key] for key in ('schema', 'identity', 'published', 'publishedAt', 'migrations', 'publicReadiness', 'publicChecks', 'preBuildPublicationGuardLog', 'postPublicationGuardLog', 'databaseMigrationExecuted', 'providerRequestsExecuted', 'grantCreationExecuted', 'rollbackNginx')})
            print(json.dumps({'phase': 'published', 'candidate': str(self.new), 'databaseMigrationExecuted': True, 'oldProcessRetained': True, 'rollbackNginx': str(backup)}))
        except BaseException as error:
            state['failure'] = str(error)
            if swapped:
                try:
                    self.restore(state)
                except BaseException as rollback_error:
                    state['rollbackFailure'] = str(rollback_error)
                    self.save(state, 'needs-attention')
            else:
                self.save(state, 'publish-failed')
            raise

    def restore(self, state):
        need(descriptor(CONF)['sha256'] in {EXPECTED_NGINX, state['publishedNginxSha256']}, 'External Nginx change; rollback refused')
        original = Path(state['rollbackNginx']).read_bytes()
        need(hashlib.sha256(original).hexdigest() == EXPECTED_NGINX, 'Rollback backup mutated')
        process(OLD_NAME, BASE, OLD_PORT)
        atomic_bytes(CONF, original, descriptor(CONF)['sha256'])
        self.logged(['nginx', '-t'], 'rollback-nginx-test', timeout=30)
        self.logged(['nginx', '-s', 'reload'], 'rollback-nginx-reload', timeout=30)
        need(descriptor(CONF)['sha256'] == EXPECTED_NGINX, 'Rollback Nginx readback differs')
        state['published'] = False
        state['databaseTablesRetained'] = True  # Never drop tables or user grants when rolling back app routing.
        self.save(state, 'rolled-back')

    def rollback(self):
        state = self.load()
        need(state['phase'] in {'published', 'publishing', 'publish-failed', 'needs-attention'}, 'No routing publication to roll back')
        self.restore(state)

    def status(self):
        state = self.load()
        print(json.dumps({key: state.get(key) for key in ('phase', 'identity', 'failure', 'rollbackFailure', 'published', 'databaseMigrationExecuted', 'updatedAt')}, indent=2))

    def apply_migrations(self, state):
        payload = []
        for name in MIGRATIONS:
            relative = 'prisma/migrations/' + name + '/migration.sql'
            source = self.new / relative
            need(descriptor(source) == self.manifest['files'][relative]['after'], 'Migration seal differs')
            payload.append({'name': name, 'checksum': descriptor(source)['sha256'], 'statements': validate_sql(name, source.read_text()), 'tables': sorted(MIGRATIONS[name])})
        spec = self.logs / 'owned-migration-plan.json'
        write_json(spec, payload)
        result = subprocess.run(['node', '-e', MIGRATE_OWNED_JS, str(spec)], cwd=self.new, env=self.child_environment(state), capture_output=True, text=True, timeout=90)
        need(result.returncode == 0, 'Owned migration validation/application failed; existing unrelated tables are never repaired automatically')
        return json.loads(result.stdout)


MIGRATE_OWNED_JS = r"""
require('@next/env').loadEnvConfig(process.cwd());
const fs=require('node:fs'),crypto=require('node:crypto'),{PrismaClient}=require('@prisma/client');
const plan=JSON.parse(fs.readFileSync(process.argv[1],'utf8')),db=new PrismaClient({log:[]});
const columns={
 SecurityRateBucket:{bucketKey:['bpchar',false,64],windowStart:['timestamptz',false],expiresAt:['timestamptz',false],hits:['int4',false]},
 AIAccessGrant:{id:['uuid',false],userId:['text',false],username:['text',false],tenantId:['text',false],name:['varchar',false,80],scope:['text',false],tokenHash:['bpchar',false,64],activeShopId:['text',true],createdAt:['timestamptz',false],expiresAt:['timestamptz',false],revokedAt:['timestamptz',true],lastUsedAt:['timestamptz',true]},
 AIAccessEvent:{id:['uuid',false],userId:['text',false],grantId:['uuid',true],type:['text',false],method:['varchar',true,10],path:['text',true],status:['int4',true],createdAt:['timestamptz',false]}
};
const constraints={
 SecurityRateBucket:{SecurityRateBucket_pkey:'PRIMARY KEY ("bucketKey", "windowStart")',SecurityRateBucket_key_check:"CHECK (\"bucketKey\" ~ '^[0-9a-f]{64}$'::text)",SecurityRateBucket_hits_check:'CHECK (hits > 0)',SecurityRateBucket_window_check:'CHECK ("expiresAt" > "windowStart")'},
 AIAccessGrant:{AIAccessGrant_pkey:'PRIMARY KEY (id)',AIAccessGrant_userId_fkey:'FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE',AIAccessGrant_scope_check:"CHECK (scope = ANY (ARRAY['read'::text, 'action'::text]))",AIAccessGrant_tokenHash_key:'UNIQUE ("tokenHash")',AIAccessGrant_tokenHash_check:"CHECK (\"tokenHash\" ~ '^[0-9a-f]{64}$'::text)",AIAccessGrant_lifetime_check:"CHECK (\"expiresAt\" > \"createdAt\" AND \"expiresAt\" <= \"createdAt\" + '01:00:00'::interval)"},
 AIAccessEvent:{AIAccessEvent_pkey:'PRIMARY KEY (id)',AIAccessEvent_grantId_fkey:'FOREIGN KEY ("grantId") REFERENCES "AIAccessGrant"(id) ON DELETE SET NULL',AIAccessEvent_type_check:"CHECK (type = ANY (ARRAY['create'::text, 'list'::text, 'revoke'::text, 'authorize'::text, 'context'::text, 'request'::text, 'events'::text]))",AIAccessEvent_status_check:'CHECK (status IS NULL OR status >= 100 AND status <= 599)',AIAccessEvent_path_check:"CHECK (path IS NULL OR path ~~ '/%'::text AND path !~~ '%?%'::text AND path !~~ '%#%'::text AND length(path) <= 200)"}
};
const indexes={
 SecurityRateBucket:{SecurityRateBucket_pkey:['("bucketKey", "windowStart")',true],SecurityRateBucket_expiresAt_idx:['("expiresAt")',false]},
 AIAccessGrant:{AIAccessGrant_pkey:['(id)',true],AIAccessGrant_tokenHash_key:['("tokenHash")',true],AIAccessGrant_userId_createdAt_idx:['("userId", "createdAt" DESC)',false],AIAccessGrant_expiresAt_idx:['("expiresAt")',false]},
 AIAccessEvent:{AIAccessEvent_pkey:['(id)',true],AIAccessEvent_userId_createdAt_idx:['("userId", "createdAt" DESC)',false],AIAccessEvent_grantId_createdAt_idx:['("grantId", "createdAt" DESC)',false]}
};
// Preserve quoted identifiers and literal contents. Compare the COMPLETE known
// definition, never a substring that could also occur in CHECK (... OR TRUE).
const normalize=s=>s.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+|public\.|[A-Z]+/g,t=>t[0]==="'"?t:t[0]==='"'?t.slice(1,-1):/^\s+$/.test(t)||t==='public.'?'':t.toLowerCase());
// These fixed checks contain only simple comparisons, ALL-AND conjunctions or
// a leading IS NULL OR all-required comparisons. Ignore PostgreSQL's redundant
// expression parentheses/text coercions, while keeping every operator/literal.
const normalizeConstraint=s=>normalize(s.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|::text\b|[()]/g,t=>t[0]==="'"||t[0]==='"'?t:''));
const assert=(yes)=>{if(!yes)throw Error('Owned migration shape/CAS mismatch')};
async function verify(tx,table){
 const found=await tx.$queryRawUnsafe('SELECT column_name,udt_name,is_nullable,character_maximum_length,column_default FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1',table);
 const expected=columns[table];assert(found.length===Object.keys(expected).length);
 for(const row of found){const e=expected[row.column_name];assert(e && e[0]===row.udt_name && e[1]===(row.is_nullable==='YES') && (e[2]===undefined ? row.character_maximum_length===null : e[2]===row.character_maximum_length));
  const defaultValue=row.column_name==='hits'?'1':row.column_name==='id'?'gen_random_uuid()':row.column_name==='createdAt'?'CURRENT_TIMESTAMP':null;
  assert(defaultValue===null ? row.column_default===null : typeof row.column_default==='string' && normalize(row.column_default)===normalize(defaultValue));
 }
 const c=await tx.$queryRawUnsafe('SELECT c.conname,c.convalidated,c.condeferrable,c.condeferred,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=current_schema() AND t.relname=$1',table);
 assert(c.length===Object.keys(constraints[table]).length);
 for(const row of c){const definition=constraints[table][row.conname];assert(definition && row.convalidated===true && row.condeferrable===false && row.condeferred===false && normalizeConstraint(row.definition)===normalizeConstraint(definition));}
 const idx=await tx.$queryRawUnsafe('SELECT v.indexname,v.indexdef,x.indisunique,x.indisvalid,x.indisready,a.amname FROM pg_indexes v JOIN pg_namespace n ON n.nspname=v.schemaname JOIN pg_class i ON i.relnamespace=n.oid AND i.relname=v.indexname JOIN pg_index x ON x.indexrelid=i.oid JOIN pg_am a ON a.oid=i.relam WHERE v.schemaname=current_schema() AND v.tablename=$1',table);
 assert(idx.length===Object.keys(indexes[table]).length);
 for(const row of idx){const shape=indexes[table][row.indexname];assert(shape && row.indisunique===shape[1] && row.indisvalid===true && row.indisready===true && row.amname==='btree');
  const definition=`CREATE ${shape[1]?'UNIQUE ':''}INDEX "${row.indexname}" ON public."${table}" USING btree ${shape[0]}`;
  assert(normalize(row.indexdef)===normalize(definition));
 }
}
(async()=>{try{
 const receipt=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(20261002,145000)');
  const schema=await tx.$queryRawUnsafe('SELECT current_schema() AS name');assert(schema.length===1 && schema[0].name==='public');
  const marker=await tx.$queryRawUnsafe("SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present");assert(marker[0].present);
  const result=[];
  for(const migration of plan){
   const records=await tx.$queryRawUnsafe('SELECT checksum,finished_at,rolled_back_at FROM "_prisma_migrations" WHERE migration_name=$1',migration.name);
   const tables=await tx.$queryRawUnsafe('SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=ANY($1::text[])',migration.tables);
   assert(records.length<=1);
   if(records.length){assert(records[0].checksum===migration.checksum && records[0].finished_at && !records[0].rolled_back_at && tables.length===migration.tables.length);}
   else {assert(tables.length===0);for(const sql of migration.statements)await tx.$executeRawUnsafe(sql);}
   for(const table of migration.tables)await verify(tx,table);
   if(!records.length)await tx.$executeRawUnsafe('INSERT INTO "_prisma_migrations" (id,checksum,finished_at,migration_name,logs,rolled_back_at,started_at,applied_steps_count) VALUES ($1,$2,CURRENT_TIMESTAMP,$3,NULL,NULL,CURRENT_TIMESTAMP,1)',crypto.randomUUID(),migration.checksum,migration.name);
   result.push({migration:migration.name,checksum:migration.checksum,createdTables:records.length?[]:migration.tables,verified:true});
  }
  return result;
 },{timeout:60000,maxWait:10000});
 process.stdout.write(JSON.stringify(receipt));
}catch(e){process.stderr.write('Owned migration shape validation/application failed; no unrelated migration was executed\n');process.exitCode=1;}finally{await db.$disconnect();}})();
"""


def main():
    global BASE, OLD_NAME, OLD_PORT, NEW_NAME, NEW_PORT, EXPECTED_NGINX
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('prepare', 'publish', 'rollback', 'status'))
    parser.add_argument('--overlay', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--manifest-sha256', required=True)
    parser.add_argument('--runner-sha256', required=True)
    parser.add_argument('--nginx-sha256', required=True)
    parser.add_argument('--baseline', type=Path, default=BASE)
    parser.add_argument('--baseline-name', default=OLD_NAME)
    parser.add_argument('--baseline-port', type=int, default=OLD_PORT)
    parser.add_argument('--candidate', type=Path, default=Path('/opt/sanjie-releases/20261002-security-channel-v1'))
    parser.add_argument('--candidate-name', default=NEW_NAME)
    parser.add_argument('--candidate-port', type=int, default=NEW_PORT)
    parser.add_argument('--nginx-target-string', help='Optional reviewed exact app default directive, e.g. default 31948;')
    args = parser.parse_args()
    need(sys.platform.startswith('linux') and os.getuid() == 0, 'Use the existing authenticated Linux root shell')
    need(args.baseline.is_absolute() and args.baseline.parent == Path('/opt/sanjie-releases') and not args.baseline.is_symlink(), 'Baseline root rejected')
    need(HEX.fullmatch(args.nginx_sha256), 'Baseline Nginx SHA required')
    need(1024 <= args.baseline_port <= 65535 and 1024 <= args.candidate_port <= 65535 and args.baseline_port != args.candidate_port, 'Port pair rejected')
    need(all(re.fullmatch(r'sanjie-[A-Za-z0-9_-]{1,100}', name) for name in (args.baseline_name, args.candidate_name)), 'PM2 name rejected')
    BASE, OLD_NAME, OLD_PORT = args.baseline, args.baseline_name, args.baseline_port
    NEW_NAME, NEW_PORT, EXPECTED_NGINX = args.candidate_name, args.candidate_port, args.nginx_sha256
    args.overlay, args.manifest = args.overlay.resolve(strict=True), args.manifest.resolve(strict=True)
    os.umask(0o077)
    for binary in ('node', 'pm2', 'nginx'):
        need(shutil.which(binary), 'Required command unavailable: ' + binary)
    deployment = Deployment(args)
    if args.phase == 'status':
        deployment.status()
        return
    lock_fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        getattr(deployment, args.phase)()


if __name__ == '__main__':
    def interrupted(number, frame):
        raise RuntimeError('Interrupted by signal ' + str(number))
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except Exception as error:
        print('STOP: ' + str(error), file=sys.stderr)
        sys.exit(1)
