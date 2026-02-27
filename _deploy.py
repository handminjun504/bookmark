import subprocess, os
os.chdir(r"c:\Users\root\OneDrive\Desktop\통합접속")
subprocess.run(["git", "add", "-A"], check=True)
subprocess.run(["git", "commit", "-m", "feat: add team/client management system with encrypted credentials"], check=True)
subprocess.run(["git", "push"], check=True)
print("Done!")
