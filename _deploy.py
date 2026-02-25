import subprocess, os
os.chdir(r"c:\Users\root\OneDrive\Desktop\통합접속")
subprocess.run(["git", "add", "-A"], check=True)
subprocess.run(["git", "commit", "-m", "feat: open Google on new tab, add tab divider between static and dynamic tabs"], check=True)
subprocess.run(["git", "push"], check=True)
print("Done!")
