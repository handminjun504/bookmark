import subprocess, os, sys
sys.stdout.reconfigure(encoding='utf-8')

target = os.path.dirname(os.path.abspath(__file__))
print(f"Working in: {target}")

env = os.environ.copy()
env['GIT_AUTHOR_NAME'] = 'admin'
env['GIT_COMMITTER_NAME'] = 'admin'
env['GIT_AUTHOR_EMAIL'] = 'admin@local'
env['GIT_COMMITTER_EMAIL'] = 'admin@local'

args = sys.argv[1:]
r = subprocess.run(['git'] + args, cwd=target, capture_output=True, text=True, encoding='utf-8', env=env)
if r.stdout: print(r.stdout.strip())
if r.stderr: print(r.stderr.strip())
sys.exit(r.returncode)
