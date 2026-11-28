import hashlib
import json
import os
import sqlite3
import time
from decimal import Decimal, ROUND_DOWN
from pathlib import Path

import websocket
from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants
from hyperliquid.utils.types import Cloid

D = Decimal


class Mirror:
    def __init__(self, exchange, account, scale, cap, db):
        self.exchange = exchange
        self.account = account
        self.scale = scale
        self.cap = cap
        self.db = db
        self.started = int(time.time() * 1000)
        self.steps = {a['name']: D(1).scaleb(-a['szDecimals'])
                      for a in exchange.info.meta()['universe'] if not a.get('isDelisted')}
        db.execute("""CREATE TABLE IF NOT EXISTS orders
            (leader TEXT, coin TEXT, tid TEXT, leg TEXT, delta TEXT,
             PRIMARY KEY (leader, coin, tid, leg))""")
        db.execute('CREATE INDEX IF NOT EXISTS by_coin ON orders(coin, leader)')

    def skip(self, key, reason):
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO orders VALUES (?,?,?,?,?)', (*key, '0'))
        print('Skipped', *key, reason, flush=True)

    def order(self, user, f, leg, size, source_before):
        coin, tid = f['coin'], str(f['tid'])
        key = (user, coin, tid, leg)
        if self.db.execute('SELECT 1 FROM orders WHERE leader=? AND coin=? AND tid=? AND leg=?', key).fetchone():
            return
        if self.db.execute('SELECT 1 FROM orders WHERE coin=? AND delta IS NULL', (coin,)).fetchone():
            self.skip(key, 'earlier order unconfirmed')
            return
        buy = f['side'] == 'B'
        sign = 1 if buy else -1
        info = self.exchange.info
        state = info.user_state(self.account)
        actual = next((D(p['position']['szi']) for p in state['assetPositions']
                       if p['position']['coin'] == coin), D(0))
        mid = D(info.all_mids()[coin])
        if mid <= 0:
            return
        if leg == 'close':
            held = sum((D(row[0]) for row in self.db.execute(
                'SELECT delta FROM orders WHERE leader=? AND coin=? AND delta IS NOT NULL', (user, coin))), D(0))
            if held * sign >= 0 or actual * sign >= 0:
                self.skip(key, 'no matching copied position')
                return
            size = min(abs(held) * size / abs(source_before), abs(actual), abs(held))
        else:
            if actual * sign < 0:
                self.skip(key, 'opposing destination position')
                return
            equity = D(state['marginSummary']['accountValue'])
            size = min(size * self.scale, equity * self.cap / (mid * D('1.02')) - abs(actual))
        size = size.quantize(self.steps[coin], rounding=ROUND_DOWN)
        if size <= 0:
            self.skip(key, 'size below step or position cap')
            return
        if leg == 'open' and size * mid < 10:
            self.skip(key, 'scaled opening order below $10')
            return
        if leg == 'open':
            source_price = D(f['px'])
            if not source_price.is_finite() or source_price <= 0:
                return
            # Bound adverse slippage against both the signal price and the current mid.
            reference = min(mid, source_price) if buy else max(mid, source_price)
        # Persist the intent before submission. An ambiguous response must never replay it.
        with self.db:
            self.db.execute('INSERT INTO orders VALUES (?,?,?,?,NULL)', key)
        order_id = hashlib.blake2b('|'.join((self.account, *key)).encode(), digest_size=16).hexdigest()
        cloid = Cloid.from_str('0x' + order_id)
        print('Submitting', user, coin, tid, leg, cloid, flush=True)
        if leg == 'close':
            # Pin the side and request reduce-only even if the account changes in flight.
            price = self.exchange._slippage_price(coin, buy, 0.02, float(mid))
            result = self.exchange.order(coin, buy, float(size), price, {'limit': {'tif': 'Ioc'}}, reduce_only=True, cloid=cloid)
        else:
            result = self.exchange.market_open(coin, buy, float(size), float(reference), 0.02, cloid=cloid)
        if result.get('status') == 'err':
            outcome = {'error': result.get('response')}
        else:
            outcome = result['response']['data']['statuses'][0]
        if 'error' in outcome:
            filled = D(0)
            print('Rejected', coin, outcome['error'], flush=True)
        else:
            filled = D(outcome['filled']['totalSz'])
        with self.db:
            self.db.execute('UPDATE orders SET delta=? WHERE leader=? AND coin=? AND tid=? AND leg=?',
                            (str(sign * filled), *key))
        if filled:
            print('Filled', user, coin, leg, filled, flush=True)

    def fill(self, user, f):
        coin = f.get('coin')
        if coin not in self.steps or f.get('time', 0) <= self.started or f.get('tid') is None:
            return
        if f.get('side') not in ('A', 'B'):
            return
        before, size = D(f['startPosition']), D(f['sz'])
        if size <= 0:
            return
        signed = size if f['side'] == 'B' else -size
        closing = min(abs(before), size) if before * signed < 0 else D(0)
        if closing:
            self.order(user, f, 'close', closing, before)
        if size > closing:
            if time.time() * 1000 - f['time'] > 60000:
                print('Skipped stale entry', user, coin, f['tid'], flush=True)
                return
            self.order(user, f, 'open', size - closing, before)


def main():
    testnet = os.getenv('HL_TESTNET', '1') == '1'
    base = constants.TESTNET_API_URL if testnet else constants.MAINNET_API_URL
    account = os.environ['HL_ACCOUNT'].lower()
    tracked = set(os.environ['HL_TRACK'].lower().split(','))
    scale = D(os.getenv('HL_SIZE_SCALE', '0.001'))
    cap = D(os.getenv('HL_MAX_POSITION_PCT', '0.05'))
    if scale <= 0 or cap <= 0 or account in tracked:
        raise ValueError('Check scale, position cap, and tracked wallets')
    exchange = Exchange(Account.from_key(os.environ['HL_AGENT_KEY']), base, account_address=account, timeout=10)
    cache = Path(__file__).resolve().parents[1] / '.cache'
    cache.mkdir(exist_ok=True)
    db = sqlite3.connect(cache / f'mirror-{int(testnet)}-{account}.sqlite')
    mirror = Mirror(exchange, account, scale, cap, db)

    subscribed = set()

    def on_open(ws):
        subscribed.clear()
        for addr in tracked:
            ws.send(json.dumps({'method': 'subscribe', 'subscription': {'type': 'userFills', 'user': addr, 'aggregateByTime': True}}))

    def on_message(ws, message):
        event = json.loads(message)
        if event.get('channel') == 'subscriptionResponse':
            subscription = event['data'].get('subscription', {})
            if subscription.get('type') == 'userFills':
                subscribed.add(subscription['user'].lower())
                if subscribed == tracked:
                    print('MIRROR_READY', flush=True)
            return
        if event.get('channel') == 'error':
            print('Subscription error:', event.get('data'), flush=True)
        if event.get('channel') != 'userFills':
            return
        data = event['data']
        user = data['user'].lower()
        if user in tracked:
            for fill in sorted(data['fills'], key=lambda f: f['time']):
                try:
                    mirror.fill(user, fill)
                except Exception as exc:
                    print('Copy error', user, fill.get('tid'), str(exc), flush=True)

    # Recommendations and tracked fills are always mainnet. Orders use the selected network.
    while True:
        ws = websocket.WebSocketApp(constants.MAINNET_API_URL.replace('https://', 'wss://') + '/ws',
                                    on_open=on_open, on_message=on_message,
                                    on_error=lambda _, e: print('Stream error:', e, flush=True))
        ws.run_forever(ping_interval=25, ping_timeout=10)
        print('MIRROR_DISCONNECTED', flush=True)
        time.sleep(3)


if __name__ == '__main__':
    main()
