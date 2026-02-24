import subprocess, os, sys
sys.stdout.reconfigure(encoding='utf-8')
target = os.path.dirname(os.path.abspath(__file__))
env = os.environ.copy()
env.update({'GIT_AUTHOR_NAME':'admin','GIT_COMMITTER_NAME':'admin','GIT_AUTHOR_EMAIL':'admin@local','GIT_COMMITTER_EMAIL':'admin@local'})

def run(args):
    r = subprocess.run(['git']+args, cwd=target, capture_output=True, text=True, encoding='utf-8', errors='replace', env=env)
    if r.stdout: print(r.stdout.strip())
    if r.stderr and 'warning' not in r.stderr.lower(): print(r.stderr.strip())

run(['add', '-A'])
run(['status', '--short'])
run(['commit', '-m', 'chore: cleanup temp scripts'])
run(['log', '--oneline'])
print('\nFiles in repo:')
run(['ls-files'])

# Self-delete
os.remove(os.path.abspath(__file__))
print('\nSelf-deleted _final.py')
