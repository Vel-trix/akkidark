import os
import internetarchive

# === Internet Archive API Keys ===
ACCESS_KEY = "cCYXD3V4ke4YkXLI"
SECRET_KEY = "qZHSAtgw5TJXkpZa"
IDENTIFIER = "akkidark"

# Setup credentials
internetarchive.config.access_key = ACCESS_KEY
internetarchive.config.secret_key = SECRET_KEY

# Scan for .webm files
files = [f for f in os.listdir('.') if f.endswith('.webm')]

if not files:
    print("⚠️ No .webm files found in the current directory.")
    exit()

print(f"☁️ Uploading {len(files)} .webm audio files to Internet Archive (ID: {IDENTIFIER})...")

# Upload all files to the single identifier
response = internetarchive.upload(
    identifier=IDENTIFIER,
    files=files,
    metadata={
        "title": "Akkidark Audio Collection",
        "mediatype": "audio",
        "collection": "opensource_audio",
        "creator": "YouTube Clone - ShradhaKD"
    },
    verbose=True
)

# Check results
for result in response:
    if result.status_code == 200:
        print(f"✅ Uploaded: {result.name}")
    else:
        print(f"❌ Failed: {result.name} ({result.status_code}) — {result.text}")
