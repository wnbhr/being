import urllib.request
import json

SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2anJtZGZjamVkeWp2a2lpdWxhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDQ5ODg5MSwiZXhwIjoyMDkwMDc0ODkxfQ.PtMSXCX5HzRwoTtLkWMCE2N6OLqtxRXje1PCoJXyk9U"
BASE = "https://evjrmdfcjedyjvkiiula.supabase.co/rest/v1"

def fetch(path):
    req = urllib.request.Request(BASE + path, headers={
        "apikey": SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}"
    })
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read())

print("=== souls ===")
rows = fetch("/souls?select=id,user_id,partner_type,name,created_at")
print(f"件数: {len(rows)}")
for r in rows:
    print(json.dumps(r, ensure_ascii=False))
