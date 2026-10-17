#!/usr/bin/env python3
"""Isolated creative UAT runner. Run only after the root task freezes the bundle.

Never replaces production application files, restarts its PM2 process, migrates
its database, prints credentials, or installs a public command relay.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

RELEASE = Path('/opt/sanjie-test-releases/20261001-creative-uat')
PRODUCTION = Path('/opt/sanjie-releases/20261001-cursor-b59de14-v2')
ASSET_FALLBACK = Path('/opt/sanjie-releases/20260925-ai1980-tenant-video-r51-v2')
PROCESS = 'sanjie-creative-uat-20261001'
PRODUCTION_PROCESS = 'sanjie-cursor-20261001-v2'
PORT = 32011
HOSTNAME = 'localhost'
PRODUCTION_PORT = 31918
DATABASE = 'sanjie_creative_uat_20261001'
CONF = Path('/etc/nginx/conf.d/sanjie.conf')
STATE = RELEASE / '.creative-uat-deployment.json'
ROUTE_COOKIE = 'sanjie_creative_uat'
ENVIRONMENT = 'creative-20261001'
ENTRY = '/uat/creative-20261001'
EXIT = '/uat/creative-exit'
MARKER = '# SANJIE CREATIVE UAT 20261001'
SECRET_NAMES = {'DATABASE_URL', 'SESSION_SECRET', 'SHARE_ENCRYPTION_KEY', 'AI_API_ENCRYPTION_KEY'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def scrub(value):
    """Keep tool results and logs free of DSNs, hashes, and known secret values."""
    value = re.sub(r'postgres(?:ql)?://[^\s\"\']+', '[database-url-redacted]', str(value))
    value = re.sub(r'scrypt\$[^\s\"\']+', '[password-hash-redacted]', value)
    for key in SECRET_NAMES:
        secret = os.environ.get(key, '')
        if len(secret) >= 8:
            value = value.replace(secret, '[secret-redacted]')
    return value


def run(argv, *, cwd=None, env=None, stdin=None, timeout=60, log=None):
    result = subprocess.run(argv, cwd=cwd, env=env, input=stdin,
                            capture_output=True, text=True, timeout=timeout)
    if log:
        Path(log).write_text(scrub(result.stdout + result.stderr))
    if result.returncode:
        # A failing provider/client can embed a connection string in its error.
        # Preserve diagnostics privately in the sanitized log, not in UI output.
        raise RuntimeError('Command failed: ' + str(argv[0]) +
                           '; exit=' + str(result.returncode) +
                           ('; sanitized log=' + str(log) if log else ''))
    return result.stdout


def clean_environment(extra=None):
    environment = {name: os.environ[name] for name in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ')
                   if name in os.environ}
    environment.update({'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1',
                        'NODE_OPTIONS': '--dns-result-order=ipv4first'})
    if extra:
        environment.update(extra)
    return environment


def read_env(root):
    values = {}
    # Next production precedence: production.local > local > production > base.
    for filename in ('.env', '.env.production', '.env.local', '.env.production.local'):
        path = Path(root) / filename
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            match = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)', line)
            if not match:
                continue
            value = match.group(2).strip()
            if value[:1] in ('\"', "'") and value[-1:] == value[:1]:
                value = value[1:-1]
            require('${' not in value, 'Unsupported interpolated environment value')
            values[match.group(1)] = value
    return values


def write_json(path, value, mode=0o600):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(mode)
    temporary.replace(path)


def state():
    require(STATE.is_file(), 'UAT preparation state is missing')
    result = json.loads(STATE.read_text())
    require(result['release'] == str(RELEASE) and result['database'] == DATABASE,
            'UAT state identity mismatch')
    return result


def save_state(value):
    write_json(STATE, value)


def active_production(identity=None):
    identity = identity or {'name': PRODUCTION_PROCESS, 'cwd': str(PRODUCTION), 'port': PRODUCTION_PORT}
    rows = json.loads(run(['pm2', 'jlist']))
    selected = [row for row in rows if row.get('name') == identity['name']]
    require(len(selected) == 1, 'Production PM2 identity is not unique')
    row = selected[0]
    environment = row['pm2_env']
    require(environment.get('status') == 'online', 'Production process is not online')
    require(Path(environment['pm_cwd']) == Path(identity['cwd']), 'Production release changed')
    require(str(environment.get('PORT')) == str(identity['port']), 'Production port changed')
    return {'name': row['name'], 'pm_id': row.get('pm_id'), 'pid': row['pid'],
            'restarts': environment.get('restart_time'), 'cwd': identity['cwd'],
            'port': identity['port'], 'status': environment['status']}


def verify_production(baseline, *, nginx=True):
    require(active_production(baseline['production']) == baseline['production'], 'Production process drifted')
    if nginx:
        require(digest(CONF.read_bytes()) == baseline['nginx_sha256'],
                'Nginx configuration drifted; no overwrite attempted')


def port_free():
    with socket.socket() as connection:
        connection.settimeout(1)
        return connection.connect_ex(('127.0.0.1', PORT)) != 0


def sql(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def psql(query, database='postgres'):
    return run(['runuser', '-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                '-d', database, '-At', '-c', query])


def database_exists():
    return psql('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=' +
                literal(DATABASE) + ');').strip() == 't'


def source_database():
    url = read_env(PRODUCTION).get('DATABASE_URL', '')
    require(bool(url), 'Production DATABASE_URL is missing')
    parsed = urllib.parse.urlsplit(url)
    require(parsed.scheme in ('postgres', 'postgresql'), 'Unexpected database provider')
    require(parsed.hostname in ('localhost', '127.0.0.1', '::1'), 'Database is not local')
    source = urllib.parse.unquote(parsed.path.lstrip('/'))
    owner = urllib.parse.unquote(parsed.username or '')
    require(bool(source) and source != DATABASE and bool(owner), 'Database identity invalid')
    require(parsed.port in (None, 5432), 'Unexpected local database port')
    require(psql('SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=' + literal(owner) +
                 ');').strip() == 't', 'Current database owner role does not exist')
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    query['schema'] = 'public'
    target = parsed._replace(path='/' + DATABASE, query=urllib.parse.urlencode(query))
    return source, owner, urllib.parse.urlunsplit(target)


def bundle_members(bundle, expected_sha):
    require(re.fullmatch(r'[a-f0-9]{64}', expected_sha) is not None, 'Invalid frozen bundle SHA')
    require(digest(Path(bundle).read_bytes()) == expected_sha, 'Frozen bundle SHA mismatch')
    archive = tarfile.open(bundle, 'r:*')
    inventory = archive.getmembers()
    require(bool(inventory) and len(inventory) < 15000, 'Unexpected bundle inventory size')
    members = []
    total = 0
    allowed_roots = {'src', 'scripts', 'tests', 'prisma', 'public', 'docs', 'frozen',
                     'package.json', 'package-lock.json', 'tsconfig.json', 'next-env.d.ts',
                     'next.config.mjs', 'vitest.config.ts', 'eslint.config.mjs', '.eslintrc.json',
                     'postcss.config.mjs', 'tailwind.config.ts', '.env.example',
                     'DEPLOY.md', 'README.md', 'uat-release-manifest.json'}
    seen = set()
    for member in inventory:
        path = PurePosixPath(member.name)
        require(not path.is_absolute() and '..' not in path.parts,
                'Unsafe tar member path')
        # macOS tar includes a harmless root directory and AppleDouble metadata.
        # Neither is an application file; skip them without altering the sealed tar.
        if not path.parts:
            require(member.isdir(), 'Unexpected root tar member')
            continue
        if any(part.startswith('._') for part in path.parts):
            continue
        member.name = path.as_posix()
        require(path.parts[0] in allowed_roots, 'Unexpected root file in frozen bundle')
        require(member.isdir() or member.isfile(), 'Frozen bundle contains links or special files')
        require(member.name not in seen, 'Duplicate tar member')
        seen.add(member.name)
        require(all(part not in {'.git', '.next', 'node_modules', 'uploads', 'data'}
                    for part in path.parts), 'Forbidden bundled application state')
        require(all(not (part.startswith('.env') and part != '.env.example')
                    for part in path.parts), 'Private environment file in bundle')
        require(path.suffix.lower() not in {'.pem', '.key', '.sqlite', '.db'},
                'Private key or database in bundle')
        total += member.size
        members.append(member)
    require(total < 512 * 1024 * 1024, 'Frozen bundle exceeds UAT source limit')
    for required in ('prisma/schema.prisma', 'package.json', 'src/lib/auth.ts',
                     'src/app/dashboards/operating-network/page.tsx'):
        require(required in seen, 'Frozen bundle missing required source: ' + required)
    return archive, members


def safe_extract(archive, members, target):
    target = Path(target)
    for member in members:
        output = target / member.name
        # Existing public assets can contain symlinks; a bundle must not follow one.
        current = output
        while current != target:
            require(not current.is_symlink(), 'Bundle would follow an existing symlink')
            current = current.parent
        if member.isdir():
            output.mkdir(parents=True, exist_ok=True)
        else:
            output.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, output.open('wb') as destination:
                shutil.copyfileobj(source, destination)
            output.chmod(0o755 if member.mode & 0o111 else 0o644)


def frozen_inventory(archive, members):
    inventory = {}
    for member in members:
        if member.isfile():
            with archive.extractfile(member) as stream:
                inventory[member.name] = {'sha256': digest(stream.read()), 'bytes': member.size}
    return inventory


def verify_frozen_source(inventory):
    for relative, expected in inventory.items():
        path = RELEASE / relative
        require(path.is_file() and not path.is_symlink(), 'Frozen source file missing: ' + relative)
        require(path.stat().st_size == expected['bytes'] and digest(path.read_bytes()) == expected['sha256'],
                'Frozen source file changed: ' + relative)
    for subtree in ('src', 'public/creative', 'public/creative-tools'):
        root = RELEASE / subtree
        actual = {path.relative_to(RELEASE).as_posix() for path in root.rglob('*') if path.is_file()}
        expected = {path for path in inventory if path.startswith(subtree + '/')}
        require(actual == expected, 'Unexpected unfrozen source files in ' + subtree)


def seed_administrator(source_db, environment):
    query = ('SELECT COALESCE(json_agg(json_build_object(' +
             "'id',id,'username',username,'password',password,'name',name,'role',role)), '[]'::json) " +
             'FROM "User" WHERE "authRole"=' + literal('admin') +
             ' AND status=' + literal('active') + ' AND username=' + literal('admin') + ';')
    administrators = json.loads(psql(query, source_db))
    require(len(administrators) == 1, 'Expected one active platform administrator')
    require(administrators[0]['password'].startswith('scrypt$'),
            'Administrator has no existing scrypt password hash; do not copy plaintext')
    seed = r'''
const { PrismaClient } = require('@prisma/client');
const client = new PrismaClient();
let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',v=>raw+=v);
process.stdin.on('end',async()=>{try{
 const users=JSON.parse(raw);
 await client.$transaction(async tx=>{
  if(await tx.user.count())throw new Error('UAT database is not empty');
  const tenant=await tx.tenant.create({data:{id:'tenant-creative-uat-20261001',name:'作图视频收口测试版',slug:'creative-uat-20261001'}});
  for(const user of users)await tx.user.create({data:{...user,tenantId:tenant.id,authRole:'admin',status:'active',email:'',shopName:''}});
 });
 console.log(JSON.stringify({adminCount:users.length,businessDataCopied:false,modelKeysCopied:false}));
}catch(error){console.error('UAT administrator seed failed');process.exitCode=1;}finally{await client.$disconnect();}});
'''
    run(['node', '-e', seed], cwd=RELEASE, env=environment,
        stdin=json.dumps(administrators), log=RELEASE / 'uat-admin-seed.log')


def retained_tools():
    page = (RELEASE / 'src/app/tools/page.tsx').read_text()
    require('version: "1.9.80"' in page, 'Retained tools metadata version changed')
    paths = ('downloads/sycm-keyword-collector-v1.9.80.zip',
             'downloads/shaozhuang-ai-v1.9.80-macos-full.zip',
             'downloads/shaozhuang-ai-legacy-icon.png')
    evidence = []
    for relative in paths:
        asset = RELEASE / 'public' / relative
        require(asset.is_file() and not asset.is_symlink(), 'Retained tool download missing: ' + relative)
        require('/' + relative in page, 'Retained download metadata is not linked: ' + relative)
        evidence.append({'path': '/' + relative, 'bytes': asset.stat().st_size})
    archive_path = RELEASE / 'public' / paths[0]
    with zipfile.ZipFile(archive_path) as archive:
        manifests = [json.loads(archive.read(name)) for name in archive.namelist()
                     if name.endswith('manifest.json') and '/node_modules/' not in name]
    require(any(row.get('version') == '1.9.80' for row in manifests),
            'Retained collector ZIP does not contain the declared manifest version')
    return {'version': '1.9.80', 'collector_sha256': digest(archive_path.read_bytes()), 'files': evidence}


def copy_missing_assets(origin, target):
    """Fill historical gaps without cp -n's implementation-dependent exit code."""
    copied = 0
    for directory, directories, files in os.walk(origin, followlinks=False):
        relative = Path(directory).relative_to(origin)
        destination = target / relative
        require(destination.is_dir() and not destination.is_symlink(), 'Unsafe supplement directory')
        for name in list(directories) + files:
            source, output = Path(directory) / name, destination / name
            if output.exists() or output.is_symlink():
                continue
            if source.is_symlink():
                # Historical download symlinks must stay within the copied tree.
                require(source.resolve().is_relative_to(origin.resolve()), 'External historical asset symlink')
                output.symlink_to(os.readlink(source))
            elif source.is_dir():
                output.mkdir(mode=source.stat().st_mode & 0o777)
            else:
                shutil.copy2(source, output)
            copied += 1
    return copied


def prepare(arguments):
    archive, members = bundle_members(arguments.bundle, arguments.sha256)
    inventory = frozen_inventory(archive, members)
    require(not database_exists(), 'UAT database already exists; no reuse or drop attempted')
    require(port_free(), 'UAT port is occupied')
    require(re.fullmatch(r'[a-f0-9]{64}', arguments.expected_nginx_sha256) is not None, 'Invalid Nginx baseline SHA')
    require(arguments.expected_nginx_sha256 == digest(CONF.read_bytes()), 'Nginx baseline SHA mismatch')
    baseline = {'production': active_production(), 'nginx_sha256': digest(CONF.read_bytes())}
    source_db, owner, database_url = source_database()
    if RELEASE.exists():
        deployment = state()
        require(deployment['phase'] == 'preparing' and not deployment.get('database_created') and
                not deployment.get('routed') and deployment['bundle_sha256'] == arguments.sha256,
                'Existing UAT is not a resumable pre-database preparation')
        verify_production(deployment)
    else:
        RELEASE.mkdir(parents=True)
        deployment = {**baseline, 'release': str(RELEASE), 'database': DATABASE,
                      'bundle_sha256': arguments.sha256, 'phase': 'preparing', 'routed': False}
    save_state(deployment)
    for name in ('public', 'private-assets', 'node_modules'):
        origin = PRODUCTION / name
        if name != 'node_modules' and not origin.is_dir():
            origin = ASSET_FALLBACK / name
        require(origin.is_dir() and not origin.is_symlink(), 'Copy source missing or symlink: ' + name)
        (RELEASE / name).mkdir(exist_ok=True)
        run(['cp', '-a', '--reflink=auto', str(origin) + '/.', str(RELEASE / name) + '/'],
            timeout=900, log=RELEASE / ('uat-copy-' + name + '.log'))
    supplements = {}
    for name in ('public', 'private-assets'):
        # Preserve current same-name assets; fill only missing historical files.
        origin = ASSET_FALLBACK / name
        if origin.is_dir() and not origin.is_symlink():
            supplements[name] = copy_missing_assets(origin, RELEASE / name)
    deployment['historical_supplement_counts'] = supplements
    # Current Cursor may have published creative files after the frozen bundle.
    # Rebuild only these test-copy directories from the sealed source inventory.
    for name in ('creative', 'creative-tools'):
        copied = RELEASE / 'public' / name
        require(not copied.is_symlink(), 'Copied creative directory is a symlink')
        if copied.exists():
            require(copied.is_dir(), 'Copied creative path is not a directory')
            shutil.rmtree(copied)
    safe_extract(archive, members, RELEASE)
    archive.close()
    verify_frozen_source(inventory)
    write_json(RELEASE / 'uat-frozen-files.json', inventory)
    deployment['frozen_manifest_sha256'] = digest((RELEASE / 'uat-frozen-files.json').read_bytes())
    deployment['frozen_file_count'] = len(inventory)
    deployment['retained_tools'] = retained_tools()
    save_state(deployment)
    auth = (RELEASE / 'src/lib/auth.ts').read_text()
    require('SANJIE_SESSION_COOKIE_NAME' in auth and 'SANJIE_ACTIVE_SHOP_COOKIE_NAME' in auth,
            'Frozen source does not isolate UAT cookies')
    require('SANJIE_TEST_ENVIRONMENT' in ''.join(
        path.read_text() for path in (RELEASE / 'src').rglob('*.tsx')),
        'Frozen source has no browser environment marker hook')
    variables = {'DATABASE_URL': database_url, 'SESSION_SECRET': secrets.token_hex(32),
                 'SHARE_ENCRYPTION_KEY': secrets.token_hex(32),
                 'AI_API_ENCRYPTION_KEY': secrets.token_hex(32),
                 'PUBLIC_APP_ORIGIN': 'https://shaozhuangai.com',
                 'TZ': 'Asia/Shanghai',
                 'SANJIE_SESSION_COOKIE_NAME': 'sanjie_session_creative_uat',
                 'SANJIE_ACTIVE_SHOP_COOKIE_NAME': 'sanjie_shop_creative_uat',
                 'SANJIE_TEST_RELEASE_LABEL': '作图视频收口测试版',
                 'SANJIE_TEST_ENVIRONMENT': ENVIRONMENT,
                 'SANJIE_TEST_EXIT_URL': EXIT,
                 'MODEL_GATEWAY_CONFIG_FILE': '/var/lib/sanjie-test/creative-20261001/relay.json',
                 'MODEL_GATEWAY_PAYMENT_PROVIDER': 'manual',
                 'MODEL_GATEWAY_MANUAL_PAY_URL': ''}
    env_file = RELEASE / '.env'
    env_file.write_text(''.join(name + '=' + json.dumps(value, ensure_ascii=False) + '\n'
                                for name, value in variables.items()))
    env_file.chmod(0o600)
    relay_directory = Path('/var/lib/sanjie-test/creative-20261001')
    require(not relay_directory.is_symlink(), 'UAT relay directory is a symlink')
    relay_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    relay_directory.chmod(0o700)
    require(not (relay_directory / 'relay.json').exists(), 'UAT relay configuration already exists')
    environment = clean_environment(variables)
    verify_production(deployment)
    psql('CREATE DATABASE ' + sql(DATABASE) + ' OWNER ' + sql(owner) + ';')
    deployment['database_created'] = True
    save_state(deployment)
    run(['node_modules/.bin/prisma', 'generate'], cwd=RELEASE, env=environment,
        timeout=180, log=RELEASE / 'uat-prisma-generate.log')
    run(['node_modules/.bin/prisma', 'db', 'push', '--skip-generate'], cwd=RELEASE,
        env=environment, timeout=180, log=RELEASE / 'uat-prisma-schema.log')
    seed_administrator(source_db, environment)
    verify_production(deployment)
    deployment['phase'] = 'prepared'
    save_state(deployment)
    print(json.dumps({'phase': 'prepared', 'release': str(RELEASE), 'port': PORT,
                      'database': DATABASE, 'adminCopied': True, 'credentialsPrinted': False}))


def check(_arguments):
    deployment = state()
    require(deployment['phase'] == 'prepared', 'UAT is not prepared')
    verify_production(deployment)
    environment = clean_environment(read_env(RELEASE))
    for name, command in [('typecheck', ['npm', 'run', 'typecheck']),
                          ('build', ['npm', 'run', 'build'])]:
        run(command, cwd=RELEASE, env=environment, timeout=1800,
            log=RELEASE / ('uat-' + name + '.log'))
    require((RELEASE / '.next/BUILD_ID').is_file(), 'UAT build output missing')
    verify_frozen_source(json.loads((RELEASE / 'uat-frozen-files.json').read_text()))
    verify_production(deployment)
    deployment.update({'phase': 'checked', 'build_id': (RELEASE / '.next/BUILD_ID').read_text().strip()})
    save_state(deployment)
    print(json.dumps({'phase': 'checked', 'build_id': deployment['build_id'],
                      'productionUnchanged': True}))


def request(url, headers=None, *, method='GET'):
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None
    opener = urllib.request.build_opener(NoRedirect())
    req = urllib.request.Request(url, headers=headers or {}, method=method)
    try:
        response = opener.open(req, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    data = response.read(4 * 1024 * 1024)
    # HTTPMessage preserves case-insensitive lookup and repeated Set-Cookie.
    return response.status, response.headers, data


def canary(_arguments):
    deployment = state()
    require(deployment['phase'] == 'checked', 'UAT checks have not completed')
    verify_production(deployment)
    require(port_free(), 'UAT port became occupied')
    rows = json.loads(run(['pm2', 'jlist']))
    require(not any(row.get('name') == PROCESS for row in rows), 'UAT PM2 name already exists')
    run(['pm2', 'start', str(RELEASE / 'node_modules/next/dist/bin/next'), '--name', PROCESS,
         '--cwd', str(RELEASE), '--', 'start', '--hostname', HOSTNAME, '--port', str(PORT)],
        env=clean_environment(read_env(RELEASE)), timeout=60, log=RELEASE / 'uat-pm2-start.log')
    deadline = time.monotonic() + 45
    while True:
        try:
            code, _headers, page = request('http://127.0.0.1:' + str(PORT) + '/login')
            if code == 200:
                break
        except Exception:
            pass
        require(time.monotonic() < deadline, 'UAT did not become ready in 45 seconds')
        time.sleep(1)
    require('自主注册'.encode() in page, 'UAT login registration flow missing')
    require(ENVIRONMENT.encode() in page, 'UAT environment marker missing')
    require(request('http://127.0.0.1:' + str(PORT) + '/api/auth/me')[0] == 401,
            'UAT anonymous authentication boundary failed')
    require(request('http://127.0.0.1:' + str(PORT) +
                    '/creative/labs/image-prompt-lab/promptlab.html')[0] in (307, 401),
            'UAT creative HTML is not protected')
    verify_uat_environment()
    verify_production(deployment)
    deployment['phase'] = 'canary'
    save_state(deployment)
    print(json.dumps({'phase': 'canary', 'boundAddress': '127.0.0.1', 'port': PORT,
                      'productionUnchanged': True}))


def verify_uat_environment():
    expected = read_env(RELEASE)
    rows = json.loads(run(['pm2', 'jlist']))
    selected = [row for row in rows if row.get('name') == PROCESS]
    require(len(selected) == 1, 'UAT PM2 identity is not unique')
    row, environment = selected[0], selected[0]['pm2_env']
    require(environment.get('status') == 'online' and Path(environment['pm_cwd']) == RELEASE,
            'UAT PM2 process identity changed')
    require(environment.get('NODE_OPTIONS') == '--dns-result-order=ipv4first',
            'UAT localhost listener does not force IPv4 DNS ordering')
    arguments = environment.get('args', [])
    require(isinstance(arguments, list) and '--hostname' in arguments and
            arguments[arguments.index('--hostname') + 1] == HOSTNAME,
            'UAT Next hostname does not match middleware canonical localhost origin')
    require(all(environment.get(name) == value for name, value in expected.items()),
            'UAT PM2 environment does not explicitly match isolated .env')
    sensitive = re.compile(r'(api.?key|access.?key|provider|database_url|session_secret|encryption_key)', re.I)
    require(not any(sensitive.search(name) and value and name not in expected
                    for name, value in environment.items()), 'Unexpected inherited provider/secret environment')
    require(urllib.parse.urlsplit(expected['DATABASE_URL']).path == '/' + DATABASE,
            'UAT environment database identity mismatch')
    production = read_env(Path(state()['production']['cwd']))
    require(all(expected.get(name) != production.get(name) for name in SECRET_NAMES),
            'UAT environment reused a production secret')
    listeners = run(['ss', '-H', '-lntp', 'sport = :' + str(PORT)]).splitlines()
    require(listeners and all(line.split()[3] == '127.0.0.1:' + str(PORT) and
                             'pid=' + str(row['pid']) + ',' in line for line in listeners),
            'UAT socket is not exclusively owned IPv4 loopback')
    return {'name': row['name'], 'pm_id': row.get('pm_id'), 'pid': row['pid'],
            'restarts': environment.get('restart_time'), 'environmentMatchesIsolatedFile': True,
            'productionSecretsReused': False, 'unexpectedProviderKeys': False,
            'nextHostname': HOSTNAME, 'listener': '127.0.0.1:' + str(PORT), 'ipv4First': True}


def login_redirect(location, base='https://shaozhuangai.com'):
    return isinstance(location, str) and urllib.parse.urljoin(base, location) == base + '/login'


def repair_runtime(_arguments):
    deployment = state()
    require(deployment['phase'] == 'verified' and deployment.get('routed'), 'UAT must already be routed')
    if digest(CONF.read_bytes()) != deployment['nginx_routed_sha256']:
        deployment = adopt_runtime_baseline(deployment)
    verify_production(deployment, nginx=False)
    require(digest(CONF.read_bytes()) == deployment['nginx_routed_sha256'], 'UAT Nginx configuration drifted')
    verify_frozen_source(json.loads((RELEASE / 'uat-frozen-files.json').read_text()))
    environment = clean_environment(read_env(RELEASE))
    address = run(['node', '-e', 'require("dns").lookup("localhost",(e,a)=>{if(e)throw e;console.log(a)})'],
                  env=environment).strip()
    require(address == '127.0.0.1', 'localhost does not resolve to IPv4 loopback before UAT restart')
    rows = json.loads(run(['pm2', 'jlist']))
    selected = [row for row in rows if row.get('name') == PROCESS]
    require(len(selected) == 1 and Path(selected[0]['pm2_env']['pm_cwd']) == RELEASE,
            'UAT process identity changed before restart')
    run(['pm2', 'delete', PROCESS], log=RELEASE / 'uat-runtime-repair-delete.log')
    run(['pm2', 'start', str(RELEASE / 'node_modules/next/dist/bin/next'), '--name', PROCESS,
         '--cwd', str(RELEASE), '--', 'start', '--hostname', HOSTNAME, '--port', str(PORT)],
        env=environment, log=RELEASE / 'uat-runtime-repair-start.log')
    deadline = time.monotonic() + 45
    while True:
        try:
            code, _headers, page = request('http://127.0.0.1:' + str(PORT) + '/login')
            if code == 200 and ENVIRONMENT.encode() in page:
                break
        except Exception:
            pass
        require(time.monotonic() < deadline, 'Repaired UAT did not become ready in 45 seconds')
        time.sleep(1)
    deployment['uat_process'] = verify_uat_environment()
    verify_production(deployment, nginx=False)
    require(digest(CONF.read_bytes()) == deployment['nginx_routed_sha256'], 'UAT Nginx drifted during restart')
    save_state(deployment)
    print(json.dumps({'phase': 'runtime-repaired', 'uat': deployment['uat_process'],
                      'frozenSourceUnchanged': True, 'productionUnchanged': True}))


def adopt_runtime_baseline(deployment):
    """Accept a concurrent formal update only when our isolation rules are exact."""
    observed = CONF.read_bytes()
    current = observed.decode()
    match = re.search(r'map \$cookie_sanjie_creative_uat \$sanjie_app_port\s*\{\s*default (\d+);', current)
    require(match is not None, 'UAT route map disappeared during concurrent deployment')
    formal_port = int(match.group(1))
    require(formal_port != PORT, 'UAT became the default upstream')
    original = Path(deployment['nginx_backup']).read_bytes()
    require(digest(original) == deployment['nginx_sha256'], 'Historical Nginx backup changed')
    expected, _count = routing_configuration(original.decode())
    normalize = lambda value: re.sub(r'\s+', '', value)
    maps = lambda text: [normalize(block) for block in re.findall(r'map[^{}]+\{[^{}]+\}', text)]
    expected_maps = maps(expected.replace('default ' + str(PRODUCTION_PORT) + ';',
                                         'default ' + str(formal_port) + ';', 1))
    require(maps(current) == expected_maps, 'Concurrent deployment changed UAT isolation maps')
    for path in (ENTRY, EXIT):
        def block(text):
            marker = re.search(r'location\s*=\s*' + re.escape(path) + r'\s*\{', text)
            require(marker is not None, 'UAT entry/exit location disappeared')
            opening = text.index('{', marker.start())
            return text[marker.start():matching_brace(text, opening) + 1]
        require(normalize(block(current)) == normalize(block(expected)), 'UAT entry/exit protection changed')
    for directive in ('if ($sanjie_uat_block) { return 409; }',
                      'proxy_cache_bypass $sanjie_uat_no_cache;', 'proxy_no_cache $sanjie_uat_no_cache;'):
        require(normalize(directive) in normalize(current), 'UAT global protection disappeared')
    require(current.count('proxy_pass http://127.0.0.1:$sanjie_app_port;') >= _count,
            'Concurrent deployment removed routed application proxies')
    rows = json.loads(run(['pm2', 'jlist']))
    selected = [row for row in rows if str(row.get('pm2_env', {}).get('PORT')) == str(formal_port)]
    require(len(selected) == 1, 'Current default upstream has no unique PM2 identity')
    row = selected[0]
    identity = {'name': row['name'], 'cwd': row['pm2_env']['pm_cwd'], 'port': formal_port}
    require(identity['name'] != PROCESS and Path(identity['cwd']).is_relative_to('/opt/sanjie-releases'),
            'Current formal release identity is outside production releases')
    production = active_production(identity)
    require(CONF.read_bytes() == observed, 'Nginx drifted while adopting current formal baseline')
    deployment.setdefault('initial_production', deployment['production'])
    deployment.setdefault('runtime_adoptions', []).append({
        'priorProduction': deployment['production'], 'priorRoutedNginxSha256': deployment['nginx_routed_sha256'],
        'currentProduction': production, 'currentNginxSha256': digest(observed),
        'readTimeUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'nginxWritten': False})
    deployment.update({'production': production, 'nginx_routed_sha256': digest(observed),
                       'rollback_requires_fresh_review': True})
    save_state(deployment)
    return deployment


def matching_brace(text, opening):
    depth, quote, escaped, comment = 0, None, False, False
    for index in range(opening, len(text)):
        char = text[index]
        if comment:
            if char == '\n':
                comment = False
            continue
        if quote:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char == '#':
            comment = True
        elif char in ('\"', "'"):
            quote = char
        elif char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return index
    raise RuntimeError('Unbalanced Nginx configuration')


def direct_add_headers(block):
    """Read only direct server/http add_header statements, not location overrides."""
    result, cursor = [], block.index('{') + 1
    end = matching_brace(block, cursor - 1)
    while cursor < end:
        if block[cursor].isspace():
            cursor += 1
            continue
        if block[cursor] == '#':
            newline = block.find('\n', cursor)
            cursor = end if newline < 0 else newline + 1
            continue
        start, quote, escaped = cursor, None, False
        while cursor < end:
            char = block[cursor]
            if quote:
                if escaped:
                    escaped = False
                elif char == '\\':
                    escaped = True
                elif char == quote:
                    quote = None
            elif char in ('\"', "'"):
                quote = char
            elif char == '{':
                cursor = matching_brace(block, cursor) + 1
                break
            elif char == ';':
                directive = block[start:cursor + 1].strip()
                if directive.startswith('add_header '):
                    result.append(directive)
                cursor += 1
                break
            cursor += 1
    return result


def routing_configuration(original, inherited_headers=()):
    require(MARKER not in original and '$sanjie_app_port' not in original,
            'UAT routing already exists')
    require('proxy_redirect default;' not in original,
            'Variable proxy_pass requires reviewing explicit proxy_redirect default')
    maps = MARKER + '''
map $cookie_sanjie_creative_uat $sanjie_app_port {
    default PRODUCTION_PORT;
    "20261001" 32011;
}
map "$cookie_sanjie_creative_uat:$http_x_sanjie_environment" $sanjie_uat_mismatch {
    default 0;
    "20261001:creative-20261001" 0;
    ~:creative-20261001$ 1;
}
map "$uri:$sanjie_uat_mismatch" $sanjie_uat_block {
    default 0;
    "/uat/creative-20261001:1" 0;
    "/uat/creative-exit:1" 0;
    ~:1$ 1;
}
map $sanjie_app_port $sanjie_uat_no_cache {
    default 0;
    32011 1;
}
'''.replace('default PRODUCTION_PORT;', 'default ' + str(PRODUCTION_PORT) + ';')
    blocks, count = [], 0
    for match in re.finditer(r'(?m)^\s*server\s*\{', original):
        opening = original.index('{', match.start())
        closing = matching_brace(original, opening)
        block = original[match.start():closing + 1]
        proxy_pattern = r'proxy_pass\s+http://127[.]0[.]0[.]1:' + str(PRODUCTION_PORT) + r'\s*;'
        if not re.search(proxy_pattern, block):
            continue
        require(re.search(r'\bserver_name\b[^;]*\b(?:www[.])?shaozhuangai[.]com\b', block),
                'Unexpected server contains production upstream')
        require(ENTRY not in block and EXIT not in block, 'UAT entry/exit location already exists')
        direct_headers = direct_add_headers(block)
        headers = direct_headers or list(inherited_headers)
        safe_headers = '\n'.join('        ' + header for header in headers)
        entry = '''
    # Route selection has no authentication authority; UAT keeps its own signed session.
    if ($sanjie_uat_block) { return 409; }
    proxy_cache_bypass $sanjie_uat_no_cache;
    proxy_no_cache $sanjie_uat_no_cache;
    location = /uat/creative-20261001 {
%s
        add_header Cache-Control "private, no-store" always;
        add_header Set-Cookie "sanjie_creative_uat=20261001; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400" always;
        return 302 /login;
    }
    location = /uat/creative-exit {
%s
        add_header Cache-Control "private, no-store" always;
        add_header Set-Cookie "sanjie_creative_uat=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0" always;
        add_header Set-Cookie "sanjie_session_creative_uat=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0" always;
        add_header Set-Cookie "sanjie_session_creative_uat=; Domain=.shaozhuangai.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0" always;
        add_header Set-Cookie "sanjie_shop_creative_uat=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0" always;
        add_header Set-Cookie "sanjie_shop_creative_uat=; Domain=.shaozhuangai.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0" always;
        return 302 /login;
    }
''' % (safe_headers, safe_headers)
        replacement, replacements = re.subn(proxy_pattern,
            'proxy_pass http://127.0.0.1:$sanjie_app_port;', block)
        count += replacements
        replacement = replacement[:-1] + entry + '\n}'
        blocks.append((match.start(), closing + 1, replacement))
    require(blocks and count == len(re.findall(proxy_pattern, original)),
            'Production proxy locations were not completely identified')
    result = original
    for begin, end, replacement in reversed(blocks):
        result = result[:begin] + replacement + result[end:]
    return maps + '\n' + result, count


def atomic_config(data):
    with tempfile.NamedTemporaryFile(dir=CONF.parent, prefix='.creative-uat-', delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(data)
    temporary.chmod(CONF.stat().st_mode & 0o777)
    temporary.replace(CONF)


def route(_arguments):
    deployment = state()
    require(deployment['phase'] in ('canary', 'rolled-back') and not deployment.get('routed'),
            'UAT canary has not passed or routing is already enabled')
    verify_production(deployment)
    deployment['uat_process'] = verify_uat_environment()
    original = CONF.read_bytes()
    parent_headers = []
    main = Path('/etc/nginx/nginx.conf').read_text()
    match = re.search(r'\bhttp\s*\{', main)
    if match:
        opening = main.index('{', match.start())
        parent_headers = direct_add_headers(main[match.start():matching_brace(main, opening) + 1])
    candidate, count = routing_configuration(original.decode(), parent_headers)
    backup = CONF.with_name(CONF.name + '.pre-creative-uat-20261001-' + str(int(time.time())))
    require(not backup.exists(), 'Nginx backup collision')
    shutil.copy2(CONF, backup)
    deployment.update({'nginx_backup': str(backup), 'nginx_routed_sha256': digest(candidate.encode()),
                       'nginx_replacements': count, 'phase': 'routing'})
    save_state(deployment)
    # Compare immediately before the atomic replace; never overwrite another deployment.
    require(digest(CONF.read_bytes()) == deployment['nginx_sha256'], 'Nginx changed during preparation')
    atomic_config(candidate.encode())
    try:
        run(['nginx', '-t'], log=RELEASE / 'uat-nginx-check.log')
        run(['systemctl', 'reload', 'nginx'])
    except Exception:
        require(digest(CONF.read_bytes()) == deployment['nginx_routed_sha256'],
                'Nginx drifted after UAT write; automatic restore was not safe')
        atomic_config(original)
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
        deployment['phase'] = 'canary'
        save_state(deployment)
        raise
    deployment.update({'phase': 'routed', 'routed': True})
    save_state(deployment)
    try:
        verify(_arguments)
    except Exception:
        # Public boundary failure closes the UAT route immediately. The rollback
        # has its own SHA guard and will never overwrite a concurrent edit.
        rollback(_arguments)
        raise


def verify(_arguments):
    deployment = state()
    require(deployment.get('routed'), 'UAT routing not enabled')
    require(digest(CONF.read_bytes()) == deployment['nginx_routed_sha256'], 'UAT Nginx configuration drifted')
    verify_production(deployment, nginx=False)
    base = 'https://shaozhuangai.com'
    results = []
    cases = [('default', '/login', {}, 200),
             ('uat', '/login', {'Cookie': ROUTE_COOKIE + '=20261001'}, 200),
             ('stale-uat-api', '/api/auth/me', {'X-Sanjie-Environment': ENVIRONMENT}, 409),
             ('wrong-cookie-api', '/api/auth/me', {'Cookie': ROUTE_COOKIE + '=wrong',
                                                 'X-Sanjie-Environment': ENVIRONMENT}, 409),
             ('stale-uat-next', '/_next/does-not-exist', {'X-Sanjie-Environment': ENVIRONMENT}, 409),
             ('matching-api', '/api/auth/me', {'Cookie': ROUTE_COOKIE + '=20261001',
                                             'X-Sanjie-Environment': ENVIRONMENT}, 401),
             ('default-auth', '/api/auth/me', {}, 401),
             ('uat-entry', ENTRY, {}, 302), ('uat-exit', EXIT, {}, 302)]
    for name, path, headers, expected in cases:
        code, response_headers, page = request(base + path, {**headers, 'Cache-Control': 'no-cache'})
        require(code == expected, 'Public UAT check failed: ' + name)
        if name == 'default':
            require('作图视频收口测试版'.encode() not in page and ENVIRONMENT.encode() not in page,
                    'Default traffic reached UAT')
        if name == 'uat':
            require('自主注册'.encode() in page and ENVIRONMENT.encode() in page,
                    'Routed traffic did not reach frozen UAT build')
        if name in ('uat-entry', 'uat-exit'):
            require(login_redirect(response_headers.get('Location')), 'Entry/exit redirect changed')
            cookies = response_headers.get_all('Set-Cookie', [])
            route_cookies = [cookie for cookie in cookies if cookie.startswith(ROUTE_COOKIE + '=')]
            require(len(route_cookies) == 1, 'Route cookie header is missing or duplicated')
            route_cookie = route_cookies[0]
            require(all(flag in route_cookie for flag in ('Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax')),
                    'Route cookie protection attributes changed')
            require('Domain=' not in route_cookie, 'Route cookie is not host-only')
            expected_age = 'Max-Age=86400' if name == 'uat-entry' else 'Max-Age=0'
            require(expected_age in route_cookie, 'Route cookie lifetime changed')
            if name == 'uat-exit':
                require(not any(cookie.startswith(('sanjie_session=', 'sanjie_active_shop='))
                                for cookie in cookies), 'Exit attempted to remove formal cookies')
        results.append({'name': name, 'http': code, 'passed': True})
    for asset in deployment['retained_tools']['files']:
        code, response_headers, _page = request(base + asset['path'],
            {'Cookie': ROUTE_COOKIE + '=20261001', 'X-Sanjie-Environment': ENVIRONMENT}, method='HEAD')
        require(code == 200, 'Retained UAT tool download URL failed')
        require(int(response_headers.get('Content-Length', '0')) == asset['bytes'],
                'Retained UAT tool download size changed')
        results.append({'name': 'retained-tool-' + asset['path'].rsplit('/', 1)[-1],
                        'http': code, 'bytes': asset['bytes'], 'passed': True})
    deployment.update({'phase': 'verified', 'public_checks': results})
    save_state(deployment)
    print(json.dumps({'phase': 'verified', 'entry': base + ENTRY, 'exit': base + EXIT,
                      'defaultProductionPreserved': True, 'checks': results}, ensure_ascii=False))


def rollback(_arguments):
    deployment = state()
    require(not deployment.get('rollback_requires_fresh_review'),
            'Concurrent formal update requires a fresh reviewed rollback; historical backup will not be applied')
    require(deployment.get('nginx_backup'), 'No UAT routing backup exists')
    before = CONF.read_bytes()
    require(digest(before) == deployment['nginx_routed_sha256'],
            'Nginx changed after UAT; rollback will not overwrite it')
    backup = Path(deployment['nginx_backup']).read_bytes()
    require(digest(backup) == deployment['nginx_sha256'], 'Nginx backup SHA mismatch')
    require(digest(CONF.read_bytes()) == deployment['nginx_routed_sha256'],
            'Nginx changed while reading the backup; no rollback overwrite attempted')
    atomic_config(backup)
    try:
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
    except Exception:
        require(digest(CONF.read_bytes()) == deployment['nginx_sha256'],
                'Nginx drifted during rollback validation; routed restore was not safe')
        atomic_config(before)
        raise
    deployment.update({'phase': 'rolled-back', 'routed': False})
    save_state(deployment)
    verify_production(deployment)
    print(json.dumps({'phase': 'rolled-back', 'productionUnchanged': True,
                      'testProcessAndDatabaseRetained': True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'check', 'canary', 'route', 'verify', 'rollback', 'status',
                                         'repair-runtime'])
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--sha256')
    parser.add_argument('--expected-nginx-sha256')
    arguments = parser.parse_args()
    if arguments.phase == 'prepare':
        require(arguments.bundle and arguments.sha256 and arguments.expected_nginx_sha256,
                'Prepare requires the root-frozen bundle, SHA and fresh Nginx baseline SHA')
    if arguments.phase == 'status':
        print(json.dumps(state(), ensure_ascii=False))
    else:
        globals()[arguments.phase.replace('-', '_')](arguments)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(scrub(error), file=sys.stderr)
        sys.exit(1)
