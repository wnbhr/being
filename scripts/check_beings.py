import urllib.request
import json

SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2anJtZGZjamVkeWp2a2lpdWxhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDQ5ODg5MSwiZXhwIjoyMDkwMDc0ODkxfQ.PtMSXCX5HzRwoTtLkWMCE2N6OLqtxRXje1PCoJXyk9U"

url = "https://evjrmdfcjedyjvkiiula.supabase.co/rest/v1/beings?select=*"
req = urllib.request.Request(url, headers={
    "apikey": SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SERVICE_ROLE_KEY}"
})
with urllib.request.urlopen(req) as res:
    data = json.loads(res.read())
    print(f"件数: {len(data)}")
    for row in data:
        print(json.dumps(row, ensure_ae, indent=2))
