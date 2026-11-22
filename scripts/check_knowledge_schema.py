import urllib.request
import json

SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2anJtZGZjamVkeWp2a2lpdWxhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDQ5ODg5MSwiZXhwIjoyMDkwMDc0ODkxfQ.PtMSXCX5HzRwoTtLkWMCE2N6OLqtxRXje1PCoJXyk9U'
BASE = 'https://evjrmdfcjedyjvkiiula.supabase.co'

# Supabase OpenAPI でテーブルのカラムを確認
print('=== OpenAPI から knowledge カラム確認 ===')
req = urllib.request.Request(BASE + '/rest/v1/', headers={
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
})
try:
    with urllib.request.urlopen(req) as res:
        data = json.loads(res.read().decode())
        defs = data.get('definitions', {})
        if 'knowledge' in defs:
            cols = list(defs['knowledge'].get('properties', {}).keys())
            print('knowledge columns:', cols)
        else:
            print('knowledge not in definitions. available:', list(defs.keys())[:30])
except urllib.error.HTTPError as e:
    print('ERR ' + str(e.code) + ': ' + e.read().decode()[:300])
