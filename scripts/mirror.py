import os, json, time, websocket
from hyperliquid.info import Info
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants

TESTNET = os.getenv('HL_TESTNET', '1') == '1'
BASE = constants.TESTNET_API_URL if TESTNET else constants.MAINNET_API_URL
AGENT_KEY = os.getenv('HL_AGENT_KEY')
ACCOUNT = os.getenv('HL_ACCOUNT')
SCALE = float(os.getenv('HL_SIZE_SCALE', '0.01'))
TRACK = [a.strip() for a in os.getenv('HL_TRACK', '').split(',') if a.strip()]

if not AGENT_KEY or not ACCOUNT:
    print('Missing HL_AGENT_KEY or HL_ACCOUNT'); raise SystemExit(1)

from eth_account import Account
account = Account.from_key(AGENT_KEY)
exchange = Exchange(account, BASE, account_address=ACCOUNT)
info = Info(BASE)

print('Mirror starting. testnet=', TESTNET, 'track=', TRACK, 'scale=', SCALE)

def on_message(ws, msg):
    try:
        data = json.loads(msg)
    except Exception:
        return
    if data.get('channel') != 'userFills':
        return
    fills = data.get('data', {}).get('fills', []) if isinstance(data.get('data'), dict) else data.get('data', [])
    # normalize
    if isinstance(data.get('data'), dict):
        fills = data['data'].get('fills', [])
    elif isinstance(data.get('data'), list):
        fills = data['data']
    for f in fills:
        coin = f.get('coin')
        side = f.get('side')  # B/A
        sz = float(f.get('sz', 0)) * SCALE
        is_buy = side == 'B'
        # only mirror opens
        d = (f.get('dir') or '').lower()
        if 'open' not in d:
            print('skip non-open', coin, d); continue
        if sz <= 0:
            continue
        mid = float(info.all_mids().get(coin, 0)) or 0
        px = float(f.get('px', 0))
        # risk checks
        try:
            st = info.clearinghouse_state(ACCOUNT)
            av = float(st.get('marginSummary', {}).get('accountValue', 0)) if isinstance(st, dict) else 0
        except Exception:
            av = 0
        max_pos = av * float(os.getenv('HL_MAX_POSITION_PCT', '0.05')) if av > 0 else float('inf')
        if av > 0 and (sz * (mid if mid else px)) > max_pos:
            print('risk: position too large, skip', coin, sz); continue
        try:
            res = exchange.market_open(coin, is_buy, sz, mid if mid else None, 0.02)
            print('mirrored', coin, 'buy' if is_buy else 'sell', sz, res)
        except Exception as e:
            print('mirror error', coin, e)

def on_open(ws):
    for a in TRACK:
        ws.send(json.dumps({'method':'subscribe','subscription':{'type':'userFills','user':a}}))
    print('subscribed')

ws = websocket.WebSocketApp('wss://' + ('api.hyperliquid-testnet.xyz' if TESTNET else 'api.hyperliquid.xyz') + '/ws',
                            on_open=on_open, on_message=on_message)
ws.run_forever()
