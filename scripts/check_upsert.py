import urllib.request
import json

SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2anJtZGZjamVkeWp2a2lpdWxhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDQ5ODg5MSwiZXhwIjoyMDkwMDc0ODkxfQ.PtMSXCX5HzRwoTtLkWMCE2N6OLqtxRXje1PCoJXyk9U'
BASE = 'https://evjrmdfcjedyjvkiiula.supabase.co/rest/v1'
USER_ID = '037dc928-327d-4a9f-8023-2c965cedc424'

payload = json.dumps({
    'user_id': USER_ID,
    'title': '__test_385__',
    'description': 'test',
    'updated_at': '2026-04-08T00:00:00Z'
}).encode()

url = BASE + '/knowledge?on_conflict=user_id%2Ctitle'
headers = {
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates,return=representation',
}

print('=== service_role upsert ===')
req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
try:
    with urllib.request.urlopen(req) as res:
        print('OK: ' + res.read().decode())
except urllib.error.HTTPError as e:
    print('ERR ' + str(e.code) + ': ' + e.read().decode())

print('\n=== cleanup ===')
del_url = BASE + '/knowledge?user_id=eq.' + USER_ID + '&title=eq.__test_385__'
del_req = urllib.request.Request(del_url, headers={
    'apikey': SERVICE_KEY,
    'Authorization': 'Bearer ' + SERVICE_KEY,
}, method='DELETE')
try:
    with urllib.request.urlopen(del_req) as res:
       rint('deleted: ' + str(res.status))
except urllib.error.HTTPError as e:
    print('del ERR: ' + str(e.code))
