import subprocess, os, sys

sys.stdout.reconfigure(encoding='utf-8')
desktop = r'C:\Users\root\OneDrive\Desktop'

target = None
for d in os.listdir(desktop):
    full = os.path.join(desktop, d)
    if os.path.isfile(os.path.join(full, 'setup_git.py')):
        target = full
        break

if not target:
    print("ERROR: folder not found")
    sys.exit(1)

print(f"Working in: {target}")

def run(cmd):
    r = subprocess.run(cmd, cwd=target, capture_output=True, text=True, encoding='utf-8')
    if r.stdout: print(r.stdout.strip())
    if r.stderr: print(r.stderr.strip())
    return r.returncode

run(['git', 'init'])
run(['git', 'add', '-A'])
run(['git', 'status', '--short'])

env = os.environ.copy()
env['GIT_AUTHOR_NAME'] = 'admin'
env['GIT_COMMITTER_NAME'] = 'admin'
env['GIT_AUTHOR_EMAIL'] = 'admin@local'
env['GIT_COMMITTER_EMAIL'] = 'admin@local'

r = subprocess.run(
    ['git', 'commit', '-m', 'feat: 통합접속 대시보드 초기 구축'],
    cwd=target, capture_output=True, text=True, encoding='utf-8', env=env
)
if r.stdout: print(r.stdout.strip())
if r.stderr: print(r.stderr.strip())

run(['git', 'log', '--oneline'])
