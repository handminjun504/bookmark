import subprocess
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

target = os.path.dirname(os.path.abspath(__file__))
print(f"Target: {target}")
print(f"Contents: {os.listdir(target)}")

r = subprocess.run(['git', 'init'], cwd=target, capture_output=True, text=True)
print(f"git init: {r.stdout.strip()} {r.stderr.strip()}")

r = subprocess.run(['git', 'add', '.'], cwd=target, capture_output=True, text=True)
print(f"git add: {r.stdout.strip()} {r.stderr.strip()}")

r = subprocess.run(['git', 'status', '--short'], cwd=target, capture_output=True, text=True)
print(f"Status:\n{r.stdout}")

r = subprocess.run(
    ['git', 'commit', '-m', 'Initial commit: 통합접속 대시보드'],
    cwd=target, capture_output=True, text=True,
    env={**os.environ, 'GIT_AUTHOR_NAME': 'admin', 'GIT_COMMITTER_NAME': 'admin',
         'GIT_AUTHOR_EMAIL': 'admin@local', 'GIT_COMMITTER_EMAIL': 'admin@local'}
)
print(f"git commit: {r.stdout.strip()} {r.stderr.strip()}")
