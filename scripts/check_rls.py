import urllib.request
import json

SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2anJtZGZjamVkeWp2a2lpdWxhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDQ5ODg5MSwiZXhwIjoyMDkwMDc0ODkxfQ.PtMSXCX5HzRwoTtLkWMCE2N6OLqtxRXje1PCoJXyk9U'
BASE = 'https://evjrmdfcjedyjvkiiula.supabase.co/rest/v1'

headers = {
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
}

# service_role で upsert テスト
print('=== service_role で upsert テスト ===')
url = BASE + '/knowledge'
payload = json.dumps({
    'user_id': '037dc928-327d-4a9f-8023-2c965cedc424',
    'partner_type': 'liz',
    'title': '__test_385__',
    'description': 'test'
}).encode()
req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
try:
    with urllib.request.urlopen(req) as res:
        print('OK status=' + str(res.status))
except urllib.error.HTTPError as e:
    body = e.read().decode()
    print('ERR ' + str(e.code) + ': ' + body)

# GET でカラム確認
print('\n=== knowledge カラム確認（limit=1）===')
get_headers = {
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
}
req2 = urllib.request.Request(BASE + '/knowledge?limit=1', headers=get_headers)
try:
    with urllib.request.urlopen(req2) as res:
        print('OK: ' + res.read().decode())
except urllib.error.HTTPError as e:
    print('ERR ' + str(e.code) + ': ' + e.read().decode())
