import urllib.request
import json

SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV2anJtZGZjamVkeWp2a2lpdWxhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDQ5ODg5MSwiZXhwIjoyMDkwMDc0ODkxfQ.PtMSXCX5HzRwoTtLkWMCE2N6OLqtxRXje1PCoJXyk9U'
BASE = 'https://evjrmdfcjedyjvkiiula.supabase.co/rest/v1'
HEADERS = {
    'apikey': SERVICE_KEY,
    'Authorization': f'Bearer {SERVICE_KEY}',
}

def check(table):
    url = f'{BASE}/{table}?select=*&limit=1'
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req) as res:
            data = json.loads(res.read().decode())
            print(f'[OK] {table}: {data}')
    except urllib.error.HTTPError as e:
        print(f'[ERR] {table}: {e.code} {e.read().decode()}')

check('knowledge')
check('partner_map')
